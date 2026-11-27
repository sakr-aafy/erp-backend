import type { ClientSession, Types } from 'mongoose';
import { Setting } from '../../models/setting.model.js';
import { Supplier, SupplierActivity, SupplierCategory, type SupplierCategoryDoc } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';

type Id = Types.ObjectId;
type Lean = SupplierCategoryDoc & { _id: Id; createdAt?: Date; updatedAt?: Date };
type Actor = { userId?: Id | undefined; name?: string | undefined };

/** Catégories proposées à la première mise en service (document « Fiche Fournisseur ») ; ensuite entièrement administrables. */
export const DEFAULT_SUPPLIER_CATEGORIES = [
  'Fournisseur de machines', 'Fournisseur de pièces détachées', 'Transporteur', 'Transitaire', 'Compagnie d’assurance', 'Fournisseur de maintenance', 'Fournisseur de services généraux',
] as const;

const COLLATION = { locale: 'fr', strength: 2 } as const;
const dto = (c: Lean, supplierCount: number) => ({
  id: c._id.toString(), name: c.name, description: c.description ?? null, isActive: c.isActive !== false, supplierCount, createdAt: c.createdAt, updatedAt: c.updatedAt,
});

export async function list(companyId: Id, f: { q?: string | undefined; active?: boolean | undefined } = {}) {
  const filter: Record<string, unknown> = { companyId };
  if (f.active !== undefined) filter.isActive = f.active;
  if (f.q) filter.name = new RegExp(escapeRegex(f.q), 'i');
  const [cats, counts] = await Promise.all([
    SupplierCategory.find(filter).sort({ name: 1 }).collation(COLLATION).lean(),
    Supplier.aggregate<{ _id: Id | null; n: number }>([{ $match: { companyId } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
  ]);
  const by = new Map(counts.map((x) => [String(x._id), x.n]));
  return {
    items: cats.map((c) => dto(c as Lean, by.get(String(c._id)) ?? 0)),
    /** Fournisseurs sans catégorie (à classer manuellement). */
    unclassifiedCount: (by.get('null') ?? 0) + (by.get('undefined') ?? 0),
  };
}

async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const c = await SupplierCategory.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!c) throw AppError.notFound('Catégorie de fournisseurs introuvable');
  return c as Lean;
}
const countOf = (companyId: Id, id: Id) => Supplier.countDocuments({ companyId, categoryId: id });

async function assertFreeName(companyId: Id, name: string, exceptId?: Id) {
  const other = await SupplierCategory.findOne({ companyId, name, ...(exceptId && { _id: { $ne: exceptId } }) }).collation(COLLATION).select('name').lean();
  if (other) throw AppError.conflict(`La catégorie « ${other.name} » existe déjà`);
}
const duplicate = (e: unknown, name: string): never => { if ((e as { code?: number }).code === 11000) throw AppError.conflict(`La catégorie « ${name} » existe déjà`); throw e; };

export async function create(companyId: Id, d: { name: string; description?: string | null | undefined }) {
  await assertFreeName(companyId, d.name);
  try { const c = await SupplierCategory.create({ companyId, name: d.name, ...(d.description && { description: d.description }) }); return dto(c.toObject() as Lean, 0); }
  catch (e) { return duplicate(e, d.name); }
}
export async function update(companyId: Id, id: string, d: { name?: string | undefined; description?: string | null | undefined }) {
  const cur = await getOwn(companyId, id);
  if (d.name && d.name !== cur.name) await assertFreeName(companyId, d.name, cur._id);
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  if (d.name) $set.name = d.name;
  if (d.description !== undefined) { if (d.description) $set.description = d.description; else $unset.description = 1; }
  try {
    const u = await SupplierCategory.findOneAndUpdate({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true }).lean();
    return { category: dto((u ?? cur) as Lean, await countOf(companyId, cur._id)), previousName: cur.name };
  } catch (e) { return duplicate(e, d.name ?? cur.name); }
}
/** Une catégorie désactivée n'est plus proposée ; les fournisseurs déjà classés conservent leur classification. */
export async function setActive(companyId: Id, id: string, isActive: boolean) {
  const cur = await getOwn(companyId, id);
  await SupplierCategory.updateOne({ _id: cur._id, companyId }, { $set: { isActive } });
  return dto({ ...cur, isActive } as Lean, await countOf(companyId, cur._id));
}

/**
 * Suppression définitive : libre pour une catégorie inutilisée. Une catégorie utilisée exige une catégorie de réaffectation
 * (active) : les fournisseurs sont déplacés puis la catégorie supprimée, dans la même transaction. Aucun fournisseur n'est supprimé.
 */
export async function remove(companyId: Id, id: string, reassignTo: string | undefined, actor: Actor = {}) {
  return withTransaction(async (session) => {
    const cur = await getOwn(companyId, id, session);
    const used = await Supplier.find({ companyId, categoryId: cur._id }).session(session).select('_id').lean();
    let target: Lean | undefined;
    if (used.length) {
      if (!reassignTo) throw new AppError(409, `Catégorie utilisée par ${used.length} fournisseur(s) : choisissez une catégorie de réaffectation`, 'CATEGORY_IN_USE', { supplierCount: used.length });
      if (reassignTo === id) throw AppError.badRequest('Choisissez une autre catégorie de réaffectation');
      target = await getOwn(companyId, reassignTo, session);
      if (target.isActive === false) throw AppError.badRequest(`La catégorie « ${target.name} » est désactivée`);
      await Supplier.updateMany({ companyId, categoryId: cur._id }, { $set: { categoryId: target._id } }, { session });
      const at = new Date();
      await SupplierActivity.insertMany(used.map((s) => ({ companyId, supplierId: s._id, auto: true, kind: 'category_changed' as const, title: `Catégorie : ${cur.name} → ${target!.name}`, occurredAt: at, userId: actor.userId, userName: actor.name, meta: { from: cur.name, to: target!.name } })), { session });
    }
    await SupplierCategory.deleteOne({ _id: cur._id, companyId }, { session });
    return { name: cur.name, reassigned: used.length, reassignedTo: target?.name ?? null };
  });
}

/**
 * Initialisation idempotente des catégories par défaut : une seule fois par société, sans toucher aux catégories existantes
 * (comparaison sans tenir compte de la casse). Une catégorie supprimée ensuite n'est pas recréée.
 */
export async function initSupplierCategories(companyId: Id, opts: { dryRun?: boolean | undefined } = {}) {
  if (await Setting.exists({ companyId, supplierCategoriesInitialisedAt: { $exists: true } })) return 0;
  const existing = (await SupplierCategory.find({ companyId }).select('name').lean()).map((c) => c.name);
  const missing = DEFAULT_SUPPLIER_CATEGORIES.filter((n) => !existing.some((e) => e.localeCompare(n, 'fr', { sensitivity: 'accent' }) === 0));
  if (opts.dryRun) return missing.length;
  for (const name of missing) await SupplierCategory.create({ companyId, name }).catch((e: { code?: number }) => { if (e.code !== 11000) throw e; });
  await Setting.updateOne({ companyId }, { $set: { supplierCategoriesInitialisedAt: new Date() } });
  return missing.length;
}
