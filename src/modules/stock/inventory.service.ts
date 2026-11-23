import { z } from 'zod';
import type { ClientSession, Types } from 'mongoose';
import { Inventory, StockLevel, Warehouse, type InventoryDoc } from '../../models/logistics.model.js';
import { Product } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';

type Id = Types.ObjectId; type Lean = InventoryDoc & { _id: Id; createdAt?: Date };
export const createBody = z.object({ warehouseId: objectId, date: z.coerce.date().optional(), notes: z.string().trim().max(1000).optional(), productIds: z.array(objectId).max(500).optional() }).strict();
export const updateBody = z.object({
  reason: z.string().trim().max(300).optional(), notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ productId: objectId, countedQty: z.number().min(0).max(1e9).nullable() }).strict()).max(1000),
}).strict();

const dto = (i: Lean) => ({ id: i._id.toString(), number: i.number, status: i.status, warehouseId: i.warehouseId!.toString(), date: i.date, reason: i.reason ?? null, notes: i.notes ?? null,
  lines: i.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), productId: l.productId!.toString(), reference: l.reference ?? null, designation: l.designation ?? null, systemQty: l.systemQty ?? 0, countedQty: l.countedQty ?? null,
    variance: l.countedQty == null ? null : Math.round((l.countedQty - (l.systemQty ?? 0)) * 1000) / 1000, appliedDelta: l.appliedDelta ?? 0 })), validatedAt: i.validatedAt ?? null, editable: i.status === 'draft', createdAt: i.createdAt });

/** Feuille d'inventaire : articles en stock dans le magasin (ou liste choisie) ; articles à numéro de série exclus (suivis par numéro). */
export async function create(companyId: Id, userId: Id, b: z.infer<typeof createBody>) {
  if (!(await Warehouse.exists({ _id: b.warehouseId, companyId, isActive: true }))) throw AppError.badRequest('Magasin invalide');
  const levels = await StockLevel.find({ companyId, warehouseId: b.warehouseId }).lean(); const qtyBy = new Map(levels.map((l) => [l.productId.toString(), l.qty]));
  const ids = b.productIds?.length ? b.productIds : levels.filter((l) => l.qty !== 0).map((l) => l.productId.toString());
  const products = await Product.find({ companyId, _id: { $in: ids }, kind: 'product', hasSerial: { $ne: true } }).sort({ reference: 1 }).lean();
  const date = b.date ?? new Date(); await ensureCounter(companyId, 'inventory', date);
  return withTransaction(async (session) => {
    const number = await nextDocumentNumber(companyId, 'inventory', session, date);
    const [i] = await Inventory.create([{ companyId, number, warehouseId: b.warehouseId, date, notes: b.notes, createdBy: userId,
      lines: products.map((p) => ({ productId: p._id, reference: p.reference, designation: p.name, systemQty: qtyBy.get(p._id.toString()) ?? 0, countedQty: null })) }] as never[], { session });
    return dto(i!.toObject() as Lean);
  });
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const i = await Inventory.findOne({ _id: id, companyId }).session(session ?? null).lean(); if (!i) throw AppError.notFound('Inventaire introuvable'); return i as Lean; }
export const get = async (c: Id, id: string) => dto(await getOwn(c, id));
export async function list(companyId: Id, f: { status?: string | undefined; warehouseId?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, ...(f.status && { status: f.status }), ...(f.warehouseId && { warehouseId: f.warehouseId }) };
  const [items, total] = await Promise.all([Inventory.find(filter).select('-lines').sort({ date: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Inventory.countDocuments(filter)]);
  return { items: items.map((i) => ({ ...dto({ ...i, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
/** Saisie des quantités comptées (et ajout éventuel d'articles). */
export async function saveCounts(companyId: Id, id: string, b: z.infer<typeof updateBody>) {
  const inv = await Inventory.findOne({ _id: id, companyId }); if (!inv) throw AppError.notFound('Inventaire introuvable');
  if (inv.status !== 'draft') throw AppError.conflict('Inventaire validé : non modifiable');
  for (const c of b.lines) {
    let l = inv.lines.find((x) => String(x.productId) === c.productId);
    if (!l) {
      const p = await Product.findOne({ _id: c.productId, companyId, kind: 'product' }).lean(); if (!p) throw AppError.badRequest('Article introuvable');
      if (p.hasSerial) throw AppError.badRequest(`« ${p.reference} » est suivi par numéro de série : non inventoriable par quantité`);
      const lv = await StockLevel.findOne({ companyId, productId: p._id, warehouseId: inv.warehouseId }).lean();
      inv.lines.push({ productId: p._id, reference: p.reference, designation: p.name, systemQty: lv?.qty ?? 0, countedQty: null, appliedDelta: 0 } as never); l = inv.lines[inv.lines.length - 1]!;
    }
    l.countedQty = c.countedQty;
  }
  if (b.reason !== undefined) inv.reason = b.reason; if (b.notes !== undefined) inv.notes = b.notes;
  await inv.save(); return dto(inv.toObject() as Lean);
}
export async function remove(companyId: Id, id: string) { const i = await getOwn(companyId, id); if (i.status !== 'draft') throw AppError.conflict('Un inventaire validé ne se supprime pas'); await Inventory.deleteOne({ _id: id, companyId, status: 'draft' }); return i; }
/** Validation : écarts → ajustements de stock au CMP. Motif obligatoire dès qu'il existe un écart ; contrôle de l'écart sur le stock ACTUEL. */
export async function validate(companyId: Id, userId: Id, id: string) {
  const pre = await getOwn(companyId, id);
  const { ensureLevels } = await import('../../services/stock.service.js'); await ensureLevels(companyId, pre.lines.filter((l) => l.countedQty != null).map((l) => ({ productId: l.productId!, warehouseId: pre.warehouseId! })));
  return withTransaction(async (session) => {
    const i = await getOwn(companyId, id, session); if (i.status !== 'draft') throw AppError.conflict('Inventaire déjà validé');
    if (!i.lines.some((l) => l.countedQty != null)) throw AppError.conflict('Aucune quantité comptée');
    const levels = await StockLevel.find({ companyId, warehouseId: i.warehouseId }).session(session).lean(); const q = new Map(levels.map((l) => [l.productId.toString(), l.qty]));
    const hasVariance = i.lines.some((l) => l.countedQty != null && Math.abs(l.countedQty - (q.get(l.productId!.toString()) ?? 0)) > 1e-9);
    if (hasVariance && !i.reason) throw AppError.conflict('Un motif est obligatoire pour valider un inventaire comportant des écarts');
    await emitDomainEvent('inventory.validated', { companyId, documentId: i._id, session, userId, documentNumber: i.number });
    const u = await Inventory.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('L’inventaire a changé entre-temps'); return dto(u as Lean);
  });
}
