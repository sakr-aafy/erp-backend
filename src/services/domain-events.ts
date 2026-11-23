import type { ClientSession, Types } from 'mongoose';
import { EventLog } from '../models/logistics.model.js';
import { logger } from '../config/logger.js';

/**
 * Événements de domaine entre modules (Ventes, Achats, Stock, Importations…).
 *
 * COHÉRENCE : les abonnés s'exécutent DANS la transaction de l'opération émettrice : si l'un échoue (ex. stock insuffisant),
 * l'opération entière est annulée.
 * IDEMPOTENCE : chaque (événement, document, abonné) n'est traité qu'une fois — clé unique dans `eventLogs` ; les mouvements
 * créés par un abonné portent en outre leur propre clé unique (`eventKey`).
 * JOURNAL : succès enregistrés dans la transaction ; ÉCHECS enregistrés HORS transaction (donc conservés malgré le rollback),
 * avec message et nombre de tentatives, pour la reprise (`/stock/events/:id/retry`).
 */
export type DomainEvent = 'deliveryNote.validated' | 'deliveryNote.cancelled' | 'invoice.validated' | 'creditNote.validated' | 'payment.recorded' | 'payment.cancelled'
  | 'goodsReceipt.validated' | 'stockTransfer.validated' | 'inventory.validated'
  | 'purchaseInvoice.validated' | 'supplierPayment.recorded' | 'supplierPayment.cancelled' | 'expense.validated' | 'expense.cancelled' | 'treasuryTransfer.recorded' | 'treasuryTransfer.cancelled' | 'treasuryMovement.recorded';
export interface EventContext { companyId: Types.ObjectId; documentId: Types.ObjectId; session: ClientSession; userId?: Types.ObjectId | undefined; payload?: unknown; documentNumber?: string | undefined }
type Handler = (ctx: EventContext) => Promise<{ movements?: number } | void>;
const handlers = new Map<DomainEvent, { name: string; fn: Handler }[]>();

export function onDomainEvent(event: DomainEvent, handler: Handler, name = 'default') {
  const list = (handlers.get(event) ?? []).filter((h) => h.name !== name); // enregistrement idempotent par nom
  handlers.set(event, [...list, { name, fn: handler }]);
}
export async function emitDomainEvent(event: DomainEvent, ctx: EventContext) {
  for (const h of handlers.get(event) ?? []) {
    const key = `${event}:${ctx.documentId}:${h.name}`;
    const done = await EventLog.findOne({ companyId: ctx.companyId, key, status: 'processed' }).session(ctx.session).lean();
    if (done) continue; // déjà traité : jamais de second traitement
    try {
      const r = await h.fn(ctx);
      await EventLog.updateOne({ companyId: ctx.companyId, key }, { $set: { event, documentId: ctx.documentId, handler: h.name, status: 'processed', movements: r?.movements ?? 0, processedAt: new Date(), documentNumber: ctx.documentNumber,
        payload: ctx.payload ?? null }, $unset: { error: 1 }, $inc: { attempts: 1 } }, { upsert: true, session: ctx.session });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Écriture hors transaction : survit au rollback de l'opération émettrice
      await EventLog.updateOne({ companyId: ctx.companyId, key }, { $set: { event, documentId: ctx.documentId, handler: h.name, status: 'failed', error: message.slice(0, 500), documentNumber: ctx.documentNumber, payload: ctx.payload ?? null }, $inc: { attempts: 1 } }, { upsert: true })
        .catch((e) => logger.error({ err: e }, 'journal d’événement : échec d’écriture'));
      throw err;
    }
  }
}
export const clearDomainHandlers = () => handlers.clear();
export const hasHandlers = (event: DomainEvent) => (handlers.get(event)?.length ?? 0) > 0;
