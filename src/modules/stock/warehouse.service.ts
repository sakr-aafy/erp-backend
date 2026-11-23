import { z } from 'zod';
import type { Types } from 'mongoose';
import { StockLevel, StockMovement, Warehouse, type WarehouseDoc } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';

type Id = Types.ObjectId;
export const warehouseBody = z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().min(2).max(100), address: z.string().trim().max(300).optional(), isDefault: z.boolean().optional() }).strict();
export const warehouseUpdateBody = warehouseBody.partial().strict();

const dto = (w: WarehouseDoc & { _id: Id }) => ({ id: w._id.toString(), code: w.code, name: w.name, address: w.address ?? null, isDefault: !!w.isDefault, isActive: !!w.isActive });

export async function list(companyId: Id) { return (await Warehouse.find({ companyId }).sort({ code: 1 }).lean()).map(dto); }
export async function create(companyId: Id, b: z.infer<typeof warehouseBody>) {
  const first = !(await Warehouse.exists({ companyId }));
  if (b.isDefault) await Warehouse.updateMany({ companyId }, { isDefault: false });
  return dto((await Warehouse.create({ ...b, companyId, isDefault: b.isDefault || first })).toObject());
}
export async function update(companyId: Id, id: string, b: z.infer<typeof warehouseUpdateBody>) {
  if (b.isDefault) await Warehouse.updateMany({ companyId }, { isDefault: false });
  const w = await Warehouse.findOneAndUpdate({ _id: id, companyId }, b, { returnDocument: 'after', runValidators: true }).lean();
  if (!w) throw AppError.notFound('Magasin introuvable');
  return dto(w);
}
export async function setActive(companyId: Id, id: string, active: boolean) {
  const w = await Warehouse.findOne({ _id: id, companyId });
  if (!w) throw AppError.notFound('Magasin introuvable');
  if (!active) {
    if (w.isDefault) throw AppError.conflict('Le magasin par défaut ne peut pas être désactivé : choisissez un autre magasin par défaut');
    if (await StockLevel.exists({ companyId, warehouseId: w._id, qty: { $ne: 0 } })) throw AppError.conflict('Magasin non vide : transférez ou régularisez le stock avant de le désactiver');
  }
  w.isActive = active; await w.save(); return dto(w.toObject());
}
export async function remove(companyId: Id, id: string) {
  const w = await Warehouse.findOne({ _id: id, companyId });
  if (!w) throw AppError.notFound('Magasin introuvable');
  if (await StockMovement.exists({ companyId, warehouseId: w._id }) || await StockLevel.exists({ companyId, warehouseId: w._id, qty: { $ne: 0 } })) throw AppError.conflict('Suppression impossible : des mouvements de stock existent. Désactivez le magasin.');
  await StockLevel.deleteMany({ companyId, warehouseId: w._id }); await w.deleteOne(); return w;
}
