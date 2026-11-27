import type { Types } from 'mongoose';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { Setting } from '../../models/setting.model.js';
import { billedFields, billedOf, componentsOf, q3, withShares, type CycleLine } from '../sales/billing.js';

/**
 * Migration NON destructive et idempotente du cycle commercial (mission 2). Elle ajoute des compteurs de suivi là où la relation
 * est CERTAINE (champ `invoiceId` d'un BL, proforma convertie) et marque les documents de l'ancien parcours.
 * Elle ne crée ni bon de livraison, ni mouvement de stock, ni facture, ni créance, ne modifie aucun montant et signale ce qui ne
 * peut pas être déterminé.
 */
type Id = Types.ObjectId;
type Doc = { _id: Id; number?: string | null; status: string; lines: CycleLine[]; totals?: { globalDiscountMinor?: number | null; totalHtMinor?: number | null; vatGroups?: never[] } | null };
type Note = Doc & { invoiceId?: Id | null; invoiceIds?: Id[]; source?: { type?: string; id?: Id; number?: string } | null; legacyFlow?: boolean };
type Inv = Doc & { type?: string; origin?: string | null; quotationId?: Id | null; proformaId?: Id | null; deliveryNoteIds?: Id[]; legacyFlow?: boolean };
export interface Mission2Company {
  companyId: string;
  billedDeliveries: number; proformaLinesTracked: number; documentsFlagged: number; quoteNumbersAdded: number;
  legacy: { invoicesFromQuote: string[]; invoicesFromProforma: string[]; invoicesFromDeliveries: string[]; deliveriesFromQuote: string[]; deliveriesFromInvoice: string[] };
  /** À examiner : rien n'est corrigé automatiquement. */
  anomalies: { doubleBilling: string[]; missingLinks: string[]; deliveredMismatches: string[]; billingDifferences: string[]; draftsToReview: string[] };
}
export interface Mission2Report { dryRun: boolean; executedAt: string; companies: Mission2Company[] }

const has = (v: unknown) => v !== undefined && v !== null;
const label = (d: { number?: string | null; _id: Id }) => d.number ?? `brouillon ${d._id}`;

export async function migrateMission2(opts: { dryRun?: boolean } = {}): Promise<Mission2Report> {
  const dryRun = !!opts.dryRun; const report: Mission2Report = { dryRun, executedAt: new Date().toISOString(), companies: [] };
  for (const s of await Setting.find().select('companyId').lean()) report.companies.push(await migrateCompany(s.companyId as Id, dryRun));
  return report;
}

async function migrateCompany(companyId: Id, dryRun: boolean): Promise<Mission2Company> {
  const r: Mission2Company = { companyId: companyId.toString(), billedDeliveries: 0, proformaLinesTracked: 0, documentsFlagged: 0, quoteNumbersAdded: 0,
    legacy: { invoicesFromQuote: [], invoicesFromProforma: [], invoicesFromDeliveries: [], deliveriesFromQuote: [], deliveriesFromInvoice: [] },
    anomalies: { doubleBilling: [], missingLinks: [], deliveredMismatches: [], billingDifferences: [], draftsToReview: [] } };
  // Écritures directes : ni horodatage modifié, ni montant touché
  const set = async (M: { collection: { updateOne: (f: object, u: object) => Promise<unknown> } }, id: Id, fields: Record<string, unknown>) => { if (!dryRun && Object.keys(fields).length) await M.collection.updateOne({ _id: id, companyId }, { $set: fields }); };
  const lineSet = (doc: Doc, changes: Map<string, Record<string, unknown>>) => Object.fromEntries([...changes].flatMap(([id, f]) => { const i = doc.lines.findIndex((l) => String(l._id) === id); return Object.entries(f).map(([k, v]) => [`lines.${i}.${k}`, v]); }));
  const flag = async (M: Parameters<typeof set>[0], d: { _id: Id; legacyFlow?: boolean }) => { if (!d.legacyFlow) { r.documentsFlagged++; await set(M, d._id, { legacyFlow: true }); } };

  const invoices = (await Invoice.find({ companyId }).lean()) as unknown as Inv[];
  const invoiceById = new Map(invoices.map((i) => [String(i._id), i]));
  const notes = (await DeliveryNote.find({ companyId }).sort({ number: 1 }).lean()) as unknown as Note[];

  // 1. Documents de l'ancien parcours
  for (const i of invoices.filter((x) => x.type !== 'credit_note' && !x.origin)) {
    const from = i.deliveryNoteIds?.length ? 'invoicesFromDeliveries' : i.proformaId ? 'invoicesFromProforma' : i.quotationId ? 'invoicesFromQuote' : null;
    if (!from) continue;
    r.legacy[from].push(label(i)); await flag(Invoice, i);
    if (i.status === 'draft') r.anomalies.draftsToReview.push(`Facture brouillon ${i._id} (${from === 'invoicesFromDeliveries' ? 'depuis des BL' : from === 'invoicesFromProforma' ? 'depuis une proforma' : 'depuis un devis'}, ancien parcours) : à valider ou supprimer`);
  }

  // 2. Bons de livraison : facturation connue par `invoiceId`
  const billedByBasis = new Map<string, Map<string, { allocated: number; invoiced: number; invoices: Set<string> }>>();
  for (const d of notes) {
    if (d.source?.type === 'quotation') { r.legacy.deliveriesFromQuote.push(label(d)); await flag(DeliveryNote, d); }
    if (d.source?.type === 'invoice') {
      r.legacy.deliveriesFromInvoice.push(label(d)); await flag(DeliveryNote, d);
      if (d.invoiceId && String(d.invoiceId) !== String(d.source.id)) r.anomalies.doubleBilling.push(`${d.number} : livre la facture ${d.source.number ?? d.source.id} et figure aussi sur la facture ${label(invoiceById.get(String(d.invoiceId)) ?? { _id: d.invoiceId })} (risque de double facturation à vérifier)`);
      continue;
    }
    if (!d.invoiceId) continue;
    const inv = invoiceById.get(String(d.invoiceId));
    if (!inv) { r.anomalies.missingLinks.push(`${d.number} : facture liée introuvable (${d.invoiceId})`); continue; }
    if (inv.origin === 'delivery') continue;
    const done = inv.status === 'validated';
    if (d.lines.some((l) => !has(l.allocatedQty))) {
      r.billedDeliveries++; await flag(DeliveryNote, d);
      await set(DeliveryNote, d._id, { ...lineSet(d, new Map(d.lines.filter((l) => !has(l.allocatedQty)).map((l) => [String(l._id), { allocatedQty: l.quantity, invoicedQty: done ? l.quantity : 0 }]))), invoiceIds: [d.invoiceId] });
    }
    if (d.source?.id && d.source.type === 'proforma' || d.source?.id && d.source.type === 'quotation') {
      const k = `${d.source!.type}:${d.source!.id}`; const m = billedByBasis.get(k) ?? new Map();
      for (const l of d.lines) { if (!l.sourceLineId) { r.anomalies.missingLinks.push(`${d.number} — « ${l.designation} » : ligne source inconnue, suivi non reconstitué`); continue; }
        const v = m.get(String(l.sourceLineId)) ?? { allocated: 0, invoiced: 0, invoices: new Set<string>() }; v.allocated = q3(v.allocated + l.quantity); if (done) v.invoiced = q3(v.invoiced + l.quantity); v.invoices.add(String(inv._id)); m.set(String(l.sourceLineId), v); }
      billedByBasis.set(k, m);
    }
  }

  // 3. Lignes sources : quantités facturées par l'ancien parcours
  for (const [key, lines] of billedByBasis) {
    const [type, id] = key.split(':') as ['proforma' | 'quotation', string];
    const M = (type === 'proforma' ? Proforma : Quotation) as typeof Proforma;
    const doc = (await M.findOne({ _id: id, companyId }).lean()) as unknown as Doc | null;
    if (!doc) { r.anomalies.missingLinks.push(`Document source introuvable (${type} ${id})`); continue; }
    withShares(doc as never);
    const changes = new Map<string, Record<string, unknown>>(); let agreed = 0; const used = new Set<string>();
    for (const [lineId, v] of lines) {
      const l = doc.lines.find((x) => String(x._id) === lineId);
      if (!l) { r.anomalies.missingLinks.push(`${label(doc)} : ligne source ${lineId} introuvable`); continue; }
      const billed = billedOf({ ...l, allocatedQty: undefined, billedAfterMinor: undefined }, v.allocated); agreed += billed.after; v.invoices.forEach((x) => used.add(x));
      if (!has(l.allocatedQty)) { changes.set(lineId, { ...billedFields(billed), invoicedQty: v.invoiced }); r.proformaLinesTracked++; }
    }
    if (changes.size) await set(M, doc._id, lineSet(doc, changes));
    const legacyHt = [...used].map((x) => invoiceById.get(x)!).reduce((t, i) => t + (i.totals?.totalHtMinor ?? 0), 0);
    if (legacyHt !== agreed) r.anomalies.billingDifferences.push(`${type === 'proforma' ? 'Proforma' : 'Devis'} ${label(doc)} : montant HT facturé par l’ancien parcours ${legacyHt}, montant convenu pour ces quantités ${agreed} (écart ${legacyHt - agreed}, en plus petite unité) — aucun montant modifié`);
  }

  // 4. Proformas : conversion directe, numéro du devis, cohérence des quantités livrées
  const proformas = (await Proforma.find({ companyId }).lean()) as unknown as (Doc & { invoiceId?: Id | null; quotationId?: Id | null; quotationNumber?: string; legacyFlow?: boolean })[];
  for (const p of proformas) {
    if (p.quotationId && !p.quotationNumber) { const q = await Quotation.findOne({ _id: p.quotationId, companyId }).select('number').lean(); if (q) { r.quoteNumbersAdded++; await set(Proforma, p._id, { quotationNumber: q.number }); } }
    if (p.status === 'converted') {
      const inv = p.invoiceId ? invoiceById.get(String(p.invoiceId)) : undefined;
      if (!inv) { r.anomalies.missingLinks.push(`Proforma ${p.number} « convertie » sans facture retrouvée`); continue; }
      await flag(Proforma, p); withShares(p as never);
      const changes = new Map(p.lines.filter((l) => !has(l.allocatedQty)).map((l) => [String(l._id), { allocatedQty: l.quantity, invoicedQty: inv.status === 'validated' ? l.quantity : 0, billedAfterMinor: componentsOf(l).after, billedShareMinor: componentsOf(l).share, billedDiscountMinor: componentsOf(l).discount }]));
      r.proformaLinesTracked += changes.size; await set(Proforma, p._id, lineSet(p, changes));
    }
  }
  for (const [type, M] of [['proforma', Proforma], ['quotation', Quotation], ['invoice', Invoice]] as const) {
    for (const id of new Set(notes.filter((d) => d.source?.type === type && d.source.id).map((d) => String(d.source!.id)))) {
      const doc = (await (M as typeof Proforma).findOne({ _id: id, companyId }).lean()) as unknown as Doc | null; if (!doc) continue;
      for (const l of doc.lines) {
        const computed = q3(notes.filter((d) => d.status === 'validated' && String(d.source?.id) === id).flatMap((d) => d.lines).filter((x) => String(x.sourceLineId) === String(l._id)).reduce((t, x) => t + x.quantity - (x.returnedQty ?? 0), 0));
        if (Math.abs(computed - (l.deliveredQty ?? 0)) > 1e-6) r.anomalies.deliveredMismatches.push(`${label(doc)} — « ${l.designation} » : livré enregistré ${l.deliveredQty ?? 0}, d’après les BL validés ${computed}`);
      }
    }
  }
  return r;
}
