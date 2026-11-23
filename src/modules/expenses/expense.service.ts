import { z } from 'zod';
import type { QueryFilter, Types } from 'mongoose';
import { AccountingSettings, Expense, ExpenseCategory, TreasuryAccount, type ExpenseDoc } from '../../models/finance.model.js';
import { PAYMENT_METHODS } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex, objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureFinanceCounters } from '../../services/accounting.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { rangeFilter } from '../sales/document.http.js';
import { removeFile, storeFile } from './file-storage.js';

type Id = Types.ObjectId; type Lean = ExpenseDoc & { _id: Id; createdAt?: Date };

// ---------- Catégories ----------
export const categoryBody = z.object({ name: z.string().trim().min(2).max(80), accountCode: z.string().trim().max(30).optional(), isActive: z.boolean().optional() }).strict();
const catDto = (c: { _id: Id; name: string; accountCode?: string | null | undefined; isActive?: boolean | null | undefined }) => ({ id: c._id.toString(), name: c.name, accountCode: c.accountCode ?? null, isActive: c.isActive !== false });
export async function listCategories(companyId: Id, activeOnly = false) { return (await ExpenseCategory.find({ companyId, ...(activeOnly && { isActive: true }) }).sort({ name: 1 }).lean()).map(catDto); }
export async function createCategory(companyId: Id, b: z.infer<typeof categoryBody>) {
  try { return catDto((await ExpenseCategory.create({ ...b, companyId })).toObject()); } catch (e) { if ((e as { code?: number }).code === 11000) throw AppError.conflict('Cette catégorie existe déjà'); throw e; }
}
export async function updateCategory(companyId: Id, id: string, b: z.infer<typeof categoryBody>) {
  try { const c = await ExpenseCategory.findOneAndUpdate({ _id: id, companyId }, b, { returnDocument: 'after' }).lean(); if (!c) throw AppError.notFound('Catégorie introuvable'); return catDto(c); }
  catch (e) { if ((e as { code?: number }).code === 11000) throw AppError.conflict('Cette catégorie existe déjà'); throw e; }
}
export async function removeCategory(companyId: Id, id: string) {
  if (await Expense.exists({ companyId, categoryId: id })) throw AppError.conflict('Catégorie utilisée par des dépenses : désactivez-la plutôt');
  const r = await ExpenseCategory.deleteOne({ _id: id, companyId }); if (!r.deletedCount) throw AppError.notFound('Catégorie introuvable');
}

// ---------- Dépenses ----------
export const expenseBody = z.object({ categoryId: objectId, amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), date: z.coerce.date(), beneficiary: z.string().trim().min(2).max(150), method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(), description: z.string().trim().max(1000).optional(), treasuryAccountId: objectId.optional() }).strict();
type Body = z.infer<typeof expenseBody>;
export const toDto = (e: Lean) => ({ id: e._id.toString(), number: e.number, categoryId: e.categoryId.toString(), categoryName: e.categoryName ?? null, amountMinor: e.amountMinor, date: e.date, beneficiary: e.beneficiary, method: e.method, reference: e.reference ?? null, description: e.description ?? null,
  treasuryAccountId: e.treasuryAccountId?.toString() ?? null, status: e.status, editable: e.status === 'draft' || e.status === 'rejected', rejectReason: e.rejectReason ?? null, cancelReason: e.cancelReason ?? null,
  attachments: (e.attachments ?? []).map((a) => ({ id: (a as { _id: Id })._id.toString(), name: a.originalName ?? '', size: a.size ?? 0, uploadedAt: a.uploadedAt })), createdBy: e.createdBy?.toString() ?? null,
  submittedAt: e.submittedAt ?? null, validatedAt: e.validatedAt ?? null, validatedBy: e.validatedBy?.toString() ?? null, createdAt: e.createdAt });

export async function getOwn(companyId: Id, id: string) { const e = await Expense.findOne({ _id: id, companyId }).lean(); if (!e) throw AppError.notFound('Dépense introuvable'); return e as Lean; }
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));
const checkRefs = async (companyId: Id, b: Body) => {
  const cat = await ExpenseCategory.findOne({ _id: b.categoryId, companyId }).lean(); if (!cat) throw AppError.badRequest('Catégorie introuvable'); if (cat.isActive === false) throw AppError.badRequest('Catégorie désactivée');
  if (b.treasuryAccountId && !(await TreasuryAccount.exists({ _id: b.treasuryAccountId, companyId, isActive: true }))) throw AppError.badRequest('Compte de trésorerie introuvable ou inactif');
  if (startOfDay(b.date) > startOfDay(new Date())) throw AppError.badRequest('Date de dépense dans le futur');
  return cat;
};
export async function create(companyId: Id, userId: Id, b: Body) {
  const cat = await checkRefs(companyId, b); await ensureCounter(companyId, 'expense', startOfDay(b.date));
  return withTransaction(async (session) => {
    const number = await nextDocumentNumber(companyId, 'expense', session, startOfDay(b.date));
    const [e] = await Expense.create([{ ...b, companyId, number, date: startOfDay(b.date), categoryName: cat.name, categoryAccountCode: cat.accountCode, createdBy: userId }] as never[], { session });
    return toDto(e!.toObject() as Lean);
  });
}
/** Une dépense validée (ou annulée) n'est JAMAIS modifiable directement : correction = annulation (mouvement inverse) puis nouvelle saisie. */
export async function update(companyId: Id, id: string, b: Body) {
  const cat = await checkRefs(companyId, b);
  const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: { $in: ['draft', 'rejected'] } }, { $set: { ...b, date: startOfDay(b.date), categoryName: cat.name, categoryAccountCode: cat.accountCode ?? null, status: 'draft', rejectReason: null } }, { returnDocument: 'after' }).lean();
  if (!e) { await getOwn(companyId, id); throw AppError.conflict('Dépense non modifiable : seules les dépenses en brouillon ou rejetées le sont'); }
  return toDto(e as Lean);
}
export async function remove(companyId: Id, id: string) {
  const e = await Expense.findOneAndDelete({ _id: id, companyId, status: 'draft' }).lean(); if (!e) { await getOwn(companyId, id); throw AppError.conflict('Seul un brouillon peut être supprimé'); }
  for (const a of e.attachments) if (a.storedName) await removeFile(companyId, 'expenses', a.storedName); return e as Lean;
}
export async function submit(companyId: Id, userId: Id, id: string) {
  const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'submitted', submittedAt: new Date(), submittedBy: userId }, { returnDocument: 'after' }).lean();
  if (!e) { await getOwn(companyId, id); throw AppError.conflict('Seul un brouillon peut être soumis'); } return toDto(e as Lean);
}
export async function reject(companyId: Id, userId: Id, id: string, reason: string) {
  const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: 'submitted' }, { status: 'rejected', rejectedAt: new Date(), rejectedBy: userId, rejectReason: reason }, { returnDocument: 'after' }).lean();
  if (!e) { await getOwn(companyId, id); throw AppError.conflict('Seule une dépense soumise peut être rejetée'); } return toDto(e as Lean);
}
/** Validation : séparation des tâches (le créateur ne valide pas sa propre dépense, sauf option société), compte de trésorerie obligatoire, mouvement de trésorerie + écriture dans la même transaction. */
export async function validate(companyId: Id, userId: Id, id: string) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const cur = await Expense.findOne({ _id: id, companyId }).session(session).lean(); if (!cur) throw AppError.notFound('Dépense introuvable');
    if (cur.status !== 'submitted') throw AppError.conflict('Seule une dépense soumise peut être validée');
    const st = await AccountingSettings.findOne({ companyId }).session(session).lean();
    if (!st?.allowExpenseSelfValidation && String(cur.createdBy) === String(userId)) throw AppError.forbidden('Séparation des tâches : vous ne pouvez pas valider une dépense que vous avez saisie');
    if (!cur.treasuryAccountId) throw AppError.badRequest('Compte de trésorerie (caisse ou banque) requis pour valider la dépense');
    const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: 'submitted' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId }, { returnDocument: 'after', session }).lean();
    if (!e) throw AppError.conflict('La dépense a changé entre-temps');
    await emitDomainEvent('expense.validated', { companyId, documentId: e._id, session, userId, documentNumber: e.number });
    return toDto(e as Lean);
  });
}
/** Assigne / change le compte de trésorerie d'une dépense soumise (avant validation). */
export async function cancel(companyId: Id, userId: Id, id: string, reason: string) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: 'validated' }, { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!e) { await getOwn(companyId, id); throw AppError.conflict('Seule une dépense validée peut être annulée'); }
    await emitDomainEvent('expense.cancelled', { companyId, documentId: e._id, session, userId, documentNumber: e.number }); // 409 si le mouvement est rapproché
    return toDto(e as Lean);
  });
}
export async function addAttachment(companyId: Id, id: string, file: { originalname: string; buffer: Buffer; size: number }) {
  const cur = await getOwn(companyId, id); if (!['draft', 'rejected', 'submitted'].includes(cur.status)) throw AppError.conflict('Justificatifs non modifiables après validation');
  if (cur.attachments.length >= 10) throw AppError.conflict('10 justificatifs maximum');
  const f = await storeFile(companyId, 'expenses', file);
  const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: { $in: ['draft', 'rejected', 'submitted'] } }, { $push: { attachments: { originalName: f.originalName, storedName: f.storedName, ext: f.ext, size: f.size, uploadedAt: new Date() } } }, { returnDocument: 'after' }).lean();
  if (!e) { await removeFile(companyId, 'expenses', f.storedName); throw AppError.conflict('La dépense a changé entre-temps'); } return toDto(e as Lean);
}
export async function removeAttachment(companyId: Id, id: string, attId: string) {
  const cur = await getOwn(companyId, id); if (!['draft', 'rejected', 'submitted'].includes(cur.status)) throw AppError.conflict('Justificatifs non modifiables après validation');
  const a = cur.attachments.find((x) => String((x as { _id: Id })._id) === attId); if (!a) throw AppError.notFound('Justificatif introuvable');
  const e = await Expense.findOneAndUpdate({ _id: id, companyId, status: { $in: ['draft', 'rejected', 'submitted'] } }, { $pull: { attachments: { _id: attId } } }, { returnDocument: 'after' }).lean();
  if (a.storedName) await removeFile(companyId, 'expenses', a.storedName); return toDto(e as Lean);
}
export async function attachmentFile(companyId: Id, id: string, attId: string) {
  const { filePath } = await import('./file-storage.js'); const cur = await getOwn(companyId, id); const a = cur.attachments.find((x) => String((x as { _id: Id })._id) === attId); if (!a?.storedName) throw AppError.notFound('Justificatif introuvable');
  return { path: filePath(companyId, 'expenses', a.storedName), name: a.originalName ?? 'justificatif' };
}

export interface ListFilter { q?: string | undefined; status?: string | undefined; categoryId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }
const filterOf = (companyId: Id, f: Pick<ListFilter, 'q' | 'status' | 'categoryId' | 'from' | 'to'>) => {
  const filter: QueryFilter<ExpenseDoc> = { companyId }; if (f.status) filter.status = f.status as never; if (f.categoryId) filter.categoryId = f.categoryId as never; const r = rangeFilter(f.from, f.to); if (r) filter.date = r;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { beneficiary: rx }, { reference: rx }, { description: rx }]; } return filter;
};
export async function list(companyId: Id, f: ListFilter) {
  const filter = filterOf(companyId, f);
  const [items, total] = await Promise.all([Expense.find(filter).sort(buildSort(f.sort, ['number', 'date', 'amountMinor', 'createdAt'], { date: -1, _id: -1 })).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Expense.countDocuments(filter)]);
  return { items: items.map((e) => toDto(e as Lean)), total, page: f.page, limit: f.limit };
}
export async function listAll(companyId: Id, f: Omit<ListFilter, 'page' | 'limit'>) { return (await Expense.find(filterOf(companyId, f)).sort({ date: 1, _id: 1 }).limit(20000).lean()).map((e) => toDto(e as Lean)); }
/** Synthèse des dépenses VALIDÉES par catégorie et par mois. */
export async function summary(companyId: Id, f: { from?: Date | undefined; to?: Date | undefined }) {
  const match: Record<string, unknown> = { companyId, status: 'validated' }; const r = rangeFilter(f.from, f.to); if (r) match.date = r;
  const [byCategory, byMonth] = await Promise.all([
    Expense.aggregate<{ _id: string; categoryName: string; totalMinor: number; count: number }>([{ $match: match }, { $group: { _id: '$categoryId', categoryName: { $first: '$categoryName' }, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { totalMinor: -1 } }]),
    Expense.aggregate<{ _id: string; totalMinor: number; count: number }>([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  return { totalMinor: byCategory.reduce((s, c) => s + c.totalMinor, 0), count: byCategory.reduce((s, c) => s + c.count, 0), byCategory: byCategory.map((c) => ({ categoryId: String(c._id), categoryName: c.categoryName, totalMinor: c.totalMinor, count: c.count })), byMonth: byMonth.map((m) => ({ month: m._id, totalMinor: m.totalMinor, count: m.count })) };
}
