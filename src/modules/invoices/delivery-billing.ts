import { Types, type ClientSession, type Model } from 'mongoose';
import { Customer } from '../../models/customer.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { CalculationError, computeDocument, groupKey, type CalcInput, type CalcLine, type VatRegime } from '../../services/calculation.service.js';
import { resolveStamp, resolveVat, resolveWithholding, startOfDay, type VatSnapshot } from '../../services/fiscal.service.js';
import { resolveTerms, type BuiltLine } from '../sales/document.builder.js';
import { allocate, allocatedOf, availableToBill, billedBySource, billedFields, billedOf, billingState, componentsOf, q3, release, slice, withShares, writeLines, type Amounts, type BillableNote, type Billed, type CycleLine } from '../sales/billing.js';
import { logCycle, type CycleActor } from '../sales/cycle.log.js';

/** Facturation des bons de livraison : individuelle ou groupée, avec affectation atomique des quantités et des montants. */
type Id = Types.ObjectId;
const EPS = 1e-9;
export type Note = BillableNote & { number: string; companyId: Id; customerId: Id; customerSnapshot: Record<string, unknown>; deliveryDate: Date; deliveryAddress?: unknown; invoiceIds?: Id[] | null; cycleRevision?: number | null };
export interface BasisDoc { _id: Id; number: string; status: string; customerId: Id; customerSnapshot: Record<string, unknown>; lines: CycleLine[]; totals: { globalDiscountMinor?: number | null; vatGroups: { vatCode?: string | null; regime?: string | null; ratePct?: number | null; baseMinor?: number | null; vatMinor?: number | null }[] };
  paymentTerms?: string | null; paymentTermsCustom?: boolean | null; withholdingOperationType?: string | null; globalDiscountPct?: number | null; syncDiscountPct?: number | null; quotationId?: Id | null; quotationNumber?: string | null; quotationVersion?: number | null; cycleRevision?: number | null }
export interface Basis { type: 'proforma' | 'quotation'; doc: BasisDoc }
export interface Selection { deliveryNoteId: string; lineId: string; quantity: number }
const basisModel = (t: 'proforma' | 'quotation') => (t === 'proforma' ? Proforma : Quotation) as unknown as Model<unknown>;

const notBillable = (d: Note) => {
  if (d.status !== 'validated') throw new AppError(409, `${d.number} : seuls les BL validés sont facturables`, 'DELIVERY_NOT_VALIDATED');
  if (billedBySource(d)) throw new AppError(409, `${d.number} : il livre la facture ${d.source?.number ?? ''}, ses marchandises sont déjà facturées`, 'ALREADY_BILLED');
};
const sourceKey = (d: Note) => (d.source?.id ? `${d.source.type}:${d.source.id}` : 'manual');

async function loadSet(companyId: Id, ids: string[], session: ClientSession) {
  const bls = (await DeliveryNote.find({ _id: { $in: ids }, companyId }).session(session).lean()) as unknown as Note[];
  if (bls.length !== new Set(ids).size) throw AppError.badRequest('Bon de livraison introuvable');
  if (new Set(bls.map((b) => b.customerId.toString())).size !== 1) throw AppError.badRequest('Tous les bons de livraison doivent concerner le même client');
  bls.forEach(notBillable);
  if (new Set(bls.map(sourceKey)).size !== 1) throw new AppError(409, 'Une facture groupée réunit les BL d’un même cycle commercial (même proforma, ou BL saisis sans document source). Facturez les autres séparément.', 'INCOMPATIBLE_DELIVERIES');
  return bls.sort((a, b) => a.number.localeCompare(b.number));
}
export async function loadBasis(companyId: Id, bl: Pick<Note, 'source'>, session: ClientSession | null): Promise<Basis | null> {
  const type = bl.source?.type;
  if ((type !== 'proforma' && type !== 'quotation') || !bl.source?.id) return null;
  const doc = (await basisModel(type).findOne({ _id: bl.source.id, companyId }).session(session).lean()) as BasisDoc | null;
  if (!doc) throw AppError.conflict('Document source du BL introuvable');
  return { type, doc: withShares(doc) };
}
/** Quantités facturées par l'ancien parcours (BL sans compteur), par ligne du document source. */
async function legacyBilled(companyId: Id, basis: Basis | null, session: ClientSession | null) {
  const m = new Map<string, number>(); if (!basis || basis.doc.lines.every((l) => l.allocatedQty !== undefined && l.allocatedQty !== null)) return m;
  const bls = (await DeliveryNote.find({ companyId, 'source.id': basis.doc._id, status: 'validated' }).session(session).lean()) as unknown as Note[];
  for (const d of bls) for (const l of d.lines) if (l.sourceLineId && (l.allocatedQty === undefined || l.allocatedQty === null)) m.set(String(l.sourceLineId), q3((m.get(String(l.sourceLineId)) ?? 0) + allocatedOf(d, l)));
  return m;
}
export const returnedSerials = (d: Note, lineId: unknown) => (d.returns ?? []).flatMap((r) => r.lines.filter((l) => String(l.lineId) === String(lineId)).flatMap((l) => l.serials ?? []));

interface Item { bl: Note; line: CycleLine; basisLine: CycleLine; quantity: number; amounts: Amounts; next: Billed; serials?: string[] | undefined }
/** Quantités à facturer (toutes les quantités disponibles, ou la sélection demandée) et montants affectés. */
async function plan(companyId: Id, bls: Note[], basis: Basis | null, selection: Selection[] | undefined, session: ClientSession) {
  const wanted = selection ? new Map(selection.map((s) => [`${s.deliveryNoteId}:${s.lineId}`, s.quantity])) : null;
  if (selection && wanted!.size !== selection.length) throw AppError.badRequest('Une ligne de livraison est sélectionnée deux fois');
  const legacy = await legacyBilled(companyId, basis, session); const state = new Map<string, Billed>(); const items: Item[] = [];
  for (const bl of bls) {
    const before = items.length;
    for (const line of bl.lines) {
      const key = `${bl._id}:${line._id}`; const available = availableToBill(bl, line);
      const quantity = wanted ? wanted.get(key) ?? 0 : available; wanted?.delete(key);
      if (quantity <= EPS) continue;
      if (quantity > available + EPS) throw new AppError(409, `${bl.number} — « ${line.designation} » : quantité à facturer (${quantity}) supérieure à la quantité livrée non facturée (${available})`, 'BILLING_EXCEEDED');
      const basisLine = basis ? basis.doc.lines.find((x) => String(x._id) === String(line.sourceLineId)) : line;
      if (!basisLine) throw AppError.conflict(`${bl.number} : ligne du document source introuvable`);
      const k = String(basisLine._id);
      const done = state.get(k) ?? billedOf(basisLine, basis ? legacy.get(k) ?? 0 : allocatedOf(bl, line));
      const { amounts, next } = allocate(basisLine, done, quantity); state.set(k, next);
      let serials: string[] | undefined;
      if (line.serials?.length) {
        const used = new Set([...(line.billedSerials ?? []), ...returnedSerials(bl, line._id)]);
        serials = line.serials.filter((s) => !used.has(s)).slice(0, quantity);
      }
      items.push({ bl, line, basisLine, quantity, amounts, next, serials });
    }
    if (!wanted && items.length === before) throw new AppError(409, `${bl.number} : déjà facturé, aucune quantité disponible`, 'ALREADY_BILLED');
  }
  if (wanted?.size) throw AppError.badRequest('Ligne de livraison inconnue dans la sélection');
  if (!items.length) throw new AppError(409, 'Rien à facturer : aucune quantité livrée non facturée', 'ALREADY_BILLED');
  return items;
}

interface Priced { productId?: Id | null | undefined; quantity: number; unitPriceMinor: number; discountPct?: number | null | undefined; vatCode: string; grossMinor: number; netHtMinor: number; globalShareMinor: number; basisLineId?: Id | undefined }
/**
 * Montants d'une facture issue de livraisons : nets et parts de remise affectés (jamais recalculés depuis les tarifs), TVA, retenue et
 * timbre selon les règles fiscales à la date de la facture. Lorsque la facture solde un taux de TVA du document source (sans
 * correction intervenue), elle reprend la TVA convenue moins celle déjà facturée (écart d'arrondi de quelques millimes).
 */
async function compute(companyId: Id, lines: Priced[], o: { date: Date; session: ClientSession; customer: { subjectToWithholding?: boolean | null; stampExempt?: boolean | null }; withholdingOperationType?: string | null | undefined; basis: Basis | null; invoiceId?: Id | undefined }) {
  const cache = new Map<string, VatSnapshot>();
  const vats: VatSnapshot[] = [];
  for (const l of lines) { if (!cache.has(l.vatCode)) cache.set(l.vatCode, await resolveVat(companyId, l.vatCode, o.date, o.session)); vats.push(cache.get(l.vatCode)!); }
  const calc: CalcLine[] = lines.map((l, i) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct ?? 0, vatCode: vats[i]!.code, vatRegime: vats[i]!.regime, vatRatePct: vats[i]!.ratePct,
    netHtOverrideMinor: l.netHtMinor, grossOverrideMinor: l.grossMinor, globalShareOverrideMinor: l.globalShareMinor }));
  try {
    const plain = computeDocument({ lines: calc });
    const vatOverrides = await completion(companyId, o.basis, lines.map((l, i) => ({ basisLineId: l.basisLineId, quantity: l.quantity, key: groupKey(vats[i]!.code, vats[i]!.regime, vats[i]!.ratePct) })), plain.totals.vatGroups, o.session, o.invoiceId);
    const base: CalcInput = { lines: calc, vatOverrides };
    let result = computeDocument(base);
    const flags = { subjectToWithholding: o.customer.subjectToWithholding, stampExempt: o.customer.stampExempt };
    const w = await resolveWithholding(companyId, { operationType: o.withholdingOperationType, date: o.date, totalTtcMinor: result.totals.totalTtcMinor, customer: flags as never }, o.session);
    const s = await resolveStamp(companyId, { docType: 'invoice', date: o.date, totalTtcMinor: result.totals.totalTtcMinor, customer: flags as never }, o.session);
    if (w || s) result = computeDocument({ ...base, ...(w && { withholding: { ratePct: w.ratePct, base: w.base } }), ...(s && { stampMinor: s.amountMinor }) });
    return { results: result.lines, vats, totals: result.totals, withholding: w ? { ...w, amountMinor: result.totals.withholdingMinor } : undefined, stamp: s ? { ruleId: s.ruleId, code: s.code, amountMinor: s.amountMinor } : undefined };
  } catch (e) { if (e instanceof CalculationError) throw new AppError(422, e.message, 'CALCULATION_ERROR'); throw e; }
}
async function completion(companyId: Id, basis: Basis | null, lines: { basisLineId?: Id | undefined; quantity: number; key: string }[], computed: { vatCode: string; regime: VatRegime; ratePct: number; vatMinor: number }[], session: ClientSession, invoiceId?: Id) {
  const out: Record<string, number> = {};
  if (!basis) return out;
  // Après une correction ou un retour, ou avec une facture de l'ancien parcours, la TVA est calculée normalement
  if (await Invoice.exists({ companyId, status: 'validated', $or: [{ creditEffect: { $in: ['return', 'billing_correction'] }, 'lines.delivery.basisId': basis.doc._id }, { type: 'invoice', origin: null, [basis.type === 'proforma' ? 'proformaId' : 'quotationId']: basis.doc._id }] }).session(session)) return out;
  const validated = await Invoice.find({ companyId, type: 'invoice', status: 'validated', origin: 'delivery', 'lines.delivery.basisId': basis.doc._id, ...(invoiceId && { _id: { $ne: invoiceId } }) }).session(session).lean();
  for (const g of computed) {
    const key = groupKey(g.vatCode, g.regime, g.ratePct);
    const basisLines = basis.doc.lines.filter((l) => groupKey(l.vat.code!, l.vat.regime!, l.vat.ratePct ?? 0) === key);
    const agreed = basis.doc.totals.vatGroups.find((x) => groupKey(x.vatCode!, x.regime!, x.ratePct ?? 0) === key);
    if (!basisLines.length || !agreed) continue;
    const billed = (id: string) => q3(validated.flatMap((i) => i.lines).filter((l) => String(l.delivery?.basisLineId) === id).reduce((s, l) => s + l.quantity, 0) + lines.filter((l) => String(l.basisLineId) === id).reduce((s, l) => s + l.quantity, 0));
    if (!basisLines.every((l) => billed(String(l._id)) >= l.quantity - EPS)) continue;
    const done = validated.reduce((s, i) => s + (i.totals.vatGroups.find((x) => groupKey(x.vatCode!, x.regime!, x.ratePct ?? 0) === key)?.vatMinor ?? 0), 0);
    const target = (agreed.vatMinor ?? 0) - done;
    if (target >= 0 && Math.abs(target - g.vatMinor) <= validated.length + 1) out[key] = target;
  }
  return out;
}

const pricedOfItem = (i: Item): Priced => ({ productId: i.line.productId, quantity: i.quantity, unitPriceMinor: i.basisLine.unitPriceMinor, discountPct: i.basisLine.discountPct, vatCode: i.basisLine.vat.code!,
  grossMinor: i.amounts.after + i.amounts.share + i.amounts.discount, netHtMinor: i.amounts.after + i.amounts.share, globalShareMinor: i.amounts.share, basisLineId: i.basisLine._id });
const customerOf = async (companyId: Id, id: Id, session: ClientSession) => {
  const c = await Customer.findOne({ _id: id, companyId }).session(session).lean();
  if (!c) throw AppError.badRequest('Client invalide');
  return c;
};

export interface BillingBody { deliveryNoteIds: string[]; lines?: Selection[] | undefined; issueDate?: Date | undefined; mode?: 'grouped' | 'individual' | undefined }

/** Totaux que produirait la facturation demandée, sans rien enregistrer. */
export async function preview(companyId: Id, b: BillingBody) {
  return withTransaction(async (session) => {
    const bls = await loadSet(companyId, b.deliveryNoteIds, session); const basis = await loadBasis(companyId, bls[0]!, session);
    const items = await plan(companyId, bls, basis, b.lines, session); const customer = await customerOf(companyId, bls[0]!.customerId, session);
    const r = await compute(companyId, items.map(pricedOfItem), { date: startOfDay(b.issueDate ?? new Date()), session, customer, withholdingOperationType: basis?.doc.withholdingOperationType, basis });
    return { totals: r.totals, withholding: r.withholding ?? null, stamp: r.stamp ?? null,
      lines: items.map((i, n) => ({ deliveryNoteId: i.bl._id.toString(), deliveryNumber: i.bl.number, lineId: i.line._id.toString(), reference: i.line.reference ?? null, designation: i.line.designation, unit: i.line.unit ?? null, quantity: i.quantity, netHtMinor: r.results[n]!.netHtMinor - r.results[n]!.globalShareMinor })) };
  });
}

/** Crée UNE facture brouillon pour les BL donnés : les quantités sont réservées dans la même transaction. */
async function createOne(companyId: Id, userId: Id, b: BillingBody, ids: string[], actor: CycleActor, session: ClientSession) {
  const bls = await loadSet(companyId, ids, session); const basis = await loadBasis(companyId, bls[0]!, session);
  if (basis?.type === 'proforma' && basis.doc.status === 'cancelled') throw AppError.conflict('Proforma annulée : aucune facturation possible');
  const selection = b.lines?.filter((s) => ids.includes(s.deliveryNoteId));
  const items = await plan(companyId, bls, basis, b.lines ? selection : undefined, session);
  const customer = await customerOf(companyId, bls[0]!.customerId, session);
  const issueDate = startOfDay(b.issueDate ?? new Date());
  const r = await compute(companyId, items.map(pricedOfItem), { date: issueDate, session, customer, withholdingOperationType: basis?.doc.withholdingOperationType, basis });
  const used = bls.filter((d) => items.some((i) => i.bl === d));
  const invoiceId = new Types.ObjectId();
  const lines = items.map((i, n) => ({
    ...(i.line.productId && { productId: i.line.productId }), reference: i.basisLine.reference ?? undefined, designation: i.line.designation, description: i.basisLine.description ?? undefined, unit: i.line.unit ?? undefined, kind: i.basisLine.kind ?? 'product',
    quantity: i.quantity, unitPriceMinor: i.basisLine.unitPriceMinor, discountPct: i.basisLine.discountPct ?? 0, vat: r.vats[n], ...r.results[n], deliveredQty: i.quantity, ...(basis && { sourceLineId: i.basisLine._id }), ...(i.serials?.length && { serials: i.serials }),
    delivery: { noteId: i.bl._id, noteNumber: i.bl.number, lineId: i.line._id, basisType: basis?.type ?? 'deliveryNote', basisId: basis?.doc._id ?? i.bl._id, basisLineId: i.basisLine._id },
  }));
  const quotationId = basis?.type === 'quotation' ? basis.doc._id : basis?.doc.quotationId ?? undefined;
  const quote = quotationId ? await Quotation.findOne({ _id: quotationId, companyId }).session(session).select('number').lean() : null;
  const addresses = new Set(used.map((d) => JSON.stringify(d.deliveryAddress)));
  const terms = basis ? { paymentTerms: basis.doc.paymentTerms ?? null, paymentTermsCustom: !!basis.doc.paymentTermsCustom } : resolveTerms(customer, {});
  const snapshot = basis?.doc.customerSnapshot ?? used[0]!.customerSnapshot;
  await Invoice.create([{ _id: invoiceId, companyId, type: 'invoice', status: 'draft', origin: 'delivery', customerId: customer._id, customerSnapshot: snapshot, issueDate, lines,
    globalDiscountPct: basis?.doc.globalDiscountPct ?? 0, syncDiscountPct: basis?.doc.syncDiscountPct ?? 0, globalDiscountMinor: r.totals.globalDiscountMinor,
    withholdingOperationType: basis?.doc.withholdingOperationType ?? undefined, withholding: r.withholding, stamp: r.stamp, totals: r.totals, notes: `BL : ${used.map((d) => d.number).join(', ')}`,
    deliveryAddress: addresses.size === 1 ? used[0]!.deliveryAddress : null, ...terms, deliveryNoteIds: used.map((d) => d._id),
    ...(basis?.type === 'proforma' && { proformaId: basis.doc._id }), ...(quotationId && { quotationId }),
    sourceRefs: { ...(basis?.type === 'proforma' && { proformaNumber: basis.doc.number }), ...(quote && { quotationNumber: quote.number }), ...(basis?.doc.quotationVersion && { quotationVersion: basis.doc.quotationVersion }) },
    createdBy: userId }] as never[], { session });

  // Réservation des quantités : BL, puis document base de prix
  const basisChanges = new Map<string, Record<string, unknown>>();
  for (const d of used) {
    const changes = new Map<string, Record<string, unknown>>();
    for (const i of items.filter((x) => x.bl === d)) {
      const allocatedQty = q3(allocatedOf(d, i.line) + i.quantity);
      changes.set(String(i.line._id), { allocatedQty, ...(i.serials?.length && { billedSerials: [...(i.line.billedSerials ?? []), ...i.serials] }), ...(!basis && billedFields(i.next)) });
      if (basis) basisChanges.set(String(i.basisLine._id), billedFields(i.next));
    }
    await writeLines(DeliveryNote as unknown as Model<unknown>, companyId, d, changes, session, { $addToSet: { invoiceIds: invoiceId } });
  }
  if (basis) await writeLines(basisModel(basis.type), companyId, basis.doc, basisChanges, session);
  const grouped = used.length > 1;
  await logCycle(session, companyId, actor, [{ action: grouped ? 'invoice_grouped' : 'invoice_created', resourceId: invoiceId, description: `${grouped ? `${used.length} bons de livraison` : 'Depuis le BL'} : ${used.map((d) => d.number).join(', ')}`,
    refs: [...used.map((d) => d._id), basis?.doc._id, quotationId] }]);
  return invoiceId;
}
/** Facturation individuelle (une facture par BL) ou groupée (une seule) : tout ou rien. */
export async function createFromDeliveries(companyId: Id, userId: Id, b: BillingBody, actor: CycleActor = { userId }) {
  const ids = [...new Set(b.deliveryNoteIds)];
  if (b.lines?.some((s) => !ids.includes(s.deliveryNoteId))) throw AppError.badRequest('La sélection porte sur un BL non choisi');
  return withTransaction(async (session) => {
    if (b.mode !== 'individual') return [await createOne(companyId, userId, b, ids, actor, session)];
    const out: Id[] = [];
    for (const id of ids) out.push(await createOne(companyId, userId, b, [id], actor, session));
    return out;
  });
}

/** BL ayant des quantités livrées non facturées, avec le montant correspondant. */
export async function billable(companyId: Id, f: { customerId?: string | undefined; sourceId?: string | undefined; q?: string | undefined }) {
  const filter: Record<string, unknown> = { companyId, status: 'validated', 'source.type': { $ne: 'invoice' }, ...(f.customerId && { customerId: new Types.ObjectId(f.customerId) }), ...(f.sourceId && { 'source.id': new Types.ObjectId(f.sourceId) }) };
  if (f.q) { const rx = new RegExp(f.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }, { 'source.number': rx }]; }
  const docs = (await DeliveryNote.find({ ...filter, $expr: BILLABLE_EXPR }).sort({ deliveryDate: 1, number: 1 }).limit(200).lean()) as unknown as Note[];
  const bases = new Map<string, Basis | null>(); const items = [];
  for (const d of docs) {
    const key = sourceKey(d); if (!bases.has(key)) bases.set(key, await loadBasis(companyId, d, null));
    const basis = bases.get(key)!; const legacy = await legacyBilled(companyId, basis, null); const state = new Map<string, Billed>();
    const calc: CalcLine[] = []; const lines = [];
    for (const line of d.lines) {
      const available = availableToBill(d, line);
      lines.push({ lineId: line._id.toString(), reference: line.reference ?? null, designation: line.designation, unit: line.unit ?? null, quantity: line.quantity, returned: line.returnedQty ?? 0, available });
      const basisLine = basis ? basis.doc.lines.find((x) => String(x._id) === String(line.sourceLineId)) : line;
      if (!basisLine || available <= EPS) continue;
      const k = String(basisLine._id); const done = state.get(k) ?? billedOf(basisLine, basis ? legacy.get(k) ?? 0 : allocatedOf(d, line));
      if (done.qty + available > basisLine.quantity + EPS) continue;
      const { amounts, next } = allocate(basisLine, done, available); state.set(k, next);
      calc.push({ quantity: available, unitPriceMinor: basisLine.unitPriceMinor, vatCode: basisLine.vat.code!, vatRegime: basisLine.vat.regime as VatRegime, vatRatePct: basisLine.vat.ratePct ?? 0,
        netHtOverrideMinor: amounts.after + amounts.share, grossOverrideMinor: amounts.after + amounts.share + amounts.discount, globalShareOverrideMinor: amounts.share });
    }
    const totals = calc.length ? computeDocument({ lines: calc }).totals : null;
    items.push({ id: d._id.toString(), number: d.number, date: d.deliveryDate, status: d.status, billing: billingState(d), customerId: d.customerId.toString(), customerName: String(d.customerSnapshot.name ?? ''),
      source: d.source?.type ? { type: d.source.type, id: String(d.source.id), number: d.source.number ?? null } : null, groupKey: `${d.customerId}|${key}`, lines,
      totalHtMinor: totals?.totalHtMinor ?? 0, totalTtcMinor: totals?.totalTtcMinor ?? 0 });
  }
  return { items };
}
/** Condition de base : au moins une ligne livrée (nette des retours) non affectée à une facture. */
export const BILLABLE_EXPR = { $anyElementTrue: [{ $map: { input: '$lines', as: 'l', in: { $gt: [{ $subtract: [{ $subtract: ['$$l.quantity', { $ifNull: ['$$l.returnedQty', 0] }] }, { $ifNull: ['$$l.allocatedQty', { $cond: [{ $ifNull: ['$invoiceId', false] }, '$$l.quantity', 0] }] }] }, 1e-7] } } }] };

type InvoiceDocLean = { _id: Id; customerId: Id; status: string; type?: string | null; lines: (CycleLine & { delivery?: CycleLine['delivery'] })[]; withholdingOperationType?: string | null; proformaId?: Id | null; quotationId?: Id | null; deliveryNoteIds?: Id[] | null };
/** Montants d'une facture de livraisons recalculés (date, règles fiscales) à partir des montants affectés à ses lignes. */
export async function recompute(companyId: Id, inv: InvoiceDocLean, o: { date: Date; session: ClientSession; withholdingOperationType?: string | null | undefined }) {
  const noteIds = [...new Set(inv.lines.map((l) => String(l.delivery?.noteId)))];
  const bls = (await DeliveryNote.find({ _id: { $in: noteIds }, companyId }).session(o.session).lean()) as unknown as Note[];
  if (bls.length !== noteIds.length) throw AppError.conflict('Un bon de livraison de cette facture est introuvable');
  for (const d of bls) {
    if (d.status !== 'validated') throw new AppError(409, `${d.number} : il n’est plus validé, la facture ne peut pas l’inclure`, 'DELIVERY_NOT_VALIDATED');
    for (const l of d.lines) if (allocatedOf(d, l) > netDeliveredOf(l) + EPS) throw new AppError(409, `${d.number} — « ${l.designation} » : quantité affectée aux factures supérieure à la quantité livrée`, 'BILLING_EXCEEDED');
  }
  const basis = await loadBasis(companyId, bls[0]!, o.session);
  if (basis?.type === 'proforma' && basis.doc.status === 'cancelled') throw AppError.conflict('Proforma annulée : aucune facturation possible');
  const customer = await customerOf(companyId, inv.customerId, o.session);
  const r = await compute(companyId, inv.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct, vatCode: l.vat.code!, grossMinor: l.grossMinor ?? 0, netHtMinor: l.netHtMinor ?? 0, globalShareMinor: l.globalShareMinor ?? 0, basisLineId: l.delivery?.basisLineId ?? undefined })),
    { date: o.date, session: o.session, customer, withholdingOperationType: o.withholdingOperationType, basis, invoiceId: inv._id });
  const lines = inv.lines.map((l, i) => ({ ...l, vat: r.vats[i]!, ...r.results[i]! })) as unknown as BuiltLine[];
  return { lines, totals: r.totals, withholding: r.withholding, stamp: r.stamp, customer: { paymentDelayDays: customer.paymentDelayDays } };
}
const netDeliveredOf = (l: CycleLine) => q3(l.quantity - (l.returnedQty ?? 0));

export interface Adjustment { noteId: Id; lineId: Id; basisType: 'proforma' | 'quotation' | 'deliveryNote'; basisId: Id; basisLineId: Id; quantity: number; amounts: Amounts; serials?: string[] | undefined }
/**
 * Mouvement des compteurs de facturation :
 *  - « commit » : validation d'une facture (quantités facturées) ;
 *  - « release » : suppression d'un brouillon (réservation libérée) ;
 *  - « reopen » : correction de facturation ou retour crédité (quantités et montants de nouveau à facturer).
 */
export async function adjust(companyId: Id, entries: Adjustment[], mode: 'commit' | 'release' | 'reopen', session: ClientSession, opts: { invoiceId?: Id | undefined; noteDocs?: Map<string, Note> } = {}) {
  const group = <T>(list: T[], key: (t: T) => string) => list.reduce((m, t) => m.set(key(t), [...(m.get(key(t)) ?? []), t]), new Map<string, T[]>());
  const free = mode !== 'commit';
  for (const [noteId, list] of group(entries, (e) => String(e.noteId))) {
    const d = opts.noteDocs?.get(noteId) ?? ((await DeliveryNote.findOne({ _id: noteId, companyId }).session(session).lean()) as unknown as Note | null);
    if (!d) throw AppError.conflict('Bon de livraison introuvable');
    const changes = new Map<string, Record<string, unknown>>();
    for (const e of list) {
      const l = d.lines.find((x) => String(x._id) === String(e.lineId)); if (!l) throw AppError.conflict('Ligne de livraison introuvable');
      const fields: Record<string, unknown> = {};
      if (mode !== 'release') fields.invoicedQty = Math.max(0, q3((l.invoicedQty ?? (mode === 'commit' ? 0 : allocatedOf(d, l))) + (mode === 'commit' ? e.quantity : -e.quantity)));
      if (free) {
        if (e.basisType === 'deliveryNote') Object.assign(fields, billedFields(release(billedOf(l, allocatedOf(d, l)), e.quantity, e.amounts)));
        else fields.allocatedQty = Math.max(0, q3(allocatedOf(d, l) - e.quantity));
        if (e.serials?.length) fields.billedSerials = (l.billedSerials ?? []).filter((s) => !e.serials!.includes(s));
      }
      Object.assign(l, fields); // plusieurs mouvements sur la même ligne se cumulent
      changes.set(String(l._id), { ...changes.get(String(l._id)), ...fields });
    }
    await writeLines(DeliveryNote as unknown as Model<unknown>, companyId, d, changes, session, mode === 'release' && opts.invoiceId ? { $pull: { invoiceIds: opts.invoiceId } } : {});
  }
  for (const [basisId, list] of group(entries.filter((e) => e.basisType !== 'deliveryNote'), (e) => String(e.basisId))) {
    const type = list[0]!.basisType as 'proforma' | 'quotation';
    const doc = (await basisModel(type).findOne({ _id: basisId, companyId }).session(session).lean()) as BasisDoc | null;
    if (!doc) throw AppError.conflict('Document source introuvable');
    withShares(doc);
    const changes = new Map<string, Record<string, unknown>>(); const state = new Map<string, Billed>(); const invoiced = new Map<string, number>();
    for (const e of list) {
      const l = doc.lines.find((x) => String(x._id) === String(e.basisLineId)); if (!l) throw AppError.conflict('Ligne du document source introuvable');
      const k = String(l._id); const fields = changes.get(k) ?? {};
      if (mode !== 'release') { invoiced.set(k, Math.max(0, q3((invoiced.get(k) ?? l.invoicedQty ?? (mode === 'commit' ? 0 : l.allocatedQty ?? 0)) + (mode === 'commit' ? e.quantity : -e.quantity)))); fields.invoicedQty = invoiced.get(k); }
      if (free) { const next = release(state.get(k) ?? billedOf(l, l.allocatedQty ?? e.quantity), e.quantity, e.amounts); state.set(k, next); Object.assign(fields, billedFields(next)); }
      changes.set(k, fields);
    }
    await writeLines(basisModel(type), companyId, doc, changes, session);
  }
}
export const adjustmentsOf = (inv: Pick<InvoiceDocLean, 'lines'>): Adjustment[] => inv.lines.filter((l) => l.delivery?.noteId).map((l) => ({ noteId: l.delivery!.noteId!, lineId: l.delivery!.lineId!, basisType: l.delivery!.basisType!, basisId: l.delivery!.basisId!, basisLineId: l.delivery!.basisLineId!,
  quantity: l.quantity, amounts: componentsOf(l), serials: l.serials ?? undefined }));

/** Quantités d'une facture déjà rouvertes (corrections de facturation validées et retours crédités), par ligne de facture. */
export async function reopenedOf(companyId: Id, invoiceId: Id, session: ClientSession, excludeCreditId?: Id) {
  const out = new Map<string, { qty: number; serials: string[] }>();
  const add = (k: string, qty: number, serials: string[] = []) => { const v = out.get(k) ?? { qty: 0, serials: [] }; out.set(k, { qty: q3(v.qty + qty), serials: [...v.serials, ...serials] }); };
  const credits = await Invoice.find({ companyId, creditedInvoiceId: invoiceId, type: 'credit_note', status: 'validated', creditEffect: 'billing_correction', ...(excludeCreditId && { _id: { $ne: excludeCreditId } }) }).session(session).lean();
  for (const c of credits) for (const l of c.lines) if (l.sourceLineId) add(String(l.sourceLineId), l.quantity, (l.serials as string[] | undefined) ?? []);
  const notes = await DeliveryNote.find({ companyId, 'returns.lines.credited.invoiceId': invoiceId }).session(session).select('returns').lean();
  for (const d of notes) for (const r of d.returns ?? []) for (const l of r.lines) for (const c of l.credited ?? []) if (String(c.invoiceId) === String(invoiceId)) add(String(c.invoiceLineId), c.quantity ?? 0, l.serials ?? []);
  return out;
}
/** Avoir de correction de facturation validé : les quantités créditées redeviennent à facturer, pour le montant crédité. */
export async function reopenFromCredit(companyId: Id, credit: { _id: Id; lines: BuiltLine[] }, orig: InvoiceDocLean & { _id: Id }, session: ClientSession) {
  const done = await reopenedOf(companyId, orig._id, session, credit._id);
  const entries: Adjustment[] = [];
  for (const c of credit.lines) {
    const l = orig.lines.find((x) => String(x._id) === String(c.sourceLineId));
    if (!l?.delivery?.noteId) throw new AppError(422, `« ${c.designation} » : aucune livraison à refacturer sur cette ligne`, 'NO_DELIVERY_TO_REBILL');
    const before = done.get(String(l._id))?.qty ?? 0; const parts = componentsOf(l);
    const left = (l.serials ?? []).filter((s) => !done.get(String(l._id))?.serials.includes(s));
    const serials = left.length ? left.slice(-c.quantity) : undefined;
    if (serials) c.serials = serials;
    entries.push({ noteId: l.delivery.noteId, lineId: l.delivery.lineId!, basisType: l.delivery.basisType!, basisId: l.delivery.basisId!, basisLineId: l.delivery.basisLineId!, quantity: c.quantity, serials,
      amounts: { after: c.netHtMinor, share: slice(parts.share, before, c.quantity, l.quantity), discount: slice(parts.discount, before, c.quantity, l.quantity) } });
  }
  await adjust(companyId, entries, 'reopen', session);
}
