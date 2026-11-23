import type { Types } from 'mongoose';
import { Invoice, Payment } from '../../models/sales.model.js';
import { EventLog, PurchaseInvoice } from '../../models/logistics.model.js';
import { Expense, SupplierPayment, TreasuryMovement, TreasuryTransfer } from '../../models/finance.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent, type DomainEvent } from '../../services/domain-events.js';
import { ensureFinanceCounters } from '../../services/accounting.service.js';
import { consistency as accountingConsistency } from '../accounting/accounting.service.js';
import { accountsConsistency } from '../treasury/treasury.service.js';

type Id = Types.ObjectId; const HANDLERS = ['accounting', 'treasury'];
const dto = (e: { _id: Id; event: string; documentId: Id; handler: string; status: string; attempts?: number | null; error?: string | null; movements?: number | null; documentNumber?: string | null; updatedAt?: Date }) =>
  ({ id: e._id.toString(), event: e.event, documentId: e.documentId.toString(), handler: e.handler, status: e.status, attempts: e.attempts ?? 0, error: e.error ?? null, movements: e.movements ?? 0, documentNumber: e.documentNumber ?? null, at: e.updatedAt });

export async function listEvents(companyId: Id, f: { status?: string | undefined; event?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, handler: { $in: HANDLERS }, ...(f.status && { status: f.status }), ...(f.event && { event: f.event }) };
  const [items, total] = await Promise.all([EventLog.find(filter).sort({ updatedAt: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), EventLog.countDocuments(filter)]);
  return { items: items.map((e) => dto(e as never)), total, page: f.page, limit: f.limit };
}

/** Rejoue un événement dont le document source est DÉJÀ validé (les abonnés déjà traités sont ignorés : jamais de doublon). */
async function replay(companyId: Id, userId: Id, event: DomainEvent, documentId: Id, number?: string | null) {
  await withTransaction((session) => emitDomainEvent(event, { companyId, documentId, session, userId, documentNumber: number ?? undefined, payload: {} }));
}
/**
 * Reprise d'un traitement en échec. Si l'opération d'origine a été annulée (rollback complet), il n'existe rien à rejouer : l'utilisateur la ressaisit.
 * Si le document est encore en attente de validation, la validation est rejouée.
 */
export async function retryEvent(companyId: Id, userId: Id, id: string) {
  const log = await EventLog.findOne({ _id: id, companyId, handler: { $in: HANDLERS } }); if (!log) throw AppError.notFound('Événement introuvable');
  if (log.status === 'processed') return dto(log.toObject() as never);
  await ensureFinanceCounters(companyId); const doc = log.documentId; const ev = log.event as DomainEvent;
  const gone = () => AppError.conflict('L’opération d’origine a été annulée (aucun document à rejouer) : ressaisissez-la');
  if (ev === 'invoice.validated' || ev === 'creditNote.validated') {
    const i = await Invoice.findOne({ _id: doc, companyId }).select('status').lean(); if (!i) throw gone();
    if (i.status === 'draft') await (await import('../invoices/invoice.service.js')).validate(companyId, userId, doc.toString()); else await replay(companyId, userId, ev, doc, log.documentNumber);
  } else if (ev === 'purchaseInvoice.validated') {
    const i = await PurchaseInvoice.findOne({ _id: doc, companyId }).select('status').lean(); if (!i) throw gone();
    if (i.status === 'draft') await (await import('../purchases/invoice.service.js')).validate(companyId, userId, doc.toString()); else await replay(companyId, userId, ev, doc, log.documentNumber);
  } else if (ev === 'expense.validated') {
    const e = await Expense.findOne({ _id: doc, companyId }).select('status').lean(); if (!e) throw gone();
    if (e.status === 'submitted') await (await import('../expenses/expense.service.js')).validate(companyId, userId, doc.toString()); else if (e.status === 'validated') await replay(companyId, userId, ev, doc, log.documentNumber); else throw gone();
  } else if (ev === 'payment.recorded') { if (!(await Payment.exists({ _id: doc, companyId, status: 'active' }))) throw gone(); await replay(companyId, userId, ev, doc, log.documentNumber); }
  else if (ev === 'supplierPayment.recorded') { if (!(await SupplierPayment.exists({ _id: doc, companyId, status: 'active' }))) throw gone(); await replay(companyId, userId, ev, doc, log.documentNumber); }
  else if (ev === 'treasuryTransfer.recorded') { if (!(await TreasuryTransfer.exists({ _id: doc, companyId, status: 'active' }))) throw gone(); await replay(companyId, userId, ev, doc, log.documentNumber); }
  else if (ev === 'treasuryMovement.recorded') { if (!(await TreasuryMovement.exists({ _id: doc, companyId }))) throw gone(); await replay(companyId, userId, ev, doc, log.documentNumber); }
  else throw AppError.badRequest('Cet événement ne peut pas être rejoué automatiquement : refaites l’opération');
  return dto((await EventLog.findById(id))!.toObject() as never);
}

/**
 * Réconciliation financière : rejoue les événements des documents VALIDÉS dont un traitement comptable / de trésorerie n'est pas journalisé
 * (ex. documents validés avant la Phase 6). Idempotent : aucune double écriture. Puis contrôles de cohérence.
 */
export async function reconcile(companyId: Id, userId: Id) {
  await ensureFinanceCounters(companyId);
  const replayed: { event: string; number: string }[] = []; const failed: { event: string; number: string; error: string }[] = [];
  const todo = async (event: DomainEvent, handlers: string[], docs: { _id: Id; number?: string | null | undefined }[]) => {
    for (const d of docs) {
      const logs = await EventLog.find({ companyId, event, documentId: d._id, handler: { $in: handlers }, status: 'processed' }).select('handler').lean();
      if (handlers.every((h) => logs.some((l) => l.handler === h))) continue;
      try { await replay(companyId, userId, event, d._id, d.number); replayed.push({ event, number: d.number ?? String(d._id) }); }
      catch (e) { failed.push({ event, number: d.number ?? String(d._id), error: e instanceof Error ? e.message : String(e) }); }
    }
  };
  await todo('invoice.validated', ['accounting'], await Invoice.find({ companyId, type: 'invoice', status: 'validated' }).select('number').lean());
  await todo('creditNote.validated', ['accounting'], await Invoice.find({ companyId, type: 'credit_note', status: 'validated' }).select('number').lean());
  await todo('purchaseInvoice.validated', ['accounting'], await PurchaseInvoice.find({ companyId, status: 'validated' }).select('number').lean());
  await todo('payment.recorded', ['treasury', 'accounting'], await Payment.find({ companyId, status: 'active' }).select('_id').lean());
  await todo('supplierPayment.recorded', ['treasury'], await SupplierPayment.find({ companyId, status: 'active' }).select('number').lean());
  await todo('expense.validated', ['treasury'], await Expense.find({ companyId, status: 'validated' }).select('number').lean());
  await todo('treasuryTransfer.recorded', ['treasury'], await TreasuryTransfer.find({ companyId, status: 'active' }).select('number').lean());
  await todo('treasuryMovement.recorded', ['accounting'], await TreasuryMovement.find({ companyId }).select('_id').lean());
  return { replayed, failed, accounting: await accountingConsistency(companyId), treasury: await accountsConsistency(companyId) };
}
