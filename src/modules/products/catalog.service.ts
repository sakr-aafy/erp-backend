import type { Types } from 'mongoose';
import { Category, Product, Unit } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';

type Id = Types.ObjectId;

export async function listCategories(companyId: Id) {
  const [cats, counts] = await Promise.all([
    Category.find({ companyId }).sort({ name: 1 }).lean(),
    Product.aggregate<{ _id: Id; n: number }>([{ $match: { companyId, categoryId: { $ne: null } } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return cats.map((c) => ({ id: c._id.toString(), name: c.name, parentId: c.parentId?.toString() ?? null, productCount: n.get(c._id.toString()) ?? 0 }));
}
export async function createCategory(companyId: Id, d: { name: string; parentId?: string | null | undefined }) {
  if (d.parentId) {
    const p = await Category.findOne({ _id: d.parentId, companyId }).lean();
    if (!p) throw AppError.badRequest('Famille parente introuvable');
    if (p.parentId) throw AppError.badRequest('Deux niveaux maximum : famille et sous-famille');
  }
  const c = await Category.create({ companyId, name: d.name, parentId: d.parentId ?? null });
  return { id: c._id.toString(), name: c.name, parentId: c.parentId?.toString() ?? null };
}
export async function renameCategory(companyId: Id, id: string, name: string) {
  const c = await Category.findOneAndUpdate({ _id: id, companyId }, { name }, { returnDocument: 'after', runValidators: true }).lean();
  if (!c) throw AppError.notFound('Catégorie introuvable');
  return { id: c._id.toString(), name: c.name, parentId: c.parentId?.toString() ?? null };
}
export async function deleteCategory(companyId: Id, id: string) {
  const c = await Category.findOne({ _id: id, companyId }).lean();
  if (!c) throw AppError.notFound('Catégorie introuvable');
  if (await Category.exists({ companyId, parentId: c._id })) throw AppError.conflict('Cette famille contient des sous-familles');
  if (await Product.exists({ companyId, categoryId: c._id })) throw AppError.conflict('Des articles utilisent cette catégorie');
  await Category.deleteOne({ _id: id, companyId });
  return c;
}

export const listUnits = async (companyId: Id) =>
  (await Unit.find({ companyId }).sort({ code: 1 }).lean()).map((u) => ({ id: u._id.toString(), code: u.code, name: u.name }));
export async function createUnit(companyId: Id, d: { code: string; name: string }) {
  const u = await Unit.create({ companyId, ...d });
  return { id: u._id.toString(), code: u.code, name: u.name };
}
export async function updateUnit(companyId: Id, id: string, d: { code?: string | undefined; name?: string | undefined }) {
  const u = await Unit.findOneAndUpdate({ _id: id, companyId }, d, { returnDocument: 'after', runValidators: true }).lean();
  if (!u) throw AppError.notFound('Unité introuvable');
  return { id: u._id.toString(), code: u.code, name: u.name };
}
export async function deleteUnit(companyId: Id, id: string) {
  const u = await Unit.findOne({ _id: id, companyId }).lean();
  if (!u) throw AppError.notFound('Unité introuvable');
  if (await Product.exists({ companyId, unitId: u._id })) throw AppError.conflict('Des articles utilisent cette unité');
  await Unit.deleteOne({ _id: id, companyId });
  return u;
}
