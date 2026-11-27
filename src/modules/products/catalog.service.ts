import type { Types } from 'mongoose';
import { Category, Product, Unit } from '../../models/product.model.js';
import { ensureFixedUnits, FIXED_UNITS, unitDecimals } from './units.js';
import { AppError } from '../../utils/errors.js';

type Id = Types.ObjectId;

type CategoryRow = { _id: Id; name: string; parentId?: Id | null; isArchived?: boolean | null };
const categoryDto = (c: CategoryRow) => ({ id: c._id.toString(), name: c.name, parentId: c.parentId?.toString() ?? null, isArchived: !!c.isArchived });
const COLLATION = { locale: 'fr', strength: 2 } as const;

/** Hiérarchie à deux niveaux avec les nombres RÉELS d'articles : directs, et total (sous-catégories comprises). */
export async function listCategories(companyId: Id) {
  const [cats, counts] = await Promise.all([
    Category.find({ companyId }).sort({ name: 1 }).collation(COLLATION).lean(),
    Product.aggregate<{ _id: Id; n: number }>([{ $match: { companyId, categoryId: { $ne: null } } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return cats.map((c) => {
    const direct = n.get(c._id.toString()) ?? 0;
    const total = direct + cats.filter((x) => x.parentId?.toString() === c._id.toString()).reduce((a, x) => a + (n.get(x._id.toString()) ?? 0), 0);
    return { ...categoryDto(c), productCount: direct, totalProductCount: total };
  });
}
/** Doublon (casse ignorée) au même niveau : deux catégories, ou deux sous-catégories de la même catégorie. */
async function assertFreeName(companyId: Id, parentId: Id | string | null, name: string, ignore?: Id) {
  const found = await Category.findOne({ companyId, parentId: parentId ?? null, name, ...(ignore && { _id: { $ne: ignore } }) }).collation(COLLATION).lean();
  if (found) throw AppError.conflict(parentId ? `La sous-catégorie « ${found.name} » existe déjà dans cette catégorie` : `La catégorie « ${found.name} » existe déjà`);
}
export async function createCategory(companyId: Id, d: { name: string; parentId?: string | null | undefined }) {
  if (d.parentId) {
    const p = await Category.findOne({ _id: d.parentId, companyId }).lean();
    if (!p) throw AppError.badRequest('Catégorie parente introuvable');
    if (p.parentId) throw AppError.badRequest('Deux niveaux maximum : catégorie et sous-catégorie');
    if (p.isArchived) throw AppError.conflict('Catégorie archivée : réactivez-la pour y ajouter une sous-catégorie');
  }
  await assertFreeName(companyId, d.parentId ?? null, d.name);
  const c = await Category.create({ companyId, name: d.name, parentId: d.parentId ?? null });
  return categoryDto(c);
}
export async function renameCategory(companyId: Id, id: string, name: string) {
  const current = await Category.findOne({ _id: id, companyId }).lean();
  if (!current) throw AppError.notFound('Catégorie introuvable');
  await assertFreeName(companyId, current.parentId ?? null, name, current._id);
  const c = await Category.findOneAndUpdate({ _id: id, companyId }, { name }, { returnDocument: 'after', runValidators: true }).lean();
  return categoryDto(c!);
}
/** Suppression d'une catégorie INUTILISÉE seulement : sinon archivage explicite (les articles ne sont jamais modifiés). */
export async function deleteCategory(companyId: Id, id: string) {
  const c = await Category.findOne({ _id: id, companyId }).lean();
  if (!c) throw AppError.notFound('Catégorie introuvable');
  const children = await Category.countDocuments({ companyId, parentId: c._id });
  const products = await Product.countDocuments({ companyId, categoryId: c._id });
  if (children || products) {
    const why = [children && `${children} sous-catégorie(s)`, products && `${products} article(s)`].filter(Boolean).join(' et ');
    throw new AppError(409, `Suppression impossible : ${why} ${c.parentId ? 'rattaché(s) à cette sous-catégorie' : 'rattaché(s) à cette catégorie'}. Archivez-la pour ne plus la proposer.`, 'CATEGORY_IN_USE', { children, products });
  }
  await Category.deleteOne({ _id: id, companyId });
  return c;
}
/** Archivage / réactivation. Archiver une catégorie archive aussi ses sous-catégories (aucun article n'est touché). */
export async function setCategoryArchived(companyId: Id, id: string, archived: boolean) {
  const c = await Category.findOne({ _id: id, companyId }).lean();
  if (!c) throw AppError.notFound('Catégorie introuvable');
  if (!!c.isArchived === archived) throw AppError.conflict(archived ? 'Catégorie déjà archivée' : 'Catégorie déjà active');
  if (!archived && c.parentId && (await Category.exists({ _id: c.parentId, companyId, isArchived: true }))) throw AppError.conflict('Réactivez d’abord la catégorie principale');
  const update = archived ? { $set: { isArchived: true, archivedAt: new Date() } } : { $set: { isArchived: false }, $unset: { archivedAt: 1 } };
  await Category.updateMany({ companyId, $or: [{ _id: c._id }, ...(archived ? [{ parentId: c._id }] : [])] }, update);
  return categoryDto({ ...c, isArchived: archived });
}

/** Unités : les trois unités fixes d'abord, puis les unités historiques (conservées, non proposées pour les nouveaux articles). */
export async function listUnits(companyId: Id) {
  await ensureFixedUnits(companyId);
  const units = await Unit.find({ companyId }).lean();
  const rank = (k?: string | null) => { const i = FIXED_UNITS.findIndex((f) => f.key === k); return i < 0 ? FIXED_UNITS.length : i; };
  return units.sort((a, b) => rank(a.fixedKey) - rank(b.fixedKey) || a.code.localeCompare(b.code, 'fr'))
    .map((u) => ({ id: u._id.toString(), code: u.code, name: u.name, fixed: !!u.fixedKey, fixedKey: u.fixedKey ?? null, decimals: unitDecimals(u) }));
}
const fixedUnits = () => new AppError(409, 'Les unités de mesure sont fixes : Pièce, Mètre et Kilogramme.', 'UNITS_FIXED');
export async function createUnit(): Promise<never> { throw fixedUnits(); }
export async function updateUnit(): Promise<never> { throw fixedUnits(); }
/** Seule une unité historique inutilisée peut être supprimée. */
export async function deleteUnit(companyId: Id, id: string) {
  const u = await Unit.findOne({ _id: id, companyId }).lean();
  if (!u) throw AppError.notFound('Unité introuvable');
  if (u.fixedKey) throw fixedUnits();
  if (await Product.exists({ companyId, unitId: u._id })) throw AppError.conflict('Des articles utilisent cette unité');
  await Unit.deleteOne({ _id: id, companyId });
  return u;
}
