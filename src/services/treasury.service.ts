import type { ClientSession, Types } from 'mongoose';
import { TreasuryAccount, TreasuryMovement, type TreasuryMovementDoc } from '../models/finance.model.js';
import { AppError } from '../utils/errors.js';
import { emitDomainEvent } from './domain-events.js';
import { startOfDay } from './fiscal.service.js';

type Id = Types.ObjectId;
export interface MovementInput {
  companyId: Id; session: ClientSession; userId?: Id | undefined; accountId: Id | string; direction: 'in' | 'out'; amountMinor: number; date: Date;
  kind: TreasuryMovementDoc['kind']; label: string; eventKey: string; source?: { type: string; id: Id; number?: string | undefined } | undefined;
  thirdParty?: { type: 'customer' | 'supplier'; id: Id; name?: string | undefined } | undefined; method?: string | undefined; reference?: string | undefined; reversalOf?: Id | undefined;
}

/**
 * Cœur de la trésorerie : SEUL point d'écriture des mouvements et du solde des comptes.
 * - idempotent (`eventKey` unique) : rejouer un événement ne crée jamais un second mouvement ;
 * - solde mis à jour atomiquement ($inc, garde anti-découvert si le compte l'interdit) ;
 * - période rapprochée verrouillée : aucun mouvement daté ≤ date du dernier relevé rapproché ;
 * - émet `treasuryMovement.recorded` (écriture comptable de caisse/banque dans la même transaction).
 */
export async function recordMovement(i: MovementInput): Promise<{ movement: TreasuryMovementDoc & { _id: Id }; duplicate: boolean }> {
  const existing = await TreasuryMovement.findOne({ companyId: i.companyId, eventKey: i.eventKey }).session(i.session).lean();
  if (existing) return { movement: existing as never, duplicate: true };
  const acc = await TreasuryAccount.findOne({ _id: i.accountId, companyId: i.companyId }).session(i.session).lean();
  if (!acc) throw AppError.notFound('Compte de trésorerie introuvable');
  if (!acc.isActive) throw AppError.conflict(`Le compte « ${acc.name} » est désactivé`);
  if (!Number.isSafeInteger(i.amountMinor) || i.amountMinor <= 0) throw AppError.badRequest('Montant invalide');
  const date = startOfDay(i.date);
  if (acc.lastReconciledDate && date <= acc.lastReconciledDate) throw AppError.conflict(`Période rapprochée : aucun mouvement ne peut être daté du ${acc.lastReconciledDate.toISOString().slice(0, 10)} ou avant sur « ${acc.name} »`);
  const delta = i.direction === 'in' ? i.amountMinor : -i.amountMinor;
  const guard: Record<string, unknown> = { _id: acc._id, companyId: i.companyId, isActive: true };
  if (i.direction === 'out' && !acc.allowNegative) guard.balanceMinor = { $gte: i.amountMinor };
  const upd = await TreasuryAccount.findOneAndUpdate(guard, { $inc: { balanceMinor: delta } }, { returnDocument: 'after', session: i.session }).lean();
  if (!upd) throw new AppError(409, `Solde insuffisant sur « ${acc.name} » (${acc.balanceMinor}) : découvert non autorisé`, 'INSUFFICIENT_FUNDS');
  const [m] = await TreasuryMovement.create([{ companyId: i.companyId, accountId: acc._id, direction: i.direction, amountMinor: i.amountMinor, date, kind: i.kind, label: i.label, source: i.source, thirdParty: i.thirdParty,
    method: i.method, reference: i.reference, balanceAfterMinor: upd.balanceMinor, reversalOf: i.reversalOf, eventKey: i.eventKey, createdBy: i.userId }] as never[], { session: i.session });
  await emitDomainEvent('treasuryMovement.recorded', { companyId: i.companyId, documentId: m!._id, session: i.session, userId: i.userId, documentNumber: i.source?.number, payload: { eventKey: i.eventKey } });
  return { movement: m!.toObject() as never, duplicate: false };
}

/** Mouvement inverse (annulation d'un encaissement / règlement / dépense / virement). Refusé si le mouvement d'origine est rapproché. */
export async function reverseBySource(companyId: Id, session: ClientSession, userId: Id | undefined, originalEventKey: string, eventKey: string, label: string) {
  const dup = await TreasuryMovement.findOne({ companyId, eventKey }).session(session).lean(); if (dup) return { movement: dup as never, duplicate: true };
  const orig = await TreasuryMovement.findOne({ companyId, eventKey: originalEventKey }).session(session).lean();
  if (!orig) return null; // l'opération n'avait pas de mouvement de trésorerie (ex. encaissement sans compte)
  return reverseMovement(companyId, session, userId, orig, eventKey, label);
}
export async function reverseMovement(companyId: Id, session: ClientSession, userId: Id | undefined, orig: TreasuryMovementDoc & { _id: Id }, eventKey: string, label: string) {
  if (orig.reconciledAt) throw AppError.conflict('Mouvement déjà rapproché avec le relevé bancaire : il ne peut plus être annulé (passez une écriture corrective)');
  if (orig.reversedById) throw AppError.conflict('Mouvement déjà annulé');
  const acc = await TreasuryAccount.findOne({ _id: orig.accountId, companyId }).session(session).lean();
  const today = startOfDay(new Date()); const floor = acc?.lastReconciledDate ? new Date(acc.lastReconciledDate.getTime() + 86400000) : today;
  const r = await recordMovement({ companyId, session, userId, accountId: orig.accountId, direction: orig.direction === 'in' ? 'out' : 'in', amountMinor: orig.amountMinor, date: today > floor ? today : floor,
    kind: 'reversal', label, eventKey, source: orig.source ? { type: orig.source.type!, id: orig.source.id!, number: orig.source.number ?? undefined } : undefined,
    thirdParty: orig.thirdParty?.type ? { type: orig.thirdParty.type as 'customer' | 'supplier', id: orig.thirdParty.id!, name: orig.thirdParty.name ?? undefined } : undefined, reversalOf: orig._id });
  await TreasuryMovement.updateOne({ _id: orig._id, reversedById: null }, { reversedById: r.movement._id }, { session });
  return r;
}
