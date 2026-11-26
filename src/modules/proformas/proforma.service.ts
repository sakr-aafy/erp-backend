import { Types, type QueryFilter } from 'mongoose';
import { Proforma, DeliveryNote, type ProformaDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { buildDocument, frozenOf, inheritFrom, linesToInput, type DocInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import * as invoices from '../invoices/invoice.service.js';

type Id = Types.ObjectId;
type Lean = ProformaDoc & { _id: Id; createdAt?: Date };

export const toDto = (p: Lean) => ({
  id: p._id.toString(), number: p.number, status: p.status, customerId: p.customerId.toString(), customer: p.customerSnapshot, issueDate: p.issueDate, validUntil: p.validUntil,
  lines: p.lines.map((l) => ({ ...l, id: (l as { _id: Id })._id.toString() })), globalDiscountPct: p.globalDiscountPct, globalDiscountMinor: p.globalDiscountMinor,
  withholdingOperationType: p.withholdingOperationType ?? null, totals: p.totals, notes: p.notes ?? null, terms: p.terms ?? null, paymentTerms: p.paymentTerms ?? null, paymentTermsCustom: !!p.paymentTermsCustom, deliveryAddress: snapshotDto(p.deliveryAddress as never),
  quotationId: p.quotationId?.toString() ?? null, invoiceId: p.invoiceId?.toString() ?? null, sentAt: p.sentAt ?? null, createdAt: p.createdAt,
  editable: p.status === 'pending' && !p.invoiceId,
});

export async function expireOverdue(companyId?: Id) {
  return (await Proforma.updateMany({ ...(companyId && { companyId }), status: 'pending', validUntil: { $lt: startOfDay(new Date()) } }, { status: 'expired' })).modifiedCount;
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  await expireOverdue(companyId);
  const filter: QueryFilter<ProformaDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }]; }
  const sort = buildSort(f.sort, ['number', 'issueDate', 'validUntil', 'createdAt'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Proforma.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Proforma.countDocuments(filter)]);
  return { items: items.map((p) => ({ ...toDto({ ...p, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const p = await Proforma.findOne({ _id: id, companyId }).lean();
  if (!p) throw AppError.notFound('Facture proforma introuvable');
  return p as Lean;
}
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

type Body = DocInput & { issueDate?: Date | undefined; validUntil: Date; notes?: string | undefined; terms?: string | undefined };

export async function create(companyId: Id, userId: Id, b: Body) {
  const issueDate = startOfDay(b.issueDate ?? new Date());
  await ensureCounter(companyId, 'proforma', issueDate);
  const p = await withTransaction(async (session) => {
    const doc = await buildDocument(companyId, 'proforma', b, { date: issueDate, session });
    const number = await nextDocumentNumber(companyId, 'proforma', session, issueDate); // série distincte des factures définitives
    const [c] = await Proforma.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil), lines: doc.lines,
      globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp,
      totals: doc.totals, notes: b.notes, terms: b.terms, ...frozenOf(doc), createdBy: userId }] as never[], { session });
    return c!;
  });
  return toDto(p.toObject() as Lean);
}

export async function update(companyId: Id, id: string, b: Body) {
  const cur = await getOwn(companyId, id);
  if (!toDto(cur).editable) throw AppError.conflict('Seule une proforma en attente et non convertie est modifiable');
  const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
  return withTransaction(async (session) => {
    const inherit = inheritFrom(cur, b.customerId);
    const doc = await buildDocument(companyId, 'proforma', b, { date: issueDate, session, ...(inherit && { inherit }) });
    const u = await Proforma.findOneAndUpdate({ _id: id, companyId, status: 'pending', invoiceId: null }, { $set: { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType ?? null, withholding: doc.withholding ?? null,
      stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, terms: b.terms, ...frozenOf(doc) } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La proforma a changé entre-temps');
    return toDto(u as Lean);
  });
}

export async function cancel(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const u = await Proforma.findOneAndUpdate({ _id: id, companyId, status: 'pending', invoiceId: null }, { status: 'cancelled', cancelledAt: new Date() }, { returnDocument: 'after' }).lean();
  if (!u) { const c = await getOwn(companyId, id); throw AppError.conflict(`Annulation impossible depuis le statut « ${c.status} »`); }
  return toDto(u as Lean);
}
export async function remove(companyId: Id, id: string) {
  const p = await getOwn(companyId, id);
  if (p.status === 'converted' || p.invoiceId) throw AppError.conflict('Suppression impossible : proforma convertie en facture');
  if (p.quotationId) throw AppError.conflict('Suppression impossible : proforma issue d’un devis (annulez-la)');
  if (await DeliveryNote.exists({ companyId, 'source.id': p._id })) throw AppError.conflict('Suppression impossible : des bons de livraison en dépendent');
  await Proforma.deleteOne({ _id: id, companyId }); return p;
}

/** Proforma → facture (brouillon). Passe à « convertie ». */
export async function convertToInvoice(companyId: Id, userId: Id, id: string) {
  return withTransaction(async (session) => {
    const p = (await Proforma.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!p) throw AppError.notFound('Facture proforma introuvable');
    if (p.status !== 'pending') throw AppError.conflict(`Conversion impossible : proforma « ${p.status} »`);
    if (p.validUntil < startOfDay(new Date())) throw AppError.conflict('Conversion impossible : proforma expirée');
    if (await DeliveryNote.exists({ companyId, 'source.id': p._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour cette proforma : facturez-les');
    const inv = await invoices.createDraft(companyId, userId, { customerId: p.customerId, lines: linesToInput(p.lines), globalDiscountPct: p.globalDiscountPct ?? 0, globalDiscountMinor: p.globalDiscountMinor ?? 0,
      withholdingOperationType: p.withholdingOperationType ?? undefined, notes: p.notes ?? undefined }, { proformaId: p._id, ...(p.quotationId && { quotationId: p.quotationId }), inherit: inheritFrom(p, p.customerId) }, session);
    await Proforma.updateOne({ _id: p._id }, { status: 'converted', invoiceId: new Types.ObjectId(inv.id) }, { session });
    return { invoiceId: inv.id };
  });
}

export async function stats(companyId: Id) {
  await expireOverdue(companyId);
  const rows = await Proforma.aggregate<{ _id: string; n: number; totalMinor: number }>([{ $match: { companyId } }, { $group: { _id: '$status', n: { $sum: 1 }, totalMinor: { $sum: '$totals.totalTtcMinor' } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r])) as Record<string, { n: number; totalMinor: number }>;
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { total, pending: by['pending']?.n ?? 0, converted: by['converted']?.n ?? 0, expired: by['expired']?.n ?? 0, cancelled: by['cancelled']?.n ?? 0,
    pendingTotalMinor: by['pending']?.totalMinor ?? 0, conversionRatePct: total ? Math.round(((by['converted']?.n ?? 0) / total) * 10000) / 100 : 0 };
}
