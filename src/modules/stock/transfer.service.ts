import { z } from 'zod';
import type { ClientSession, Types } from 'mongoose';
import { StockTransfer, Warehouse, type TransferDoc } from '../../models/logistics.model.js';
import { Product } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureLevels } from '../../services/stock.service.js';

type Id = Types.ObjectId; type Lean = TransferDoc & { _id: Id; createdAt?: Date };
export const transferBody = z.object({
  fromWarehouseId: objectId, toWarehouseId: objectId, date: z.coerce.date().optional(), notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ productId: objectId, quantity: z.number().gt(0).max(1e9), serials: z.array(z.string().trim().min(1)).max(1000).optional() }).strict()).min(1).max(300),
}).strict().refine((v) => v.fromWarehouseId !== v.toWarehouseId, { path: ['toWarehouseId'], message: 'Magasins source et destination identiques' });
type Body = z.infer<typeof transferBody>;

const dto = (t: Lean) => ({ id: t._id.toString(), number: t.number, status: t.status, fromWarehouseId: t.fromWarehouseId!.toString(), toWarehouseId: t.toWarehouseId!.toString(), date: t.date, notes: t.notes ?? null,
  lines: t.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), productId: l.productId!.toString(), designation: l.designation ?? null, quantity: l.quantity, serials: l.serials ?? [], valueMinor: l.valueMinor ?? 0 })), validatedAt: t.validatedAt ?? null, editable: t.status === 'draft', createdAt: t.createdAt });

async function checkBody(companyId: Id, b: Body) {
  const whs = await Warehouse.find({ companyId, _id: { $in: [b.fromWarehouseId, b.toWarehouseId] }, isActive: true }).lean();
  if (whs.length !== 2) throw AppError.badRequest('Magasin invalide ou inactif');
  const products = await Product.find({ companyId, _id: { $in: b.lines.map((l) => l.productId) } }).lean(); const byId = new Map(products.map((p) => [p._id.toString(), p]));
  return b.lines.map((l) => { const p = byId.get(l.productId); if (!p) throw AppError.badRequest('Article introuvable'); if (p.kind === 'service') throw AppError.badRequest(`« ${p.reference} » est un service : non transférable`); return { productId: p._id, designation: `${p.reference} — ${p.name}`, quantity: l.quantity, serials: l.serials ?? [] }; });
}
export async function list(companyId: Id, f: { status?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, ...(f.status && { status: f.status }) };
  const [items, total] = await Promise.all([StockTransfer.find(filter).sort({ date: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), StockTransfer.countDocuments(filter)]);
  return { items: items.map((t) => dto(t as Lean)), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const t = await StockTransfer.findOne({ _id: id, companyId }).session(session ?? null).lean(); if (!t) throw AppError.notFound('Transfert introuvable'); return t as Lean; }
export const get = async (c: Id, id: string) => dto(await getOwn(c, id));
export async function create(companyId: Id, userId: Id, b: Body) {
  const lines = await checkBody(companyId, b); const date = b.date ?? new Date(); await ensureCounter(companyId, 'stockTransfer', date);
  return withTransaction(async (session) => {
    const number = await nextDocumentNumber(companyId, 'stockTransfer', session, date);
    const [t] = await StockTransfer.create([{ companyId, number, fromWarehouseId: b.fromWarehouseId, toWarehouseId: b.toWarehouseId, date, lines, notes: b.notes, createdBy: userId }] as never[], { session });
    return dto(t!.toObject() as Lean);
  });
}
export async function update(companyId: Id, id: string, b: Body) {
  const cur = await getOwn(companyId, id); if (cur.status !== 'draft') throw AppError.conflict('Transfert validé : non modifiable');
  const lines = await checkBody(companyId, b);
  const u = await StockTransfer.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { fromWarehouseId: b.fromWarehouseId, toWarehouseId: b.toWarehouseId, date: b.date ?? cur.date, lines, notes: b.notes } }, { returnDocument: 'after' }).lean();
  if (!u) throw AppError.conflict('Le transfert a changé entre-temps'); return dto(u as Lean);
}
export async function remove(companyId: Id, id: string) {
  const t = await getOwn(companyId, id); if (t.status !== 'draft') throw AppError.conflict('Un transfert validé ne se supprime pas : effectuez un transfert inverse');
  await StockTransfer.deleteOne({ _id: id, companyId, status: 'draft' }); return t;
}
/** Validation : sortie du magasin source ET entrée au magasin destinataire dans UNE transaction (valeur transférée = valeur sortie). */
export async function validate(companyId: Id, userId: Id, id: string) {
  const pre = await getOwn(companyId, id);
  await ensureLevels(companyId, pre.lines.map((l) => ({ productId: l.productId!, warehouseId: pre.toWarehouseId! })));
  return withTransaction(async (session) => {
    const t = await getOwn(companyId, id, session); if (t.status !== 'draft') throw AppError.conflict('Transfert déjà validé');
    await emitDomainEvent('stockTransfer.validated', { companyId, documentId: t._id, session, userId, documentNumber: t.number });
    const u = await StockTransfer.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le transfert a changé entre-temps'); return dto(u as Lean);
  });
}
