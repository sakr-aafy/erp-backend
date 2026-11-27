import type { ClientSession, QueryFilter, Types } from 'mongoose';
import { Proforma, DeliveryNote, Invoice, type ProformaDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { buildDocument, frozenOf, inheritFrom, legacyDiscountOf, type DocInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import { progressOf } from '../sales/tracking.js';
import type { CycleLine } from '../sales/billing.js';
import { logCycle, type CycleActor } from '../sales/cycle.log.js';
import { expireOverdue } from './proforma.expiry.js';
export { expireOverdue };

type Id = Types.ObjectId;
export type Lean = ProformaDoc & { _id: Id; createdAt?: Date };

export const toDto = (p: Lean, engaged = false) => {
  const lines = p.lines as unknown as CycleLine[];
  const delivery = progressOf(lines, (l) => l.deliveredQty ?? 0); const billing = progressOf(lines, (l) => (p.status === 'converted' ? l.quantity : l.invoicedQty ?? 0));
  return {
    id: p._id.toString(), number: p.number, status: p.status,
    /** Statut administratif ; les avancements de livraison et de facturation sont indépendants. */
    statusLabel: p.status === 'pending' ? (p.sentAt ? 'Envoyée' : 'En attente') : STATUS_LABEL[p.status] ?? p.status,
    customerId: p.customerId.toString(), customer: p.customerSnapshot, issueDate: p.issueDate, validUntil: p.validUntil,
    lines: p.lines.map((l) => ({ ...l, id: (l as { _id: Id })._id.toString() })), globalDiscountPct: p.globalDiscountPct, syncDiscountPct: p.syncDiscountPct ?? 0, quotationVersion: p.quotationVersion ?? null, quotationNumber: p.quotationNumber ?? null, deliveryTime: p.deliveryTime ?? null, globalDiscountMinor: p.globalDiscountMinor,
    withholdingOperationType: p.withholdingOperationType ?? null, totals: p.totals, notes: p.notes ?? null, terms: p.terms ?? null, paymentTerms: p.paymentTerms ?? null, paymentTermsCustom: !!p.paymentTermsCustom, deliveryAddress: snapshotDto(p.deliveryAddress as never),
    quotationId: p.quotationId?.toString() ?? null, invoiceId: p.invoiceId?.toString() ?? null, sentAt: p.sentAt ?? null, sentByName: p.sentByName ?? null, sentTo: p.sentTo ?? null, createdAt: p.createdAt,
    cancelledAt: p.cancelledAt ?? null, cancelledByName: p.cancelledByName ?? null, cancelReason: p.cancelReason ?? null, legacyFlow: !!p.legacyFlow || p.status === 'converted',
    deliveryState: delivery.state, deliveryPct: delivery.pct, billingState: billing.state, billingPct: billing.pct,
    /** Modifiable tant qu'aucune livraison ni facture n'en dépend. */
    editable: p.status === 'pending' && !p.invoiceId && !engaged && delivery.state === 'none',
  };
};
const STATUS_LABEL: Record<string, string> = { converted: 'Convertie (ancien parcours)', expired: 'Expirée', cancelled: 'Annulée' };
/** Une proforma est engagée dès qu'un BL non annulé ou une facture s'y rattache. */
const isEngaged = async (companyId: Id, id: Id, session?: ClientSession) => !!(await DeliveryNote.exists({ companyId, 'source.id': id, status: { $ne: 'cancelled' } }).session(session ?? null)) || !!(await Invoice.exists({ companyId, proformaId: id }).session(session ?? null));

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  await expireOverdue(companyId);
  const filter: QueryFilter<ProformaDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }]; }
  const sort = buildSort(f.sort, ['number', 'issueDate', 'validUntil', 'createdAt'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Proforma.find(filter).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Proforma.countDocuments(filter)]);
  return { items: items.map((p) => ({ ...toDto(p as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const p = await Proforma.findOne({ _id: id, companyId }).lean();
  if (!p) throw AppError.notFound('Facture proforma introuvable');
  return p as Lean;
}
export const get = async (c: Id, id: string) => { const p = await getOwn(c, id); return toDto(p, await isEngaged(c, p._id)); };

type Body = DocInput & { issueDate?: Date | undefined; validUntil: Date; notes?: string | undefined; terms?: string | undefined; deliveryTime?: string | undefined };

export async function create(companyId: Id, userId: Id, b: Body, actor: CycleActor = { userId }) {
  const issueDate = startOfDay(b.issueDate ?? new Date());
  await ensureCounter(companyId, 'proforma', issueDate);
  const p = await withTransaction(async (session) => {
    const doc = await buildDocument(companyId, 'proforma', b, { date: issueDate, session });
    const number = await nextDocumentNumber(companyId, 'proforma', session, issueDate); // série distincte des factures définitives
    const [c] = await Proforma.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil), lines: doc.lines,
      globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp,
      totals: doc.totals, notes: b.notes, terms: b.terms, deliveryTime: b.deliveryTime, ...frozenOf(doc), createdBy: userId }] as never[], { session });
    await logCycle(session, companyId, actor, [{ action: 'proforma_created', resourceId: c!._id, number, refs: [], description: 'Saisie directe' }]);
    return c!;
  });
  return toDto(p.toObject() as Lean);
}

export async function update(companyId: Id, id: string, b: Body) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const cur = (await Proforma.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    if (cur.status !== 'pending' || cur.invoiceId || await isEngaged(companyId, cur._id, session)) throw AppError.conflict('Proforma non modifiable : seule une proforma en cours, sans bon de livraison ni facture, peut être modifiée');
    const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
    const inherit = inheritFrom(cur, b.customerId);
    const doc = await buildDocument(companyId, 'proforma', { ...b, ...legacyDiscountOf(cur, b) }, { date: issueDate, session, ...(inherit && { inherit }) });
    // Les lignes conservées gardent leur identifiant et leur lien avec la ligne du devis
    const previous = new Map(cur.lines.map((l) => [String((l as { _id: Id })._id), l]));
    const lines = doc.lines.map((l, i) => { const old = previous.get(b.lines[i]?.id ?? ''); return old ? { ...l, _id: (old as { _id: Id })._id, ...(old.sourceLineId && { sourceLineId: old.sourceLineId }) } : l; });
    const u = await Proforma.findOneAndUpdate({ _id: id, companyId, status: 'pending', invoiceId: null, cycleRevision: cur.cycleRevision ?? null }, { $set: { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines, globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType ?? null, withholding: doc.withholding ?? null,
      stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, terms: b.terms, deliveryTime: b.deliveryTime ?? cur.deliveryTime, ...frozenOf(doc) }, $inc: { cycleRevision: 1 } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La proforma a changé entre-temps');
    return toDto(u as Lean);
  });
}

/** Transmission au client notée (remise en main propre, courrier…) : la proforma est « Envoyée ». */
export async function markSent(companyId: Id, id: string, d: { method: string; recipient?: string | undefined }, actor: CycleActor = {}) {
  await getOwn(companyId, id);
  await withTransaction(async (session) => {
    const p = await Proforma.findOneAndUpdate({ _id: id, companyId, status: 'pending' }, { $set: { sentAt: new Date(), sentByName: actor.name, sentMethod: d.method, sentTo: d.recipient ?? null } }, { returnDocument: 'after', session }).lean();
    if (!p) throw AppError.conflict('Seule une proforma en cours peut être marquée comme envoyée');
    await logCycle(session, companyId, actor, [{ action: 'proforma_sent', resourceId: p._id, number: p.number, refs: [p.quotationId], description: d.recipient ?? (d.method === 'email' ? 'E-mail' : 'Transmission notée') }]);
  });
  return get(companyId, id);
}

export async function remove(companyId: Id, id: string) {
  const p = await getOwn(companyId, id);
  if (p.status === 'converted' || p.invoiceId) throw AppError.conflict('Suppression impossible : proforma convertie en facture');
  if (p.quotationId) throw AppError.conflict('Suppression impossible : proforma issue d’un devis (annulez-la)');
  if (await DeliveryNote.exists({ companyId, 'source.id': p._id }) || await Invoice.exists({ companyId, proformaId: p._id })) throw AppError.conflict('Suppression impossible : des bons de livraison ou des factures en dépendent');
  const r = await Proforma.deleteOne({ _id: id, companyId, cycleRevision: p.cycleRevision ?? null });
  if (!r.deletedCount) throw AppError.conflict('La proforma a changé entre-temps');
  return p;
}

export async function stats(companyId: Id) {
  await expireOverdue(companyId);
  const rows = await Proforma.find({ companyId }).select('status totals.totalTtcMinor lines.quantity lines.deliveredQty lines.invoicedQty lines.netHtMinor lines.globalShareMinor').lean();
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const open = rows.filter((r) => r.status === 'pending').map((r) => { const lines = r.lines as unknown as CycleLine[]; return { delivery: progressOf(lines, (l) => l.deliveredQty ?? 0).state, billing: progressOf(lines, (l) => l.invoicedQty ?? 0).state, total: r.totals?.totalTtcMinor ?? 0 }; });
  return { total: rows.length, pending: count('pending'), converted: count('converted'), expired: count('expired'), cancelled: count('cancelled'), pendingTotalMinor: open.reduce((s, p) => s + p.total, 0),
    /** Parmi les proformas en cours. */
    toDeliver: open.filter((p) => p.delivery !== 'full').length, delivered: open.filter((p) => p.delivery === 'full').length, billed: open.filter((p) => p.billing === 'full').length };
}
