import type { Types } from 'mongoose';
import { DeliveryNote, } from '../../models/sales.model.js';
import { EventLog, GoodsReceipt, Inventory, StockLevel, StockMovement, StockTransfer } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent, type DomainEvent } from '../../services/domain-events.js';
import { ensureLevels } from '../../services/stock.service.js';

type Id = Types.ObjectId;
const dto = (e: { _id: Id; event: string; documentId: Id; handler: string; status: string; attempts?: number | null; error?: string | null; movements?: number | null; documentNumber?: string | null; updatedAt?: Date; processedAt?: Date | null }) => ({
  id: e._id.toString(), event: e.event, documentId: e.documentId.toString(), handler: e.handler, status: e.status, attempts: e.attempts ?? 0, error: e.error ?? null, movements: e.movements ?? 0, documentNumber: e.documentNumber ?? null, at: e.updatedAt, processedAt: e.processedAt ?? null });

export async function listEvents(companyId: Id, f: { status?: string | undefined; event?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, ...(f.status && { status: f.status }), ...(f.event && { event: f.event }) };
  const [items, total] = await Promise.all([EventLog.find(filter).sort({ updatedAt: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), EventLog.countDocuments(filter)]);
  return { items: items.map(dto), total, page: f.page, limit: f.limit };
}

/**
 * Reprise d'un traitement en échec : rejoue l'OPÉRATION MÉTIER d'origine (validation du BL, de la réception, du transfert, de l'inventaire).
 * L'opération est idempotente : si elle est déjà aboutie, rien n'est dupliqué.
 */
export async function retryEvent(companyId: Id, userId: Id, id: string) {
  const log = await EventLog.findOne({ _id: id, companyId });
  if (!log) throw AppError.notFound('Événement introuvable');
  if (log.status === 'processed') return dto(log.toObject());
  const doc = log.documentId.toString();
  const ops: Partial<Record<DomainEvent, () => Promise<unknown>>> = {
    'deliveryNote.validated': async () => (await import('../delivery-notes/delivery.service.js')).validate(companyId, userId, doc, {}),
    'goodsReceipt.validated': async () => (await import('../purchases/receipt.service.js')).validate(companyId, userId, doc),
    'stockTransfer.validated': async () => (await import('./transfer.service.js')).validate(companyId, userId, doc),
    'inventory.validated': async () => (await import('./inventory.service.js')).validate(companyId, userId, doc),
  };
  const op = ops[log.event as DomainEvent];
  if (!op) throw AppError.badRequest('Cet événement ne peut pas être rejoué automatiquement');
  await op(); // lève l'erreur d'origine si la cause persiste (la tentative est journalisée)
  return dto((await EventLog.findById(id))!.toObject());
}

/**
 * Réconciliation : (1) documents VALIDÉS dont l'événement de stock n'est pas journalisé (ex. BL validés avant l'activation du stock) sont rejoués ;
 * (2) contrôle niveaux de stock = somme des mouvements.
 */
export async function reconcile(companyId: Id, userId: Id) {
  const replayed: { event: string; number: string }[] = []; const failed: { event: string; number: string; error: string }[] = [];
  const missing = async (event: DomainEvent, docs: { _id: Id; number?: string | null }[]) => {
    for (const d of docs) {
      const done = await EventLog.exists({ companyId, key: `${event}:${d._id}:stock`, status: 'processed' });
      if (done) continue;
      try {
        if (event === 'deliveryNote.validated') { const bl = await DeliveryNote.findById(d._id).lean(); await ensureLevels(companyId, (bl?.lines ?? []).filter((l) => l.productId).map((l) => ({ productId: l.productId!, warehouseId: bl!.warehouseId ?? '000000000000000000000000' })).filter((x) => String(x.warehouseId) !== '000000000000000000000000')); }
        await withTransaction((session) => emitDomainEvent(event, { companyId, documentId: d._id, session, userId, documentNumber: d.number ?? undefined, payload: {} }));
        replayed.push({ event, number: d.number ?? '' });
      } catch (e) { failed.push({ event, number: d.number ?? '', error: e instanceof Error ? e.message : String(e) }); }
    }
  };
  await missing('deliveryNote.validated', await DeliveryNote.find({ companyId, status: 'validated' }).select('number').lean());
  await missing('goodsReceipt.validated', await GoodsReceipt.find({ companyId, status: 'validated' }).select('number').lean());
  await missing('stockTransfer.validated', await StockTransfer.find({ companyId, status: 'validated' }).select('number').lean());
  await missing('inventory.validated', await Inventory.find({ companyId, status: 'validated' }).select('number').lean());
  return { replayed, failed, consistency: await consistency(companyId) };
}

/** Niveau = Σ entrées − Σ sorties pour chaque article/magasin. */
export async function consistency(companyId: Id) {
  const sums = await StockMovement.aggregate<{ _id: { p: Id; w: Id }; qty: number }>([{ $match: { companyId } }, { $group: { _id: { p: '$productId', w: '$warehouseId' }, qty: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$quantity', { $multiply: ['$quantity', -1] }] } } } }]);
  const levels = await StockLevel.find({ companyId }).lean(); const lv = new Map(levels.map((l) => [`${l.productId}:${l.warehouseId}`, l.qty]));
  const mismatches: { productId: string; warehouseId: string; level: number; fromMovements: number }[] = [];
  for (const s of sums) { const k = `${s._id.p}:${s._id.w}`; const level = lv.get(k) ?? 0; if (Math.abs(level - s.qty) > 1e-6) mismatches.push({ productId: String(s._id.p), warehouseId: String(s._id.w), level, fromMovements: s.qty }); lv.delete(k); }
  for (const [k, q] of lv) if (Math.abs(q) > 1e-6) { const [p, w] = k.split(':'); mismatches.push({ productId: p!, warehouseId: w!, level: q, fromMovements: 0 }); }
  return { consistent: mismatches.length === 0, mismatches, levelsChecked: levels.length };
}
