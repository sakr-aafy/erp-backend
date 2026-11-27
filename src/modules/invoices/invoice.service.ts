import { ensureFinanceCounters } from '../../services/accounting.service.js';
import { TreasuryAccount } from '../../models/finance.model.js';
import { Types, type ClientSession, type QueryFilter } from 'mongoose';
import { Customer } from '../../models/customer.model.js';
import { DeliveryNote, Invoice, Payment, Proforma, Quotation, type InvoiceDoc } from '../../models/sales.model.js';
import { record as recordQuotationEvent, type Actor } from '../quotations/quotation.activity.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { computeDocument, groupKey, type DocTotals, pctOf, proportion, type CalcLine, type VatRegime } from '../../services/calculation.service.js';
import { assertCanSell } from '../customers/customer.service.js';
import { buildDocument, discountsOf, frozenOf, inheritFrom, legacyDiscountOf, linesToInput, type BuiltLine, type DocInput, type Inherited, type LineInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import { assertQuantities, carriedOver } from '../products/units.js';

type Id = Types.ObjectId;
type Lean = InvoiceDoc & { _id: Id; createdAt?: Date };
const DAY = 86400000;

export function toDto(i: Lean) {
  const payable = i.totals.totalPayableMinor ?? 0;
  const balanceDue = i.status === 'validated' && i.type === 'invoice' ? Math.max(0, payable - (i.paidMinor ?? 0) - (i.creditedMinor ?? 0)) : 0;
  const today = startOfDay(new Date());
  const open = (s: { amountMinor?: number | null; paidMinor?: number | null; creditedMinor?: number | null }) => Math.max(0, (s.amountMinor ?? 0) - (s.paidMinor ?? 0) - (s.creditedMinor ?? 0));
  const overdue = balanceDue > 0 && i.schedule.some((s) => s.dueDate < today && open(s) > 0);
  return {
    id: i._id.toString(), paymentTerms: i.paymentTerms ?? null, paymentTermsCustom: !!i.paymentTermsCustom, deliveryAddress: snapshotDto(i.deliveryAddress as never), type: i.type, number: i.number ?? null, status: i.status, customerId: i.customerId.toString(), customer: i.customerSnapshot, issueDate: i.issueDate,
    lines: i.lines.map((l) => ({ ...l, id: (l as { _id: Id })._id.toString() })), globalDiscountPct: i.globalDiscountPct, syncDiscountPct: i.syncDiscountPct ?? 0, globalDiscountMinor: i.globalDiscountMinor,
    withholdingOperationType: i.withholdingOperationType ?? null, withholding: i.withholding ?? null, stamp: i.stamp ?? null, totals: i.totals, notes: i.notes ?? null,
    paymentMethod: i.paymentMethod ?? null, schedule: i.schedule.map((s) => ({ id: (s as { _id: Id })._id.toString(), dueDate: s.dueDate, percent: s.percent ?? null, amountMinor: s.amountMinor, paidMinor: s.paidMinor, creditedMinor: s.creditedMinor ?? 0, openMinor: open(s) })),
    /** Excédent : encaissé + crédité au-delà du montant de la facture (créance du client, à rembourser ou imputer). */
    overpaidMinor: i.status === 'validated' && i.type === 'invoice' ? Math.max(0, (i.paidMinor ?? 0) + (i.creditedMinor ?? 0) - payable) : 0,
    paidMinor: i.paidMinor ?? 0, creditedMinor: i.creditedMinor ?? 0, balanceDueMinor: balanceDue, paymentStatus: i.paymentStatus, overdue,
    creditedInvoiceId: i.creditedInvoiceId?.toString() ?? null, creditReason: i.creditReason ?? null,
    quotationId: i.quotationId?.toString() ?? null, proformaId: i.proformaId?.toString() ?? null, deliveryNoteIds: (i.deliveryNoteIds ?? []).map((d) => d.toString()),
    validatedAt: i.validatedAt ?? null, sentAt: i.sentAt ?? null, createdAt: i.createdAt, editable: i.status === 'draft',
  };
}

export async function list(companyId: Id, f: { q?: string | undefined; type?: string | undefined; status?: string | undefined; paymentStatus?: string | undefined; customerId?: string | undefined;
  from?: Date | undefined; to?: Date | undefined; overdue?: boolean | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: QueryFilter<InvoiceDoc> = { companyId };
  if (f.type) filter.type = f.type as never; if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  if (f.paymentStatus) filter.paymentStatus = f.paymentStatus as never;
  if (f.overdue) { filter.status = 'validated'; filter.type = 'invoice'; filter.paymentStatus = { $ne: 'paid' } as never; filter['schedule.dueDate'] = { $lt: startOfDay(new Date()) } as never; }
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }]; }
  const sort = buildSort(f.sort, ['number', 'issueDate', 'createdAt'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Invoice.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Invoice.countDocuments(filter)]);
  return { items: items.map((i) => ({ ...toDto({ ...i, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const i = await Invoice.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!i) throw AppError.notFound('Facture introuvable');
  return i as Lean;
}
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

export interface InvoiceBody extends DocInput { issueDate?: Date | undefined; paymentMethod?: string | undefined; schedule?: { dueDate: Date; percent: number }[] | undefined; notes?: string | undefined }
export interface Sources { quotationId?: Id; proformaId?: Id; deliveryNoteIds?: Id[]; type?: 'invoice' | 'credit_note'; creditedInvoiceId?: Id; creditReason?: string; lineDeliveredFull?: boolean; inherit?: Inherited | undefined }

/** Crée une facture BROUILLON (sans numéro). Utilisable seule (transaction propre) ou dans une transaction existante. */
export async function createDraft(companyId: Id, userId: Id, b: InvoiceBody, sources: Sources = {}, outer?: ClientSession) {
  const run = async (session: ClientSession) => {
    const issueDate = startOfDay(b.issueDate ?? new Date());
    const docType = sources.type === 'credit_note' ? 'creditNote' : 'invoice';
    const converted = !!(sources.quotationId || sources.proformaId || sources.deliveryNoteIds);
    const doc = await buildDocument(companyId, docType, b, { date: issueDate, session, preserveQuantities: converted, ...(sources.inherit && { inherit: sources.inherit }) });
    if (sources.lineDeliveredFull) doc.lines.forEach((l) => { l.deliveredQty = l.quantity; });
    const [c] = await Invoice.create([{ companyId, type: sources.type ?? 'invoice', status: 'draft', customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, paymentMethod: b.paymentMethod,
      schedule: (b.schedule ?? []).map((s) => ({ dueDate: startOfDay(s.dueDate), percent: s.percent })), lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor,
      withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp, totals: doc.totals, notes: b.notes, ...frozenOf(doc), createdBy: userId,
      ...(sources.quotationId && { quotationId: sources.quotationId }), ...(sources.proformaId && { proformaId: sources.proformaId }), ...(sources.deliveryNoteIds && { deliveryNoteIds: sources.deliveryNoteIds }),
      ...(sources.creditedInvoiceId && { creditedInvoiceId: sources.creditedInvoiceId, creditReason: sources.creditReason }) }] as never[], { session });
    return toDto(c!.toObject() as Lean);
  };
  return outer ? run(outer) : withTransaction(run);
}

export async function updateDraft(companyId: Id, id: string, b: InvoiceBody) {
  const cur = await getOwn(companyId, id);
  if (cur.status !== 'draft') throw AppError.conflict('Facture validée : non modifiable. Corrigez-la par une facture d’avoir.');
  if (cur.type === 'credit_note') throw AppError.conflict('Un avoir en brouillon ne se modifie pas : supprimez-le et recréez-le');
  const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
  return withTransaction(async (session) => {
    const inherit = inheritFrom(cur, b.customerId);
    // Facture issue de BL : les quantités livrées (inchangées) sont conservées même si elles datent d'avant les règles d'unités
    const fromDeliveries = (cur.deliveryNoteIds ?? []).length > 0 && b.lines.every((l) => cur.lines.some((c) => String(c.productId ?? '') === (l.productId ?? '') && c.quantity === l.quantity));
    const doc = await buildDocument(companyId, 'invoice', { ...b, ...legacyDiscountOf(cur, b) }, { date: issueDate, session, preserveQuantities: fromDeliveries, ...(inherit && { inherit }) });
    if ((cur.deliveryNoteIds ?? []).length) { // facture issue de BL : les lignes livrées restent liées
      doc.lines.forEach((l) => { l.deliveredQty = l.quantity; });
    }
    const u = await Invoice.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, paymentMethod: b.paymentMethod,
      schedule: (b.schedule ?? []).map((s) => ({ dueDate: startOfDay(s.dueDate), percent: s.percent })), lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor,
      withholdingOperationType: doc.withholdingOperationType ?? null, withholding: doc.withholding ?? null, stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, ...frozenOf(doc) } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La facture a changé entre-temps');
    return toDto(u as Lean);
  });
}

/** Suppression : brouillons uniquement. Libère les documents sources (BL, devis, proforma). */
export async function removeDraft(companyId: Id, id: string, actor: Actor = {}) {
  return withTransaction(async (session) => {
    const inv = await getOwn(companyId, id, session);
    if (inv.status !== 'draft') throw AppError.conflict('Une facture validée ne peut pas être supprimée : émettez une facture d’avoir.');
    await Invoice.deleteOne({ _id: id, companyId, status: 'draft' }, { session });
    if ((inv.deliveryNoteIds ?? []).length) await DeliveryNote.updateMany({ companyId, _id: { $in: inv.deliveryNoteIds } }, { $unset: { invoiceId: 1 } }, { session });
    if (inv.quotationId) {
      const freed = await Quotation.updateOne({ _id: inv.quotationId, companyId, invoiceId: inv._id }, { $unset: { invoiceId: 1 } }, { session });
      if (freed.modifiedCount) await recordQuotationEvent(companyId, inv.quotationId, [{ kind: 'invoice_unlinked', description: 'La facture brouillon issue de ce devis a été supprimée', eventKey: `unlinked:${inv._id}` }], actor, session);
    }
    if (inv.proformaId) await Proforma.updateOne({ _id: inv.proformaId, invoiceId: inv._id }, { status: 'pending', $unset: { invoiceId: 1 } }, { session });
    return inv;
  });
}

/** Facture depuis un ou plusieurs BL validés du même client, non encore facturés. */
export async function createFromDeliveryNotes(companyId: Id, userId: Id, ids: string[], issueDate?: Date) {
  return withTransaction(async (session) => {
    const bls = await DeliveryNote.find({ _id: { $in: ids }, companyId }).session(session).lean();
    if (bls.length !== new Set(ids).size) throw AppError.badRequest('Bon de livraison introuvable');
    if (new Set(bls.map((b) => b.customerId.toString())).size !== 1) throw AppError.badRequest('Tous les bons de livraison doivent concerner le même client');
    for (const b of bls) {
      if (b.status !== 'validated') throw AppError.conflict(`BL ${b.number} : seuls les BL validés sont facturables`);
      if (b.invoiceId) throw AppError.conflict(`BL ${b.number} : déjà facturé`);
    }
    const lines: LineInput[] = bls.flatMap((b) => linesToInput(b.lines));
    const inv = await createDraft(companyId, userId, { customerId: bls[0]!.customerId, lines, ...(issueDate && { issueDate }), notes: `BL : ${bls.map((b) => b.number).join(', ')}` },
      { deliveryNoteIds: bls.map((b) => b._id), lineDeliveredFull: true, inherit: await inheritFromDeliveries(companyId, bls, session) }, session);
    const r = await DeliveryNote.updateMany({ _id: { $in: bls.map((b) => b._id) }, invoiceId: { $exists: false } }, { invoiceId: new Types.ObjectId(inv.id) }, { session }); // garde de concurrence
    if (r.modifiedCount !== bls.length) throw AppError.conflict('Un bon de livraison vient d’être facturé par ailleurs');
    return inv;
  });
}

/**
 * Facture issue de bons de livraison : adresse commune aux BL (aucune s'ils diffèrent) et, lorsqu'ils proviennent tous
 * du même devis / proforma, conditions de paiement de ce document source (sinon celles du client).
 */
async function inheritFromDeliveries(companyId: Id, bls: { deliveryAddress?: unknown; source?: { type?: string | null; id?: Id | null } | null }[], session: ClientSession): Promise<Inherited> {
  const keys = new Set(bls.map((b) => JSON.stringify(b.deliveryAddress)));
  const out: Inherited = { deliveryAddress: keys.size === 1 ? bls[0]!.deliveryAddress : null };
  const sources = new Set(bls.map((b) => (b.source?.id ? `${b.source.type}:${b.source.id}` : '')));
  const src = bls[0]!.source;
  if (sources.size === 1 && src?.id && (src.type === 'quotation' || src.type === 'proforma')) {
    const d = await (src.type === 'quotation' ? Quotation : Proforma as unknown as typeof Quotation).findOne({ _id: src.id, companyId }).session(session).lean();
    if (d) Object.assign(out, { paymentTerms: d.paymentTerms, paymentTermsCustom: d.paymentTermsCustom });
  }
  return out;
}

/** Avoir (brouillon) depuis une facture validée : total (quantités restantes) ou partiel par ligne ; montants proportionnels. */
export async function createCreditNote(companyId: Id, userId: Id, invoiceId: string, b: { reason: string; lines?: { sourceLineId: string; quantity: number }[] | undefined }) {
  return withTransaction(async (session) => {
    const inv = await getOwn(companyId, invoiceId, session);
    if (inv.type !== 'invoice' || inv.status !== 'validated') throw AppError.conflict('Un avoir ne peut être émis que sur une facture validée');
    const credited = await creditedQuantities(companyId, inv._id, session);
    const wanted = b.lines ?? inv.lines.map((l) => ({ sourceLineId: (l as { _id: Id })._id.toString(), quantity: l.quantity - (credited.get((l as { _id: Id })._id.toString()) ?? 0) })).filter((x) => x.quantity > 1e-9);
    if (!wanted.length) throw AppError.conflict('Cette facture est déjà intégralement créditée');
    await assertQuantities(companyId, wanted.map((w) => { const ol = inv.lines.find((x) => String((x as { _id: Id })._id) === w.sourceLineId); return { productId: ol?.productId, unit: ol?.unit, quantity: w.quantity, label: ol ? `« ${ol.designation} »` : undefined, exempt: !!ol && carriedOver(w.quantity, ol.quantity, ol.quantity - (credited.get(w.sourceLineId) ?? 0)) }; }), session);
    const doc = await buildCreditDocument(companyId, inv, wanted, session);
    const [c] = await Invoice.create([{ companyId, type: 'credit_note', status: 'draft', customerId: inv.customerId, customerSnapshot: inv.customerSnapshot, issueDate: startOfDay(new Date()), lines: doc.lines, withholdingOperationType: inv.withholdingOperationType,
      deliveryAddress: inv.deliveryAddress, paymentTerms: inv.paymentTerms, paymentTermsCustom: inv.paymentTermsCustom, withholding: doc.withholding, totals: doc.totals, notes: `Avoir sur facture ${inv.number}`, createdBy: userId, creditedInvoiceId: inv._id, creditReason: b.reason }] as never[], { session });
    return toDto(c!.toObject() as Lean);
  });
}
type CreditRequest = { sourceLineId: string; quantity: number };
/**
 * Construit un avoir PROPORTIONNEL à la facture d'origine (remise globale en % ou en montant comprise) :
 * montant d'une ligne = net après remise globale × quantité créditée / quantité facturée ; la dernière fraction d'une ligne
 * emporte le reliquat (somme des avoirs = facture, au millime). TVA par groupe et retenue : même mécanique (reliquat sur le dernier avoir
 * qui solde le groupe / la facture). Les quantités et montants déjà crédités par des avoirs VALIDÉS (hors celui-ci) sont déduits.
 */
async function buildCreditDocument(companyId: Id, orig: Lean, requested: CreditRequest[], session: ClientSession, excludeId?: Id) {
  const prev = await Invoice.find({ companyId, creditedInvoiceId: orig._id, type: 'credit_note', status: 'validated', ...(excludeId && { _id: { $ne: excludeId } }) }).session(session).lean();
  const prevQty = new Map<string, number>(); const prevNet = new Map<string, number>(); const prevVat = new Map<string, { base: number; vat: number }>(); let prevWithholding = 0;
  for (const n of prev) {
    for (const l of n.lines) if (l.sourceLineId) { const k = l.sourceLineId.toString(); prevQty.set(k, (prevQty.get(k) ?? 0) + l.quantity); prevNet.set(k, (prevNet.get(k) ?? 0) + (l.netHtMinor ?? 0)); }
    for (const g of n.totals.vatGroups) { const k = groupKey(g.vatCode!, g.regime!, g.ratePct ?? 0); const a = prevVat.get(k) ?? { base: 0, vat: 0 }; a.base += g.baseMinor ?? 0; a.vat += g.vatMinor ?? 0; prevVat.set(k, a); }
    prevWithholding += n.totals.withholdingMinor ?? 0;
  }
  const req = new Map<string, number>(); for (const r of requested) req.set(r.sourceLineId, (req.get(r.sourceLineId) ?? 0) + r.quantity);
  const lines: BuiltLine[] = []; const calc: CalcLine[] = [];
  for (const [lineId, qty] of req) {
    const o = orig.lines.find((x) => (x as { _id: Id })._id.toString() === lineId);
    if (!o) throw AppError.badRequest('Ligne de facture inconnue');
    const remaining = o.quantity - (prevQty.get(lineId) ?? 0);
    if (qty > remaining + 1e-9) throw AppError.conflict(`Ligne « ${o.designation} » : quantité créditable restante ${remaining}`);
    const origNet = (o.netHtMinor ?? 0) - (o.globalShareMinor ?? 0); // net après toutes les remises
    const left = origNet - (prevNet.get(lineId) ?? 0);
    const net = qty >= remaining - 1e-9 ? left : Math.min(left, proportion(origNet, qty, o.quantity));
    const vat = { ruleId: o.vat.ruleId!, code: o.vat.code!, regime: o.vat.regime as VatRegime, ratePct: o.vat.ratePct ?? 0 };
    calc.push({ quantity: qty, unitPriceMinor: o.unitPriceMinor, discountPct: 0, vatCode: vat.code, vatRegime: vat.regime, vatRatePct: vat.ratePct, netHtOverrideMinor: net });
    lines.push({ ...(o.productId && { productId: o.productId }), reference: o.reference ?? undefined, designation: o.designation, description: o.description ?? undefined, unit: o.unit ?? undefined, kind: (o.kind as 'product' | 'service') ?? 'product',
      quantity: qty, unitPriceMinor: o.unitPriceMinor, discountPct: o.discountPct ?? 0, vat, grossMinor: 0, discountMinor: 0, netHtMinor: net, globalShareMinor: 0, deliveredQty: 0, sourceLineId: lineId });
  }
  const base = computeDocument({ lines: calc }); // bases par groupe de TVA
  // TVA : le groupe entièrement crédité reprend exactement la TVA d'origine moins celle déjà créditée
  const vatOverrides: Record<string, number> = {};
  for (const g of base.totals.vatGroups) {
    const k = groupKey(g.vatCode, g.regime, g.ratePct); const og = orig.totals.vatGroups.find((x) => groupKey(x.vatCode!, x.regime!, x.ratePct ?? 0) === k); const p = prevVat.get(k) ?? { base: 0, vat: 0 };
    if (og && p.base + g.baseMinor === (og.baseMinor ?? 0)) vatOverrides[k] = (og.vatMinor ?? 0) - p.vat;
  }
  // Retenue : mêmes taux/base que la facture (instantané), reliquat si l'avoir solde toute la facture
  const completes = orig.lines.every((o) => { const id = (o as { _id: Id })._id.toString(); return (prevQty.get(id) ?? 0) + (req.get(id) ?? 0) >= o.quantity - 1e-9; });
  const w = orig.withholding?.ratePct != null ? { ratePct: orig.withholding.ratePct, base: (orig.withholding.base as 'ht' | 'ttc') ?? 'ttc' } : null;
  let result = computeDocument({ lines: calc, vatOverrides, ...(w && { withholding: w }) });
  if (w && completes) result = computeDocument({ lines: calc, vatOverrides, withholding: { ...w, amountOverrideMinor: Math.max(0, (orig.totals.withholdingMinor ?? 0) - prevWithholding) } });
  result.lines.forEach((r, i) => { lines[i]!.grossMinor = r.grossMinor; lines[i]!.discountMinor = r.discountMinor; });
  const withholding = w ? { ruleId: orig.withholding!.ruleId!, code: orig.withholding!.code!, ratePct: w.ratePct, base: w.base, amountMinor: result.totals.withholdingMinor } : undefined;
  if (result.totals.totalPayableMinor + prev.reduce((a, n) => a + (n.totals.totalPayableMinor ?? 0), 0) > (orig.totals.totalPayableMinor ?? 0)) throw AppError.conflict('L’avoir dépasserait le montant de la facture d’origine');
  return { lines, totals: result.totals, withholding };
}

async function creditedQuantities(companyId: Id, invoiceId: Id, session?: ClientSession) {
  const notes = await Invoice.find({ companyId, creditedInvoiceId: invoiceId, type: 'credit_note', status: 'validated' }).session(session ?? null).lean();
  const m = new Map<string, number>();
  for (const n of notes) for (const l of n.lines) if (l.sourceLineId) m.set(l.sourceLineId.toString(), (m.get(l.sourceLineId.toString()) ?? 0) + l.quantity);
  return m;
}

/**
 * VALIDATION (acte fiscal, transaction unique) : recalcul des montants avec les règles fiscales validées à la date de la facture,
 * contrôle de la limite de crédit, attribution du numéro légal séquentiel, échéancier, mise à jour du solde client.
 * Après validation le document est IMMUABLE.
 */
export async function validate(companyId: Id, userId: Id, id: string) {
  await ensureFinanceCounters(companyId);
  const pre = await getOwn(companyId, id); // le compteur doit exister avant la transaction (instantané)
  await ensureCounter(companyId, pre.type === 'credit_note' ? 'creditNote' : 'invoice', startOfDay(pre.issueDate));
  return withTransaction(async (session) => {
    const inv = await getOwn(companyId, id, session);
    if (inv.status !== 'draft') throw AppError.conflict('Facture déjà validée');
    const isCredit = inv.type === 'credit_note';
    const issueDate = startOfDay(inv.issueDate);
    if (issueDate > startOfDay(new Date())) throw AppError.conflict('La date de la facture ne peut pas être dans le futur');
    const last = await Invoice.findOne({ companyId, type: inv.type, status: 'validated' }).sort({ validatedAt: -1 }).session(session).lean();
    if (last && issueDate < startOfDay(last.issueDate)) throw AppError.conflict(`Date antérieure à celle de la dernière ${isCredit ? 'facture d’avoir' : 'facture'} validée (${last.number}) : la chronologie doit suivre la numérotation`);

    let doc: { customer?: { paymentDelayDays?: number | null | undefined }; customerSnapshot?: unknown; lines: BuiltLine[]; totals: DocTotals; withholding?: unknown; stamp?: unknown };
    if (isCredit) {
      // Recalcul de l'avoir sur l'état ACTUEL des avoirs déjà validés (contrôle des quantités et des montants disponibles)
      const orig = await getOwn(companyId, inv.creditedInvoiceId!.toString(), session);
      const built = await buildCreditDocument(companyId, orig, inv.lines.map((l) => ({ sourceLineId: l.sourceLineId!.toString(), quantity: l.quantity })), session, inv._id);
      doc = { ...built, customerSnapshot: inv.customerSnapshot };
    } else {
      const input: DocInput = { customerId: inv.customerId, lines: linesToInput(inv.lines, false, 'keep'), ...discountsOf(inv), withholdingOperationType: inv.withholdingOperationType };
      const built = await buildDocument(companyId, 'invoice', input, { date: issueDate, session, preserveQuantities: true });
      built.lines.forEach((l, i) => { l.deliveredQty = inv.lines[i]!.deliveredQty ?? 0; });
      // Brouillon antérieur aux adresses multiples : l'adresse de livraison qu'il portait est conservée
      const legacy = inv.deliveryAddress === undefined ? (inv.customerSnapshot as { shippingAddress?: unknown }).shippingAddress : undefined;
      doc = { ...built, customerSnapshot: { ...built.customerSnapshot, ...(legacy ? { shippingAddress: legacy } : {}) } };
    }
    const payable = doc.totals.totalPayableMinor;

    // Conditions libres : les échéances sont fixées par l'utilisateur, aucune date n'est déduite du texte ni inventée
    if (!isCredit && payable > 0 && inv.paymentTermsCustom && !inv.schedule.length) {
      throw new AppError(409, 'Conditions de paiement personnalisées : saisissez l’échéancier réel de la facture avant de la valider', 'PAYMENT_SCHEDULE_REQUIRED');
    }

    if (!isCredit) {
      await assertCanSell(companyId, inv.customerId, payable, session); // module 01 : limite de crédit / client archivé
    }

    const number = await nextDocumentNumber(companyId, isCredit ? 'creditNote' : 'invoice', session, issueDate);
    const schedule = isCredit || payable === 0 ? [] : buildSchedule(inv, payable, issueDate, (doc.customer?.paymentDelayDays ?? 0));
    const u = await Invoice.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { status: 'validated', number, validatedAt: new Date(), validatedBy: userId, issueDate, lines: doc.lines, withholding: doc.withholding ?? null,
      stamp: doc.stamp ?? null, totals: doc.totals, customerSnapshot: doc.customerSnapshot, schedule, paymentStatus: isCredit || payable === 0 ? 'paid' : 'unpaid' } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La facture a changé entre-temps');

    // Le solde client n'évolue QUE sur opération validée
    await Customer.updateOne({ _id: inv.customerId, companyId }, { $inc: { balanceMinor: isCredit ? -payable : payable } }, { session });
    if (isCredit) {
      const orig = await Invoice.findOneAndUpdate({ _id: inv.creditedInvoiceId, companyId }, { $inc: { creditedMinor: payable } }, { returnDocument: 'after', session }).lean();
      await Invoice.updateOne({ _id: orig!._id }, { paymentStatus: statusOf(orig as Lean) }, { session });
      // Imputation sur les échéances : les plus lointaines d'abord ; l'excédent éventuel (déjà encaissé) reste une créance client
      let left = payable;
      for (const sc of [...orig!.schedule].sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())) {
        const open = (sc.amountMinor ?? 0) - (sc.paidMinor ?? 0) - (sc.creditedMinor ?? 0); if (open <= 0 || left <= 0) continue;
        const take = Math.min(open, left); left -= take;
        await Invoice.updateOne({ _id: orig!._id, 'schedule._id': (sc as { _id: Id })._id }, { $inc: { 'schedule.$.creditedMinor': take } }, { session });
      }
    }
    await emitDomainEvent(isCredit ? 'creditNote.validated' : 'invoice.validated', { companyId, documentId: inv._id, session, userId });
    return toDto(u as Lean);
  });
}

function buildSchedule(inv: Lean, payable: number, issueDate: Date, delayDays: number) {
  const plan = inv.schedule.length ? inv.schedule.map((s) => ({ dueDate: s.dueDate, percent: s.percent ?? 0 })) : [{ dueDate: new Date(issueDate.getTime() + delayDays * DAY), percent: 100 }];
  let allocated = 0;
  return plan.map((s, i) => { const amount = i === plan.length - 1 ? payable - allocated : pctOf(payable, s.percent); allocated += amount; return { dueDate: s.dueDate, percent: s.percent, amountMinor: amount, paidMinor: 0 }; });
}
const statusOf = (i: { totals: { totalPayableMinor?: number | null }; paidMinor?: number | null; creditedMinor?: number | null }): 'unpaid' | 'partial' | 'paid' => {
  const due = (i.totals.totalPayableMinor ?? 0) - (i.paidMinor ?? 0) - (i.creditedMinor ?? 0);
  return due <= 0 ? 'paid' : (i.paidMinor ?? 0) + (i.creditedMinor ?? 0) > 0 ? 'partial' : 'unpaid';
};

// ---- Encaissements ----
export async function recordPayment(companyId: Id, userId: Id, invoiceId: string, p: { amountMinor: number; method: string; paidAt?: Date | undefined; reference?: string | undefined; note?: string | undefined; treasuryAccountId?: string | undefined }) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const inv = await getOwn(companyId, invoiceId, session);
    // Trésorerie : dès que la société gère des comptes, l'encaissement doit être rattaché à l'un d'eux
    if (!p.treasuryAccountId && await TreasuryAccount.exists({ companyId, isActive: true }).session(session)) throw AppError.badRequest('Compte de trésorerie (banque ou caisse) requis pour l’encaissement');
    if (p.treasuryAccountId && !(await TreasuryAccount.exists({ _id: p.treasuryAccountId, companyId, isActive: true }).session(session))) throw AppError.badRequest('Compte de trésorerie introuvable ou inactif');
    if (inv.status !== 'validated' || inv.type !== 'invoice') throw AppError.conflict('Les encaissements ne concernent que les factures validées');
    const due = toDto(inv).balanceDueMinor;
    if (p.amountMinor > due) throw AppError.conflict(`Montant supérieur au reste à payer (${due})`);
    // Répartition sur les échéances, de la plus ancienne à la plus récente
    let left = p.amountMinor; const allocations: { scheduleId: Id; amountMinor: number }[] = [];
    const sched = [...inv.schedule].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const s of sched) { const open = (s.amountMinor ?? 0) - (s.paidMinor ?? 0) - (s.creditedMinor ?? 0); if (open <= 0 || left <= 0) continue; const a = Math.min(open, left); allocations.push({ scheduleId: (s as { _id: Id })._id, amountMinor: a }); left -= a; }
    const [pay] = await Payment.create([{ companyId, invoiceId: inv._id, customerId: inv.customerId, amountMinor: p.amountMinor, method: p.method, paidAt: startOfDay(p.paidAt ?? new Date()), reference: p.reference, note: p.note, treasuryAccountId: p.treasuryAccountId, allocations, createdBy: userId }] as never[], { session });
    // Garde de concurrence : la mise à jour n'a lieu que si le reste à payer le permet encore
    const upd = await Invoice.findOneAndUpdate({ _id: inv._id, companyId, status: 'validated', paidMinor: inv.paidMinor ?? 0 }, { $inc: { paidMinor: p.amountMinor } }, { returnDocument: 'after', session }).lean();
    if (!upd) throw AppError.conflict('Un autre encaissement vient d’être enregistré : réessayez');
    for (const a of allocations) await Invoice.updateOne({ _id: inv._id, 'schedule._id': a.scheduleId }, { $inc: { 'schedule.$.paidMinor': a.amountMinor } }, { session });
    await Invoice.updateOne({ _id: inv._id }, { paymentStatus: statusOf(upd as Lean) }, { session });
    await Customer.updateOne({ _id: inv.customerId, companyId }, { $inc: { balanceMinor: -p.amountMinor } }, { session });
    await emitDomainEvent('payment.recorded', { companyId, documentId: pay!._id, session, userId, payload: { invoiceId: inv._id, amountMinor: p.amountMinor, method: p.method } });
    return { payment: paymentDto(pay!.toObject()), invoice: toDto((await Invoice.findById(inv._id).session(session).lean()) as Lean) };
  });
}
/** Annulation d'un encaissement (erreur de saisie) : écriture d'annulation, rien n'est supprimé. */
export async function cancelPayment(companyId: Id, userId: Id, paymentId: string, reason: string) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const pay = await Payment.findOneAndUpdate({ _id: paymentId, companyId, status: 'active' }, { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!pay) throw AppError.conflict('Encaissement introuvable ou déjà annulé');
    const upd = await Invoice.findOneAndUpdate({ _id: pay.invoiceId, companyId }, { $inc: { paidMinor: -pay.amountMinor } }, { returnDocument: 'after', session }).lean();
    for (const a of pay.allocations) await Invoice.updateOne({ _id: pay.invoiceId, 'schedule._id': a.scheduleId }, { $inc: { 'schedule.$.paidMinor': -(a.amountMinor ?? 0) } }, { session });
    await Invoice.updateOne({ _id: pay.invoiceId }, { paymentStatus: statusOf(upd as Lean) }, { session });
    await Customer.updateOne({ _id: pay.customerId, companyId }, { $inc: { balanceMinor: pay.amountMinor } }, { session });
    await emitDomainEvent('payment.cancelled', { companyId, documentId: pay._id, session, userId });
    return paymentDto(pay);
  });
}
export const paymentDto = (p: { _id: Id; invoiceId: Id; customerId: Id; amountMinor: number; method: string; paidAt: Date; reference?: string | null | undefined; note?: string | null | undefined; status: string; cancelReason?: string | null | undefined; createdAt?: Date }) => ({
  id: p._id.toString(), invoiceId: p.invoiceId.toString(), customerId: p.customerId.toString(), amountMinor: p.amountMinor, method: p.method, paidAt: p.paidAt, reference: p.reference ?? null, note: p.note ?? null,
  status: p.status, cancelReason: p.cancelReason ?? null, createdAt: p.createdAt,
});
export async function listPayments(companyId: Id, f: { invoiceId?: string | undefined; customerId?: string | undefined; status?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId };
  if (f.invoiceId) filter.invoiceId = f.invoiceId; if (f.customerId) filter.customerId = f.customerId; if (f.status) filter.status = f.status;
  const r = rangeFilter(f.from, f.to); if (r) filter.paidAt = r;
  const [items, total] = await Promise.all([Payment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Payment.countDocuments(filter)]);
  return { items: items.map(paymentDto), total, page: f.page, limit: f.limit };
}

/** Synthèse de la période : chiffre d'affaires, TVA collectée, impayés (factures validées moins avoirs validés). */
export async function summary(companyId: Id, from?: Date, to?: Date) {
  const range = rangeFilter(from, to);
  const rows = await Invoice.aggregate<{ _id: string; ht: number; vat: number; ttc: number; payable: number; count: number }>([
    { $match: { companyId, status: 'validated', ...(range && { issueDate: range }) } },
    { $group: { _id: '$type', ht: { $sum: '$totals.totalHtMinor' }, vat: { $sum: '$totals.totalVatMinor' }, ttc: { $sum: '$totals.totalTtcMinor' }, payable: { $sum: '$totals.totalPayableMinor' }, count: { $sum: 1 } } },
  ]);
  const inv = rows.find((r) => r._id === 'invoice') ?? { ht: 0, vat: 0, ttc: 0, payable: 0, count: 0 };
  const cn = rows.find((r) => r._id === 'credit_note') ?? { ht: 0, vat: 0, ttc: 0, payable: 0, count: 0 };
  const unpaid = await Invoice.aggregate<{ due: number }>([{ $match: { companyId, status: 'validated', type: 'invoice', paymentStatus: { $ne: 'paid' } } },
    { $group: { _id: null, due: { $sum: { $max: [0, { $subtract: [{ $subtract: ['$totals.totalPayableMinor', '$paidMinor'] }, '$creditedMinor'] }] } } } }]);
  return { invoiceCount: inv.count, creditNoteCount: cn.count, revenueHtMinor: inv.ht - cn.ht, vatCollectedMinor: inv.vat - cn.vat, revenueTtcMinor: inv.ttc - cn.ttc, unpaidMinor: unpaid[0]?.due ?? 0 };
}

/**
 * Contrôle de cohérence du solde d'un client : solde enregistré = Σ factures validées − Σ encaissements actifs − Σ avoirs validés.
 * Détecte toute double comptabilisation ou écart (endpoint de vérification, utilisé par les tests de non-régression).
 */
export async function customerBalanceCheck(companyId: Id, customerId: string) {
  const c = await Customer.findOne({ _id: customerId, companyId }).lean();
  if (!c) throw AppError.notFound('Client introuvable');
  const rows = await Invoice.aggregate<{ _id: string; payable: number }>([{ $match: { companyId, customerId: c._id, status: 'validated' } }, { $group: { _id: '$type', payable: { $sum: '$totals.totalPayableMinor' } } }]);
  const pay = await Payment.aggregate<{ t: number }>([{ $match: { companyId, customerId: c._id, status: 'active' } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]);
  const invoices = rows.find((r) => r._id === 'invoice')?.payable ?? 0; const credits = rows.find((r) => r._id === 'credit_note')?.payable ?? 0; const payments = pay[0]?.t ?? 0;
  const computed = invoices - credits - payments;
  return { storedMinor: c.balanceMinor ?? 0, computedMinor: computed, consistent: (c.balanceMinor ?? 0) === computed, invoicesMinor: invoices, creditNotesMinor: credits, paymentsMinor: payments };
}
/** Cohérence d'une facture : Σ échéances = net à payer ; Σ payé des échéances ≤ encaissé ; payé = Σ encaissements actifs. */
export async function invoiceConsistency(companyId: Id, id: string) {
  const inv = await getOwn(companyId, id);
  const pays = await Payment.aggregate<{ t: number }>([{ $match: { companyId, invoiceId: inv._id, status: 'active' } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]);
  const scheduleTotal = inv.schedule.reduce((s, x) => s + (x.amountMinor ?? 0), 0);
  const schedulePaid = inv.schedule.reduce((s, x) => s + (x.paidMinor ?? 0), 0); const scheduleCredited = inv.schedule.reduce((s, x) => s + (x.creditedMinor ?? 0), 0);
  const credits = await Invoice.aggregate<{ t: number }>([{ $match: { companyId, creditedInvoiceId: inv._id, status: 'validated' } }, { $group: { _id: null, t: { $sum: '$totals.totalPayableMinor' } } }]);
  const checks = {
    scheduleSumsToPayable: inv.schedule.length === 0 || scheduleTotal === (inv.totals.totalPayableMinor ?? 0),
    paidMatchesPayments: (inv.paidMinor ?? 0) === (pays[0]?.t ?? 0), schedulePaidMatches: schedulePaid === (inv.paidMinor ?? 0),
    creditedMatchesCreditNotes: (inv.creditedMinor ?? 0) === (credits[0]?.t ?? 0), scheduleCreditedWithinCredits: scheduleCredited <= (inv.creditedMinor ?? 0),
    noNegativeOpen: inv.schedule.every((s) => (s.amountMinor ?? 0) - (s.paidMinor ?? 0) - (s.creditedMinor ?? 0) >= 0),
  };
  return { consistent: Object.values(checks).every(Boolean), checks };
}
