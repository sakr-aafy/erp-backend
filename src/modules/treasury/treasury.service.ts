import { z } from 'zod';
import type { QueryFilter, Types } from 'mongoose';
import { BankReconciliation, TreasuryAccount, TreasuryMovement, TreasuryTransfer, type TreasuryAccountDoc, type TreasuryMovementDoc } from '../../models/finance.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureFinanceCounters } from '../../services/accounting.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { rangeFilter } from '../sales/document.http.js';

type Id = Types.ObjectId;
const signed = (m: { direction: string; amountMinor: number }) => (m.direction === 'in' ? m.amountMinor : -m.amountMinor);

// ---------- Comptes ----------
export const accountBody = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().min(2).max(100), type: z.enum(['bank', 'cash']), bankName: z.string().trim().max(100).optional(), iban: z.string().trim().max(40).optional(),
  accountCode: z.string().trim().max(30).optional(), openingBalanceMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0), allowNegative: z.boolean().default(false),
}).strict();
export const accountUpdateBody = accountBody.partial().omit({ type: true }).strict();
export const accountDto = (a: TreasuryAccountDoc & { _id: Id }) => ({ id: a._id.toString(), code: a.code, name: a.name, type: a.type, bankName: a.bankName ?? null, iban: a.iban ?? null, accountCode: a.accountCode ?? null,
  openingBalanceMinor: a.openingBalanceMinor ?? 0, balanceMinor: a.balanceMinor ?? 0, allowNegative: !!a.allowNegative, isActive: !!a.isActive, lastReconciledDate: a.lastReconciledDate ?? null, lastReconciledBalanceMinor: a.lastReconciledBalanceMinor ?? null });

export async function listAccounts(companyId: Id, f: { type?: string | undefined; active?: boolean | undefined } = {}) {
  const filter: QueryFilter<TreasuryAccountDoc> = { companyId }; if (f.type) filter.type = f.type as never; if (f.active !== undefined) filter.isActive = f.active;
  return (await TreasuryAccount.find(filter).sort({ type: 1, code: 1 }).lean()).map((a) => accountDto(a as never));
}
export async function createAccount(companyId: Id, b: z.infer<typeof accountBody>) {
  try { return accountDto((await TreasuryAccount.create({ ...b, companyId, balanceMinor: b.openingBalanceMinor })).toObject() as never); }
  catch (e) { if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ce code de compte existe déjà'); throw e; }
}
export async function updateAccount(companyId: Id, id: string, b: z.infer<typeof accountUpdateBody>) {
  const a = await TreasuryAccount.findOne({ _id: id, companyId }); if (!a) throw AppError.notFound('Compte introuvable');
  const set: Record<string, unknown> = { ...b }; delete set.openingBalanceMinor;
  let inc = 0;
  if (b.openingBalanceMinor !== undefined && b.openingBalanceMinor !== a.openingBalanceMinor) {
    if (await TreasuryMovement.exists({ companyId, accountId: a._id })) throw AppError.conflict('Solde d’ouverture non modifiable : le compte a déjà des mouvements');
    set.openingBalanceMinor = b.openingBalanceMinor; inc = b.openingBalanceMinor - (a.openingBalanceMinor ?? 0);
  }
  try { const u = await TreasuryAccount.findOneAndUpdate({ _id: id, companyId }, { $set: set, ...(inc && { $inc: { balanceMinor: inc } }) }, { returnDocument: 'after' }).lean(); return accountDto(u as never); }
  catch (e) { if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ce code de compte existe déjà'); throw e; }
}
export async function setAccountActive(companyId: Id, id: string, active: boolean) {
  const u = await TreasuryAccount.findOneAndUpdate({ _id: id, companyId }, { isActive: active }, { returnDocument: 'after' }).lean(); if (!u) throw AppError.notFound('Compte introuvable'); return accountDto(u as never);
}
export async function position(companyId: Id) {
  const accounts = await listAccounts(companyId);
  const sum = (t: string) => accounts.filter((a) => a.type === t).reduce((s, a) => s + a.balanceMinor, 0);
  const unreconciled = await TreasuryMovement.aggregate<{ _id: Id; n: number }>([{ $match: { companyId, reconciledAt: null } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }]);
  const un = new Map(unreconciled.map((u) => [String(u._id), u.n]));
  return { accounts: accounts.map((a) => ({ ...a, unreconciledCount: a.type === 'bank' ? un.get(a.id) ?? 0 : null })), bankMinor: sum('bank'), cashMinor: sum('cash'), totalMinor: sum('bank') + sum('cash') };
}

// ---------- Mouvements ----------
const mvDto = (m: TreasuryMovementDoc & { _id: Id }, names?: Map<string, string>) => ({ id: m._id.toString(), accountId: m.accountId.toString(), accountName: names?.get(String(m.accountId)) ?? null, direction: m.direction, amountMinor: m.amountMinor, signedMinor: signed(m), date: m.date,
  kind: m.kind, label: m.label, source: m.source?.type ? { type: m.source.type, id: String(m.source.id), number: m.source.number ?? null } : null, thirdParty: m.thirdParty?.type ? { type: m.thirdParty.type, id: String(m.thirdParty.id), name: m.thirdParty.name ?? null } : null,
  method: m.method ?? null, reference: m.reference ?? null, balanceAfterMinor: m.balanceAfterMinor ?? null, reversalOf: m.reversalOf?.toString() ?? null, reversed: !!m.reversedById, reconciled: !!m.reconciledAt, reconciledAt: m.reconciledAt ?? null, reconciliationId: m.reconciliationId?.toString() ?? null });
export interface MovementFilter { accountId?: string | undefined; direction?: string | undefined; kind?: string | undefined; reconciled?: boolean | undefined; from?: Date | undefined; to?: Date | undefined; sourceId?: string | undefined; q?: string | undefined; page?: number; limit?: number }
const mvFilter = (companyId: Id, f: MovementFilter) => {
  const filter: QueryFilter<TreasuryMovementDoc> = { companyId };
  if (f.accountId) filter.accountId = f.accountId as never; if (f.direction) filter.direction = f.direction as never; if (f.kind) filter.kind = f.kind as never; if (f.sourceId) filter['source.id'] = f.sourceId as never;
  if (f.reconciled !== undefined) filter.reconciledAt = f.reconciled ? { $ne: null } : null; const r = rangeFilter(f.from, f.to); if (r) filter.date = r;
  if (f.q) filter.label = new RegExp(f.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return filter;
};
export async function listMovements(companyId: Id, f: MovementFilter) {
  const filter = mvFilter(companyId, f); const page = f.page ?? 1; const limit = f.limit ?? 20;
  const [items, total, accs] = await Promise.all([TreasuryMovement.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), TreasuryMovement.countDocuments(filter), TreasuryAccount.find({ companyId }).select('name').lean()]);
  const names = new Map(accs.map((a) => [String(a._id), a.name]));
  return { items: items.map((m) => mvDto(m as never, names)), total, page, limit };
}
export async function allMovements(companyId: Id, f: MovementFilter) {
  const accs = await TreasuryAccount.find({ companyId }).select('name').lean(); const names = new Map(accs.map((a) => [String(a._id), a.name]));
  return (await TreasuryMovement.find(mvFilter(companyId, f)).sort({ date: 1, _id: 1 }).limit(20000).lean()).map((m) => mvDto(m as never, names));
}
/** Relevé d'un compte sur une période : solde d'ouverture de période, mouvements, solde de clôture. */
export async function statement(companyId: Id, accountId: string, from?: Date, to?: Date) {
  const acc = await TreasuryAccount.findOne({ _id: accountId, companyId }).lean(); if (!acc) throw AppError.notFound('Compte introuvable');
  const before = from ? await TreasuryMovement.aggregate<{ s: number }>([{ $match: { companyId: acc.companyId, accountId: acc._id, date: { $lt: from } } }, { $group: { _id: null, s: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', { $multiply: ['$amountMinor', -1] }] } } } }]) : [];
  const opening = (acc.openingBalanceMinor ?? 0) + (before[0]?.s ?? 0);
  const rows = await allMovements(companyId, { accountId, ...(from && { from }), ...(to && { to }) });
  let run = opening; const lines = rows.map((m) => { run += m.signedMinor; return { ...m, runningMinor: run }; });
  return { account: accountDto(acc as never), openingMinor: opening, closingMinor: run, totalInMinor: rows.filter((m) => m.direction === 'in').reduce((s, m) => s + m.amountMinor, 0), totalOutMinor: rows.filter((m) => m.direction === 'out').reduce((s, m) => s + m.amountMinor, 0), lines };
}

// ---------- Virements internes ----------
export const transferBody = z.object({ fromAccountId: objectId, toAccountId: objectId, amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), date: z.coerce.date().optional(), note: z.string().trim().max(300).optional() }).strict();
const trDto = (t: { _id: Id; number: string; fromAccountId: Id; toAccountId: Id; amountMinor: number; date: Date; note?: string | null | undefined; status: string; cancelReason?: string | null | undefined }) => ({ id: t._id.toString(), number: t.number, fromAccountId: t.fromAccountId.toString(), toAccountId: t.toAccountId.toString(), amountMinor: t.amountMinor, date: t.date, note: t.note ?? null, status: t.status, cancelReason: t.cancelReason ?? null });
export async function createTransfer(companyId: Id, userId: Id, b: z.infer<typeof transferBody>) {
  if (b.fromAccountId === b.toAccountId) throw AppError.badRequest('Les comptes source et destination doivent être différents');
  const date = startOfDay(b.date ?? new Date()); if (date > startOfDay(new Date())) throw AppError.badRequest('Date de virement dans le futur');
  await ensureCounter(companyId, 'treasuryTransfer', date); await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const number = await nextDocumentNumber(companyId, 'treasuryTransfer', session, date);
    const [t] = await TreasuryTransfer.create([{ companyId, number, fromAccountId: b.fromAccountId, toAccountId: b.toAccountId, amountMinor: b.amountMinor, date, note: b.note, createdBy: userId }] as never[], { session });
    await emitDomainEvent('treasuryTransfer.recorded', { companyId, documentId: t!._id, session, userId, documentNumber: number });
    return trDto(t!.toObject() as never);
  });
}
export async function cancelTransfer(companyId: Id, userId: Id, id: string, reason: string) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const t = await TreasuryTransfer.findOneAndUpdate({ _id: id, companyId, status: 'active' }, { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!t) throw AppError.conflict('Virement introuvable ou déjà annulé');
    await emitDomainEvent('treasuryTransfer.cancelled', { companyId, documentId: t._id, session, userId, documentNumber: t.number });
    return trDto(t as never);
  });
}
export async function listTransfers(companyId: Id, f: { page: number; limit: number; accountId?: string | undefined }) {
  const filter: QueryFilter<typeof TreasuryTransfer extends never ? never : Record<string, unknown>> = { companyId }; if (f.accountId) (filter as Record<string, unknown>).$or = [{ fromAccountId: f.accountId }, { toAccountId: f.accountId }];
  const [items, total] = await Promise.all([TreasuryTransfer.find(filter as never).sort({ date: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), TreasuryTransfer.countDocuments(filter as never)]);
  return { items: items.map((t) => trDto(t as never)), total, page: f.page, limit: f.limit };
}

// ---------- Rapprochement bancaire ----------
export const reconcileBody = z.object({ accountId: objectId, statementDate: z.coerce.date(), statementBalanceMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), movementIds: z.array(objectId).min(1).max(5000), note: z.string().trim().max(300).optional() }).strict();
const reconciledSum = async (companyId: Id, accountId: Id) => (await TreasuryMovement.aggregate<{ s: number }>([{ $match: { companyId, accountId, reconciledAt: { $ne: null } } }, { $group: { _id: null, s: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', { $multiply: ['$amountMinor', -1] }] } } } }]))[0]?.s ?? 0;
/** Mouvements à pointer + point de départ (solde du dernier relevé rapproché). */
export async function candidates(companyId: Id, accountId: string) {
  const acc = await TreasuryAccount.findOne({ _id: accountId, companyId }).lean(); if (!acc) throw AppError.notFound('Compte introuvable');
  const previous = (acc.openingBalanceMinor ?? 0) + await reconciledSum(companyId, acc._id);
  const items = (await TreasuryMovement.find({ companyId, accountId: acc._id, reconciledAt: null }).sort({ date: 1, _id: 1 }).lean()).map((m) => mvDto(m as never));
  return { account: accountDto(acc as never), previousBalanceMinor: previous, lastReconciledDate: acc.lastReconciledDate ?? null, items };
}
const recDto = (r: { _id: Id; number: string; accountId: Id; statementDate: Date; statementBalanceMinor: number; previousBalanceMinor: number; totalMinor: number; movementIds: Id[]; note?: string | null | undefined; createdAt?: Date }) => ({ id: r._id.toString(), number: r.number, accountId: r.accountId.toString(), statementDate: r.statementDate, statementBalanceMinor: r.statementBalanceMinor,
  previousBalanceMinor: r.previousBalanceMinor, totalMinor: r.totalMinor, movementCount: r.movementIds.length, note: r.note ?? null, createdAt: r.createdAt });
/**
 * Validation d'un rapprochement : solde du relevé = solde précédent rapproché + Σ mouvements pointés (écart = 0 exigé).
 * DÉFINITIF : les mouvements pointés sont verrouillés (ni annulation de l'opération source, ni modification) et la période est fermée.
 */
export async function reconcile(companyId: Id, userId: Id, b: z.infer<typeof reconcileBody>) {
  const statementDate = startOfDay(b.statementDate); if (statementDate > startOfDay(new Date())) throw AppError.badRequest('Date de relevé dans le futur');
  await ensureCounter(companyId, 'reconciliation', statementDate);
  return withTransaction(async (session) => {
    const acc = await TreasuryAccount.findOne({ _id: b.accountId, companyId }).session(session).lean(); if (!acc) throw AppError.notFound('Compte introuvable');
    if (acc.type !== 'bank') throw AppError.badRequest('Le rapprochement bancaire concerne les comptes bancaires');
    if (acc.lastReconciledDate && statementDate <= acc.lastReconciledDate) throw AppError.conflict('Le relevé doit être postérieur au dernier rapprochement');
    const ids = [...new Set(b.movementIds)];
    const moves = await TreasuryMovement.find({ _id: { $in: ids }, companyId, accountId: acc._id }).session(session).lean();
    if (moves.length !== ids.length) throw AppError.badRequest('Mouvement introuvable pour ce compte');
    if (moves.some((m) => m.reconciledAt)) throw AppError.conflict('Un mouvement sélectionné est déjà rapproché');
    if (moves.some((m) => m.date > statementDate)) throw AppError.badRequest('Un mouvement est postérieur à la date du relevé');
    const previous = (acc.openingBalanceMinor ?? 0) + ((await TreasuryMovement.aggregate<{ s: number }>([{ $match: { companyId, accountId: acc._id, reconciledAt: { $ne: null } } }, { $group: { _id: null, s: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', { $multiply: ['$amountMinor', -1] }] } } } }]).session(session))[0]?.s ?? 0);
    const total = moves.reduce((s, m) => s + signed(m), 0); const diff = b.statementBalanceMinor - (previous + total);
    if (diff !== 0) throw new AppError(422, `Écart de rapprochement : ${diff} (solde relevé ${b.statementBalanceMinor} ≠ ${previous} + ${total})`, 'RECONCILIATION_DIFFERENCE', { differenceMinor: diff, previousBalanceMinor: previous, totalMinor: total });
    const number = await nextDocumentNumber(companyId, 'reconciliation', session, statementDate);
    const [r] = await BankReconciliation.create([{ companyId, number, accountId: acc._id, statementDate, statementBalanceMinor: b.statementBalanceMinor, previousBalanceMinor: previous, movementIds: ids, totalMinor: total, note: b.note, createdBy: userId }] as never[], { session });
    const u = await TreasuryMovement.updateMany({ _id: { $in: ids }, companyId, reconciledAt: null }, { reconciledAt: new Date(), reconciliationId: r!._id }, { session });
    if (u.modifiedCount !== ids.length) throw AppError.conflict('Un mouvement vient d’être rapproché par un autre utilisateur');
    const au = await TreasuryAccount.updateOne({ _id: acc._id, companyId, lastReconciledDate: acc.lastReconciledDate ?? null }, { lastReconciledDate: statementDate, lastReconciledBalanceMinor: b.statementBalanceMinor }, { session });
    if (au.modifiedCount !== 1) throw AppError.conflict('Un autre rapprochement vient d’être validé sur ce compte');
    return recDto(r!.toObject() as never);
  });
}
export async function listReconciliations(companyId: Id, f: { accountId?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId }; if (f.accountId) filter.accountId = f.accountId;
  const [items, total] = await Promise.all([BankReconciliation.find(filter).sort({ statementDate: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), BankReconciliation.countDocuments(filter)]);
  return { items: items.map((r) => recDto(r as never)), total, page: f.page, limit: f.limit };
}
export async function getReconciliation(companyId: Id, id: string) {
  const r = await BankReconciliation.findOne({ _id: id, companyId }).lean(); if (!r) throw AppError.notFound('Rapprochement introuvable');
  const items = (await TreasuryMovement.find({ companyId, reconciliationId: r._id }).sort({ date: 1, _id: 1 }).lean()).map((m) => mvDto(m as never)); return { ...recDto(r as never), movements: items };
}

/** Contrôle : solde de chaque compte = ouverture + Σ mouvements ; mouvements sans écriture comptable. */
export async function accountsConsistency(companyId: Id) {
  const accs = await TreasuryAccount.find({ companyId }).lean();
  const sums = await TreasuryMovement.aggregate<{ _id: Id; s: number }>([{ $match: { companyId } }, { $group: { _id: '$accountId', s: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', { $multiply: ['$amountMinor', -1] }] } } } }]);
  const m = new Map(sums.map((s) => [String(s._id), s.s]));
  const mismatches = accs.map((a) => ({ accountId: a._id.toString(), code: a.code, balanceMinor: a.balanceMinor ?? 0, expectedMinor: (a.openingBalanceMinor ?? 0) + (m.get(String(a._id)) ?? 0) })).filter((x) => x.balanceMinor !== x.expectedMinor);
  return { consistent: mismatches.length === 0, mismatches, accountsChecked: accs.length };
}
