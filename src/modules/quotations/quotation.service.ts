import { Types, type QueryFilter } from 'mongoose';
import { Quotation, Proforma, DeliveryNote, type QuotationDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { buildDocument, linesToInput, type DocInput } from '../sales/document.builder.js';
import { rangeFilter } from '../sales/document.http.js';
import * as invoices from '../invoices/invoice.service.js';

type Id = Types.ObjectId;
type Lean = QuotationDoc & { _id: Id; createdAt?: Date };

export const toDto = (q: Lean) => ({
  id: q._id.toString(), number: q.number, status: q.status, customerId: q.customerId.toString(), customer: q.customerSnapshot, issueDate: q.issueDate, validUntil: q.validUntil,
  lines: q.lines.map((l) => ({ ...l, id: (l as { _id: Id })._id.toString(), vat: l.vat })), globalDiscountPct: q.globalDiscountPct, globalDiscountMinor: q.globalDiscountMinor,
  withholdingOperationType: q.withholdingOperationType ?? null, totals: q.totals, notes: q.notes ?? null, terms: q.terms ?? null,
  proformaId: q.proformaId?.toString() ?? null, invoiceId: q.invoiceId?.toString() ?? null, sentAt: q.sentAt ?? null, createdAt: q.createdAt,
  editable: q.status === 'pending' && !q.proformaId && !q.invoiceId,
});

/** Passage automatique en « expiré » après la date de validité (persistant). Appelé à chaque lecture et périodiquement (server.ts). */
export async function expireOverdue(companyId?: Id) {
  const r = await Quotation.updateMany({ ...(companyId && { companyId }), status: 'pending', validUntil: { $lt: startOfDay(new Date()) } }, { status: 'expired' });
  return r.modifiedCount;
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  await expireOverdue(companyId);
  const filter: QueryFilter<QuotationDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }]; }
  const sort = buildSort(f.sort, ['number', 'issueDate', 'validUntil', 'createdAt'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Quotation.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Quotation.countDocuments(filter)]);
  return { items: items.map((q) => ({ ...toDto({ ...q, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}

export async function getOwn(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const q = await Quotation.findOne({ _id: id, companyId }).lean();
  if (!q) throw AppError.notFound('Devis introuvable');
  return q as Lean;
}
export const get = async (companyId: Id, id: string) => toDto(await getOwn(companyId, id));

type Body = DocInput & { issueDate?: Date | undefined; validUntil: Date; notes?: string | undefined; terms?: string | undefined };

export async function create(companyId: Id, userId: Id, b: Body) {
  const issueDate = startOfDay(b.issueDate ?? new Date());
  await ensureCounter(companyId, 'quotation', issueDate);
  const q = await withTransaction(async (session) => {
    const doc = await buildDocument(companyId, 'quotation', b, { date: issueDate, session });
    const number = await nextDocumentNumber(companyId, 'quotation', session, issueDate);
    const [created] = await Quotation.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType,
      withholding: doc.withholding, stamp: doc.stamp, totals: doc.totals, notes: b.notes, terms: b.terms, createdBy: userId }] as never[], { session });
    return created!;
  });
  return toDto(q.toObject() as Lean);
}

export async function update(companyId: Id, id: string, b: Body) {
  const cur = await getOwn(companyId, id);
  const dto = toDto(cur); if (!dto.editable) throw AppError.conflict('Seul un devis en attente et non converti est modifiable');
  const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
  return withTransaction(async (session) => {
    const doc = await buildDocument(companyId, 'quotation', b, { date: issueDate, session });
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: 'pending', proformaId: null, invoiceId: null }, { $set: { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType ?? null,
      withholding: doc.withholding ?? null, stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, terms: b.terms } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le devis a changé entre-temps');
    return toDto(u as Lean);
  });
}

export async function remove(companyId: Id, id: string) {
  const q = await getOwn(companyId, id);
  if (q.proformaId || q.invoiceId) throw AppError.conflict('Suppression impossible : le devis a été converti');
  if (q.status === 'accepted') throw AppError.conflict('Suppression impossible : devis accepté');
  if (await DeliveryNote.exists({ companyId, 'source.id': q._id })) throw AppError.conflict('Suppression impossible : des bons de livraison en dépendent');
  await Quotation.deleteOne({ _id: id, companyId }); return q;
}

async function transition(companyId: Id, id: string, to: 'accepted' | 'refused') {
  await expireOverdue(companyId);
  const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: 'pending' }, { status: to, [to === 'accepted' ? 'acceptedAt' : 'refusedAt']: new Date() }, { returnDocument: 'after' }).lean();
  if (!u) { const c = await getOwn(companyId, id); throw AppError.conflict(`Transition impossible depuis le statut « ${c.status} »`); }
  return toDto(u as Lean);
}
export const accept = (c: Id, id: string) => transition(c, id, 'accepted');
export const refuse = (c: Id, id: string) => transition(c, id, 'refused');

/** Duplication : nouveau devis en attente, numéro propre, TVA résolue à la date du jour. */
export async function duplicate(companyId: Id, userId: Id, id: string) {
  const src = await getOwn(companyId, id);
  const days = Math.max(1, Math.round((src.validUntil.getTime() - src.issueDate.getTime()) / 86400000));
  const today = startOfDay(new Date());
  return create(companyId, userId, { customerId: src.customerId, lines: linesToInput(src.lines), globalDiscountPct: src.globalDiscountPct ?? 0, globalDiscountMinor: src.globalDiscountMinor ?? 0,
    withholdingOperationType: src.withholdingOperationType ?? undefined, issueDate: today, validUntil: new Date(today.getTime() + days * 86400000), notes: src.notes ?? undefined, terms: src.terms ?? undefined });
}

function assertConvertible(q: Lean) {
  if (q.status !== 'pending' && q.status !== 'accepted') throw AppError.conflict(`Conversion impossible : devis « ${q.status === 'refused' ? 'refusé' : 'expiré'} »`);
  if (q.proformaId || q.invoiceId) throw AppError.conflict('Ce devis a déjà été converti');
}

/** Devis → proforma. Le devis passe à « accepté ». */
export async function convertToProforma(companyId: Id, userId: Id, id: string, validUntil?: Date) {
  await ensureCounter(companyId, 'proforma', startOfDay(new Date()));
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) throw AppError.notFound('Devis introuvable');
    assertConvertible(q);
    if (await DeliveryNote.exists({ companyId, 'source.id': q._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour ce devis : facturez-les');
    const today = startOfDay(new Date());
    const days = Math.max(1, Math.round((q.validUntil.getTime() - q.issueDate.getTime()) / 86400000));
    const doc = await buildDocument(companyId, 'proforma', { customerId: q.customerId, lines: linesToInput(q.lines), globalDiscountPct: q.globalDiscountPct ?? 0, globalDiscountMinor: q.globalDiscountMinor ?? 0, withholdingOperationType: q.withholdingOperationType }, { date: today, session });
    const number = await nextDocumentNumber(companyId, 'proforma', session, today);
    const [p] = await Proforma.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate: today, validUntil: validUntil ? startOfDay(validUntil) : new Date(today.getTime() + days * 86400000),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp,
      totals: doc.totals, quotationId: q._id, notes: q.notes, terms: q.terms, createdBy: userId }] as never[], { session });
    await Quotation.updateOne({ _id: q._id }, { status: 'accepted', acceptedAt: q.status === 'accepted' ? undefined : new Date(), proformaId: p!._id }, { session });
    return { proformaId: p!._id.toString(), number };
  });
}

/** Devis → facture (brouillon). Le devis passe à « accepté ». */
export async function convertToInvoice(companyId: Id, userId: Id, id: string) {
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) throw AppError.notFound('Devis introuvable');
    assertConvertible(q);
    if (await DeliveryNote.exists({ companyId, 'source.id': q._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour ce devis : facturez-les');
    const inv = await invoices.createDraft(companyId, userId, { customerId: q.customerId, lines: linesToInput(q.lines), globalDiscountPct: q.globalDiscountPct ?? 0, globalDiscountMinor: q.globalDiscountMinor ?? 0,
      withholdingOperationType: q.withholdingOperationType ?? undefined, notes: q.notes ?? undefined }, { quotationId: q._id }, session);
    await Quotation.updateOne({ _id: q._id }, { status: 'accepted', ...(q.status === 'pending' && { acceptedAt: new Date() }), invoiceId: new Types.ObjectId(inv.id) }, { session });
    return { invoiceId: inv.id };
  });
}

/** Taux de conversion devis → facture et devis en cours (rapports du module). */
export async function stats(companyId: Id) {
  await expireOverdue(companyId);
  const rows = await Quotation.aggregate<{ _id: string; n: number; totalMinor: number }>([{ $match: { companyId } }, { $group: { _id: '$status', n: { $sum: 1 }, totalMinor: { $sum: '$totals.totalTtcMinor' } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r])) as Record<string, { n: number; totalMinor: number }>;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const invoiced = await Quotation.countDocuments({ companyId, invoiceId: { $ne: null } });
  // Un devis converti en proforma puis facturé compte comme converti en facture
  const viaProforma = await Proforma.countDocuments({ companyId, quotationId: { $ne: null }, invoiceId: { $ne: null } });
  return { total, pending: by['pending']?.n ?? 0, accepted: by['accepted']?.n ?? 0, refused: by['refused']?.n ?? 0, expired: by['expired']?.n ?? 0,
    pendingTotalMinor: by['pending']?.totalMinor ?? 0, invoiced: invoiced + viaProforma, conversionRatePct: total ? Math.round(((invoiced + viaProforma) / total) * 10000) / 100 : 0 };
}
