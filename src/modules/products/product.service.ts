import type { QueryFilter as FilterQuery, Types } from 'mongoose';
import { Category, Product, ProductSerial, Unit, type ProductDoc } from '../../models/product.model.js';
import { vatCodeExists } from '../../services/fiscal.service.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import type { Column } from '../../services/export.service.js';

type Id = Types.ObjectId;
type Lean = ProductDoc & { _id: Id; createdAt?: Date; categoryId?: any; unitId?: any; mainSupplierId?: any };
export interface ProductFilters { q?: string | undefined; categoryId?: string | undefined; kind?: 'product' | 'service' | undefined; supplierId?: string | undefined; active: 'true' | 'false' | 'all'; belowCost?: boolean | undefined }

const refId = (v: any): string | null => (v ? (v._id ?? v).toString() : null);

/** Coût retenu pour la marge et l'alerte : coût de revient (module 11) sinon prix d'achat. */
export const effectiveCost = (p: { costPriceMinor?: number | null | undefined; purchasePriceMinor?: number | undefined }) => p.costPriceMinor ?? p.purchasePriceMinor ?? 0;

export function toDto(p: Lean) {
  const cost = effectiveCost(p); const sale = p.salePriceMinor ?? 0; const margin = sale - cost;
  const cat = p.categoryId && typeof p.categoryId === 'object' && 'name' in p.categoryId ? p.categoryId : null;
  return {
    id: p._id.toString(), reference: p.reference, name: p.name, description: p.description ?? null, kind: p.kind,
    categoryId: refId(p.categoryId), categoryName: cat?.name ?? null,
    unitId: refId(p.unitId), unitCode: p.unitId?.code ?? null,
    purchasePriceMinor: p.purchasePriceMinor ?? 0, salePriceMinor: sale, costPriceMinor: p.costPriceMinor ?? null, effectiveCostMinor: cost,
    marginMinor: margin,
    marginRatePct: cost > 0 ? Math.round((margin / cost) * 10000) / 100 : null,   // marge / coût (à valider avec le métier)
    markPct: sale > 0 ? Math.round((margin / sale) * 10000) / 100 : null,          // marge / prix de vente
    belowCost: sale < cost,
    vatRateCode: p.vatRateCode, minStock: p.minStock ?? 0,
    mainSupplierId: refId(p.mainSupplierId), mainSupplierName: p.mainSupplierId?.name ?? null,
    hasSerial: !!p.hasSerial, isActive: !!p.isActive, createdAt: p.createdAt,
  };
}
export type ProductDto = ReturnType<typeof toDto>;
const warningsOf = (d: ProductDto) => (d.belowCost ? ['Le prix de vente est inférieur au coût de revient.'] : []);

const POPULATE = [{ path: 'categoryId', select: 'name parentId' }, { path: 'unitId', select: 'code name' }, { path: 'mainSupplierId', select: 'name' }];

async function buildFilter(companyId: Id, f: ProductFilters): Promise<FilterQuery<ProductDoc>> {
  const filter: FilterQuery<ProductDoc> = { companyId };
  if (f.active !== 'all') filter.isActive = f.active === 'true';
  if (f.kind) filter.kind = f.kind;
  if (f.supplierId) filter.mainSupplierId = f.supplierId;
  if (f.categoryId) {
    const children = await Category.find({ companyId, parentId: f.categoryId }).select('_id').lean(); // une famille inclut ses sous-familles
    filter.categoryId = { $in: [f.categoryId as never, ...children.map((c) => c._id)] };
  }
  if (f.belowCost) filter.$expr = { $lt: ['$salePriceMinor', { $ifNull: ['$costPriceMinor', '$purchasePriceMinor'] }] };
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ reference: rx }, { name: rx }, { description: rx }]; }
  return filter;
}

export async function list(companyId: Id, f: ProductFilters & { page: number; limit: number; sort?: string | undefined }) {
  const filter = await buildFilter(companyId, f);
  const sort = buildSort(f.sort, ['reference', 'name', 'salePriceMinor', 'purchasePriceMinor', 'createdAt'], { reference: 1, _id: 1 });
  const [items, total] = await Promise.all([
    Product.find(filter).populate(POPULATE).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Product.countDocuments(filter),
  ]);
  return { items: items.map((p) => toDto(p as Lean)), total, page: f.page, limit: f.limit };
}

export async function getOwn(companyId: Id, id: string) {
  const p = await Product.findOne({ _id: id, companyId }).populate(POPULATE).lean();
  if (!p) throw AppError.notFound('Article introuvable');
  return p as Lean;
}
export async function get(companyId: Id, id: string) {
  const dto = toDto(await getOwn(companyId, id));
  const serialCount = await ProductSerial.countDocuments({ companyId, productId: id });
  return { ...dto, serialCount, warnings: warningsOf(dto) };
}

type Input = Partial<{ reference: string; name: string; description: string; kind: 'product' | 'service'; categoryId: string | null; unitId: string; purchasePriceMinor: number;
  salePriceMinor: number; vatRateCode: string; minStock: number; mainSupplierId: string | null; hasSerial: boolean }>;

async function validateRefs(companyId: Id, d: Input) {
  if (d.categoryId && !(await Category.exists({ _id: d.categoryId, companyId }))) throw AppError.badRequest('Catégorie invalide');
  if (d.unitId && !(await Unit.exists({ _id: d.unitId, companyId }))) throw AppError.badRequest('Unité de mesure invalide');
  if (d.mainSupplierId && !(await Supplier.exists({ _id: d.mainSupplierId, companyId }))) throw AppError.badRequest('Fournisseur principal invalide');
  if (d.vatRateCode && !(await vatCodeExists(companyId, d.vatRateCode))) {
    throw AppError.badRequest(`Code de TVA « ${d.vatRateCode} » inconnu : aucune règle fiscale validée (Fiscalité > TVA)`);
  }
}

export async function create(companyId: Id, d: Input) {
  await validateRefs(companyId, d);
  const p = await Product.create({ ...d, companyId });
  const dto = toDto(await getOwn(companyId, p._id.toString()));
  return { ...dto, warnings: warningsOf(dto) };
}

export async function update(companyId: Id, id: string, d: Input) {
  const existing = await getOwn(companyId, id);
  await validateRefs(companyId, d);
  if (d.hasSerial === false && existing.hasSerial && (await ProductSerial.exists({ companyId, productId: id }))) {
    throw AppError.conflict('Des numéros de série existent : impossible de désactiver le suivi par numéro de série');
  }
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(d)) { if (v === undefined || v === null) $unset[k] = 1; else $set[k] = v; }
  await Product.updateOne({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { runValidators: true });
  const dto = toDto(await getOwn(companyId, id));
  return { ...dto, warnings: warningsOf(dto) };
}

export async function setActive(companyId: Id, id: string, isActive: boolean) {
  await getOwn(companyId, id);
  await Product.updateOne({ _id: id, companyId }, { isActive });
  return toDto(await getOwn(companyId, id));
}

/** Duplication : nouvelle référence obligatoire (unicité) ; ni coût de revient ni numéros de série copiés. */
export async function duplicate(companyId: Id, id: string, d: { reference: string; name?: string | undefined }) {
  const src = await getOwn(companyId, id);
  const p = await Product.create({
    companyId, reference: d.reference, name: d.name ?? `${src.name} (copie)`, description: src.description, kind: src.kind,
    categoryId: refId(src.categoryId) ?? undefined, unitId: refId(src.unitId)!, purchasePriceMinor: src.purchasePriceMinor, salePriceMinor: src.salePriceMinor,
    vatRateCode: src.vatRateCode, minStock: src.minStock, mainSupplierId: refId(src.mainSupplierId) ?? undefined, hasSerial: src.hasSerial, isActive: true,
  });
  return toDto(await getOwn(companyId, p._id.toString()));
}

export async function remove(companyId: Id, id: string) {
  const p = await getOwn(companyId, id);
  if (await ProductSerial.exists({ companyId, productId: id })) throw AppError.conflict('Suppression impossible : des numéros de série sont enregistrés. Désactivez l’article.');
  await assertNotReferenced('product', companyId, p._id);
  await Product.deleteOne({ _id: id, companyId });
  return p;
}

// ---- Numéros de série (machines) ----
export async function listSerials(companyId: Id, id: string, q: { page: number; limit: number; q?: string | undefined; status?: string | undefined }) {
  await getOwn(companyId, id);
  const filter: Record<string, unknown> = { companyId, productId: id };
  if (q.status) filter.status = q.status;
  if (q.q) filter.serialNumber = new RegExp(escapeRegex(q.q), 'i');
  const [items, total] = await Promise.all([
    ProductSerial.find(filter).sort({ serialNumber: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    ProductSerial.countDocuments(filter),
  ]);
  return { items: items.map((s) => ({ id: s._id.toString(), serialNumber: s.serialNumber, status: s.status, note: s.note ?? null })), total, page: q.page, limit: q.limit };
}
export async function addSerials(companyId: Id, id: string, serials: string[], note?: string) {
  const p = await getOwn(companyId, id);
  if (!p.hasSerial) throw AppError.badRequest('Cet article n’est pas géré par numéro de série');
  const unique = [...new Set(serials)];
  const existing = await ProductSerial.find({ companyId, productId: id, serialNumber: { $in: unique } }).select('serialNumber').lean();
  if (existing.length) throw AppError.conflict(`Numéros de série déjà enregistrés : ${existing.map((e) => e.serialNumber).join(', ')}`);
  await ProductSerial.insertMany(unique.map((serialNumber) => ({ companyId, productId: id, serialNumber, note })));
  return { added: unique.length };
}
export async function removeSerial(companyId: Id, id: string, serialId: string) {
  const s = await ProductSerial.findOne({ _id: serialId, companyId, productId: id });
  if (!s) throw AppError.notFound('Numéro de série introuvable');
  if (s.status !== 'available') throw AppError.conflict('Seul un numéro de série disponible peut être supprimé');
  await s.deleteOne();
  return s;
}

// ---- Export ----
export async function exportRows(companyId: Id, f: ProductFilters) {
  const filter = await buildFilter(companyId, f);
  const rows = (await Product.find(filter).populate(POPULATE).sort({ reference: 1 }).limit(50000).lean()) as Lean[];
  const parents = await Category.find({ companyId }).lean();
  const byId = new Map(parents.map((c) => [c._id.toString(), c]));
  return rows.map((p) => {
    const cat = byId.get(refId(p.categoryId) ?? '');
    const parent = cat?.parentId ? byId.get(cat.parentId.toString()) : undefined;
    return { ...toDto(p), family: parent?.name ?? cat?.name ?? null, subFamily: parent ? cat?.name ?? null : null };
  });
}
type ExportDto = ProductDto & { family: string | null; subFamily: string | null };
export const exportColumns = (d: number, extended: boolean): Column<ExportDto>[] => {
  const m = (v: number) => Number((v / 10 ** d).toFixed(d));
  return [
    { header: 'Référence', key: 'reference', width: 16, value: (p) => p.reference },
    { header: 'Désignation', key: 'name', width: 34, value: (p) => p.name },
    { header: 'Type', key: 'kind', width: 10, value: (p) => (p.kind === 'service' ? 'Service' : 'Produit') },
    { header: 'Famille', key: 'family', width: 16, value: (p) => p.family },
    { header: 'Sous-famille', key: 'sub', width: 16, value: (p) => p.subFamily },
    { header: 'Unité', key: 'unit', width: 8, value: (p) => p.unitCode },
    { header: 'Prix d\'achat', key: 'purchase', width: 12, align: 'right', value: (p) => m(p.purchasePriceMinor) },
    { header: 'Prix de vente', key: 'sale', width: 12, align: 'right', value: (p) => m(p.salePriceMinor) },
    { header: 'Code TVA', key: 'vat', width: 9, value: (p) => p.vatRateCode },
    ...(extended ? [
      { header: 'Coût de revient', key: 'cost', width: 12, align: 'right' as const, value: (p: ExportDto) => m(p.effectiveCostMinor) },
      { header: 'Marge', key: 'margin', width: 12, align: 'right' as const, value: (p: ExportDto) => m(p.marginMinor) },
      { header: 'Marge / coût (%)', key: 'rate', width: 10, align: 'right' as const, value: (p: ExportDto) => p.marginRatePct },
    ] : []),
    { header: 'Stock minimum', key: 'min', width: 10, align: 'right', value: (p) => p.minStock },
    { header: 'Fournisseur', key: 'sup', width: 22, value: (p) => p.mainSupplierName },
    { header: 'Série', key: 'serial', width: 7, value: (p) => (p.hasSerial ? 'Oui' : 'Non') },
    { header: 'Actif', key: 'active', width: 7, value: (p) => (p.isActive ? 'Oui' : 'Non') },
  ];
};
