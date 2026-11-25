import type { ClientSession, QueryFilter as FilterQuery, Types } from 'mongoose';
import { Category, PRODUCT_STATUSES, Product, ProductActivity, ProductDocument, ProductSerial, ProductStockSetting, Unit, type ProductDoc } from '../../models/product.model.js';
import { StockLevel, Warehouse } from '../../models/logistics.model.js';
import { Setting } from '../../models/setting.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { vatCodeExists } from '../../services/fiscal.service.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import type { Column } from '../../services/export.service.js';
import { resolveRate } from '../imports/import.service.js';
import { toBaseMinor } from '../imports/import.calc.js';
import { deleteFile, PRODUCT_BUCKET } from '../customers/customer.files.js';
import { margins, packagingProblems, ttcOf, vatFor, volumes } from './product.pricing.js';

type Id = Types.ObjectId;
type Lean = ProductDoc & { _id: Id; createdAt?: Date; categoryId?: any; unitId?: any; mainSupplierId?: any };
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export interface ProductFilters {
  q?: string | undefined; categoryId?: string | undefined; kind?: 'product' | 'service' | undefined; supplierId?: string | undefined; brand?: string | undefined; warehouseId?: string | undefined;
  status?: 'open' | 'all' | ProductStatus | undefined; active?: 'true' | 'false' | 'all' | undefined; stockState?: 'out' | 'below_min' | undefined; belowCost?: boolean | undefined;
}
export interface Actor { userId?: Id | undefined; name?: string | undefined }
/** Ce que l'utilisateur a le droit de voir (la permission « consulter un article » ne donne ni prix d'achat, ni marges, ni données douanières). */
export interface Access { purchase: boolean; cost: boolean; customs: boolean; stock: boolean }
export const accessOf = (perms: ReadonlySet<string>): Access => ({
  purchase: ['costCalculation:view', 'purchases:view', 'imports:view'].some((p) => perms.has(p)), cost: perms.has('costCalculation:view'), customs: perms.has('imports:view') || perms.has('products:update'), stock: perms.has('inventory:view'),
});
export const FULL: Access = { purchase: true, cost: true, customs: true, stock: true };

export const STATUS_LABEL: Record<ProductStatus, string> = { active: 'Actif', inactive: 'Inactif', archived: 'Archivé', blocked: 'Bloqué' };
export const effectiveStatus = (p: { status?: string | null; isActive?: boolean | null }): ProductStatus => (p.status as ProductStatus | undefined) ?? (p.isActive === false ? 'inactive' : 'active');
const refId = (v: any): string | null => (v ? (v._id ?? v).toString() : null);

/** Coût retenu pour la marge et l'alerte : coût de revient réel (module 11), sinon coût estimé saisi, sinon prix d'achat. */
export const effectiveCost = (p: { costPriceMinor?: number | null | undefined; estimatedCostMinor?: number | null | undefined; purchasePriceMinor?: number | undefined }) => p.costPriceMinor ?? p.estimatedCostMinor ?? p.purchasePriceMinor ?? 0;

interface Ctx { access: Access; cats: Map<string, { name: string; parentId: string | null }>; vat: Map<string, Awaited<ReturnType<typeof vatFor>>>; stock?: Map<string, number> | undefined; hasSerialCount?: number | undefined }

function categoryPath(p: Lean, cats: Ctx['cats']) {
  const id = refId(p.categoryId); const c = id ? cats.get(id) : undefined;
  if (!id || !c) return { familyId: null, familyName: null, subId: null, subName: null };
  if (c.parentId && cats.get(c.parentId)) return { familyId: c.parentId, familyName: cats.get(c.parentId)!.name, subId: id, subName: c.name };
  return { familyId: id, familyName: c.name, subId: null, subName: null };
}

export function toDto(p: Lean, ctx: Ctx) {
  const { access } = ctx; const status = effectiveStatus(p);
  const vat = ctx.vat.get(p.vatRateCode.toUpperCase()) ?? null; const sale = p.salePriceMinor ?? 0;
  const saleTtc = vat ? ttcOf(sale, vat) : null; const path = categoryPath(p, ctx.cats);
  const pk = p.packaging; const vols = volumes(pk);
  const cost = effectiveCost(p);
  const m = access.cost && vat && saleTtc !== null ? margins(sale, cost, saleTtc, vat.ratePct) : null;
  const dto = {
    id: p._id.toString(), reference: p.reference, name: p.name, brand: p.brand ?? null, model: p.model ?? null, description: p.description ?? null, kind: p.kind,
    status, statusLabel: STATUS_LABEL[status], statusReason: p.statusReason ?? null, statusChangedAt: p.statusChangedAt ?? null, isActive: status === 'active', canUse: status === 'active',
    categoryId: refId(p.categoryId), categoryName: p.categoryId?.name ?? null, ...path,
    unitId: refId(p.unitId), unitCode: p.unitId?.code ?? null, unitName: p.unitId?.name ?? null,
    vatRateCode: p.vatRateCode, vatRatePct: vat?.ratePct ?? null, vatRegime: vat?.regime ?? null,
    salePriceMinor: sale, saleTtcMinor: saleTtc, minSalePriceMinor: p.minSalePriceMinor ?? null, maxDiscountPct: p.maxDiscountPct ?? null,
    mainSupplierId: refId(p.mainSupplierId), mainSupplierName: p.mainSupplierId?.name ?? null,
    minStock: p.minStock ?? 0, hasSerial: !!p.hasSerial, mainPhotoId: p.mainPhotoId?.toString() ?? null, hasPhoto: !!p.mainPhotoId,
    packaging: kindOk(p) ? {
      lengthMm: pk?.lengthMm ?? null, widthMm: pk?.widthMm ?? null, heightMm: pk?.heightMm ?? null, netWeightKg: pk?.netWeightKg ?? null, grossWeightKg: pk?.grossWeightKg ?? null,
      type: pk?.type ?? null, typeLabel: pk?.typeLabel ?? null, parcelCount: pk?.parcelCount ?? null, dimensionsPerParcel: pk?.dimensionsPerParcel !== false, ...vols,
    } : null,
    stockQty: access.stock && ctx.stock ? ctx.stock.get(p._id.toString()) ?? 0 : null, createdAt: p.createdAt,
    access,
  };
  const purchase = access.purchase ? {
    purchasePriceMinor: p.purchasePriceMinor ?? 0, purchaseCurrency: p.purchaseCurrency ?? null, purchasePriceForeignMinor: p.purchasePriceForeignMinor ?? null, purchaseRate: p.purchaseRate ?? null, purchaseRateDate: p.purchaseRateDate ?? null,
    estimatedCostMinor: p.estimatedCostMinor ?? null,
  } : { purchasePriceMinor: null, purchaseCurrency: null, purchasePriceForeignMinor: null, purchaseRate: null, purchaseRateDate: null, estimatedCostMinor: null };
  const costPart = access.cost ? {
    costPriceMinor: p.costPriceMinor ?? null, effectiveCostMinor: cost, belowCost: sale < cost,
    marginMinor: m?.marginHtMinor ?? sale - cost, marginRatePct: m?.marginRatePct ?? (cost > 0 ? Math.round(((sale - cost) / cost) * 10000) / 100 : null), markPct: m?.markPct ?? (sale > 0 ? Math.round(((sale - cost) / sale) * 10000) / 100 : null),
    marginTtcMinor: m?.marginTtcMinor ?? null, marginTtcRatePct: m?.marginTtcRatePct ?? null, costTtcMinor: m?.costTtcMinor ?? null,
  } : { costPriceMinor: null, effectiveCostMinor: null, belowCost: null, marginMinor: null, marginRatePct: null, markPct: null, marginTtcMinor: null, marginTtcRatePct: null, costTtcMinor: null };
  const c = p.customs;
  const customs = access.customs ? { supplierHsCode: c?.supplierHsCode ?? null, tnHsCode: c?.tnHsCode ?? null, ddPct: c?.ddPct ?? null, fodecPct: c?.fodecPct ?? null, rpdPct: c?.rpdPct ?? null,
    originCountry: c?.originCountry ?? null, provenanceCountry: c?.provenanceCountry ?? null, specialRegulation: c?.specialRegulation ?? null } : null;
  return { ...dto, ...purchase, ...costPart, customs };
}
const kindOk = (p: Lean) => p.kind !== 'service';
export type ProductDto = ReturnType<typeof toDto>;

const POPULATE = [{ path: 'categoryId', select: 'name parentId' }, { path: 'unitId', select: 'code name' }, { path: 'mainSupplierId', select: 'name' }];

async function context(companyId: Id, access: Access, items: Lean[], stock?: Map<string, number>): Promise<Ctx> {
  const cats = new Map((await Category.find({ companyId }).select('name parentId').lean()).map((c) => [c._id.toString(), { name: c.name, parentId: c.parentId?.toString() ?? null }]));
  const codes = [...new Set(items.map((p) => p.vatRateCode.toUpperCase()))]; const vat = new Map<string, Awaited<ReturnType<typeof vatFor>>>();
  await Promise.all(codes.map(async (c) => vat.set(c, await vatFor(companyId, c))));
  return { access, cats, vat, stock };
}

/** Quantités disponibles par article (somme des magasins, ou d'un magasin) : lues dans StockLevel, jamais copiées. */
async function stockMap(companyId: Id, ids: Id[], warehouseId?: string): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await StockLevel.aggregate<{ _id: Id; qty: number }>([{ $match: { companyId, productId: { $in: ids }, ...(warehouseId && { warehouseId: new (await import('mongoose')).Types.ObjectId(warehouseId) }) } }, { $group: { _id: '$productId', qty: { $sum: '$qty' } } }]);
  return new Map(rows.map((r) => [r._id.toString(), r.qty]));
}

async function buildFilter(companyId: Id, f: ProductFilters, access: Access): Promise<FilterQuery<ProductDoc>> {
  const filter: FilterQuery<ProductDoc> = { companyId }; const and: FilterQuery<ProductDoc>[] = [];
  const status = f.status ?? (f.active === 'true' ? 'active' : f.active === 'false' ? 'inactive' : f.active === 'all' ? 'all' : 'open');
  const legacyActive = f.active === 'false'; // ancien filtre « inactifs » = tout ce qui n'est pas actif (hors archivés historiques)
  if (legacyActive) and.push({ $or: [{ status: { $in: ['inactive', 'blocked', 'archived'] } }, { status: { $exists: false }, isActive: false }] });
  else if (status === 'open') and.push({ status: { $ne: 'archived' } });
  else if (status === 'active') and.push({ $or: [{ status: 'active' }, { status: { $exists: false }, isActive: { $ne: false } }] });
  else if (status === 'inactive') and.push({ $or: [{ status: 'inactive' }, { status: { $exists: false }, isActive: false }] });
  else if (status !== 'all') filter.status = status as ProductStatus;
  if (f.kind) filter.kind = f.kind;
  if (f.brand) filter.brand = new RegExp(`^${escapeRegex(f.brand)}$`, 'i');
  if (f.supplierId) filter.mainSupplierId = f.supplierId;
  if (f.categoryId) {
    const children = await Category.find({ companyId, parentId: f.categoryId }).select('_id').lean(); // une famille inclut ses sous-familles
    filter.categoryId = { $in: [f.categoryId as never, ...children.map((c) => c._id)] };
  }
  if (f.belowCost) { if (!access.cost) throw AppError.forbidden('Permission requise : costCalculation:view'); and.push({ $expr: { $lt: ['$salePriceMinor', { $ifNull: ['$costPriceMinor', { $ifNull: ['$estimatedCostMinor', '$purchasePriceMinor'] }] }] } }); }
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), 'i');
    const sup = await Supplier.find({ companyId, name: rx }).select('_id').limit(200).lean();
    and.push({ $or: [{ reference: rx }, { name: rx }, { brand: rx }, { model: rx }, { description: rx }, ...(sup.length ? [{ mainSupplierId: { $in: sup.map((s) => s._id) } }] : [])] });
  }
  if ((f.stockState || f.warehouseId) && !access.stock) throw AppError.forbidden('Permission requise : inventory:view');
  if (f.stockState) { // rupture / sous le minimum : calculés sur les niveaux réels (magasin choisi ou total)
    const prods = await Product.find({ companyId, kind: 'product' }).select('minStock').lean();
    const stock = await stockMap(companyId, prods.map((p) => p._id), f.warehouseId);
    const settings = f.warehouseId ? new Map((await ProductStockSetting.find({ companyId, warehouseId: f.warehouseId }).lean()).map((s) => [s.productId.toString(), s.minQty ?? null])) : new Map<string, number | null>();
    const ids = prods.filter((p) => {
      const q = stock.get(p._id.toString()) ?? 0; const min = settings.get(p._id.toString()) ?? p.minStock ?? 0;
      return f.stockState === 'out' ? q <= 0 : min > 0 && q < min;
    }).map((p) => p._id);
    and.push({ _id: { $in: ids } });
  }
  if (and.length) filter.$and = and;
  return filter;
}

const SORTABLE = ['reference', 'name', 'brand', 'model', 'salePriceMinor', 'purchasePriceMinor', 'createdAt', 'status'];
export async function list(companyId: Id, f: ProductFilters & { page: number; limit: number; sort?: string | undefined }, access: Access = FULL) {
  const filter = await buildFilter(companyId, f, access);
  const sortField = f.sort?.replace(/^-/, ''); const sort = buildSort(!access.purchase && sortField === 'purchasePriceMinor' ? undefined : f.sort, SORTABLE, { reference: 1, _id: 1 });
  const collation = { locale: 'fr', strength: 2 }; // tri insensible à la casse
  const [items, total] = await Promise.all([
    Product.find(filter).populate(POPULATE).sort(sort).collation(collation).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Product.countDocuments(filter),
  ]);
  const stock = access.stock ? await stockMap(companyId, items.map((p) => p._id), f.warehouseId) : undefined;
  const ctx = await context(companyId, access, items as Lean[], stock);
  return { items: items.map((p) => toDto(p as Lean, ctx)), total, page: f.page, limit: f.limit };
}

export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const p = await Product.findOne({ _id: id, companyId }).populate(POPULATE).session(session ?? null).lean();
  if (!p) throw AppError.notFound('Article introuvable');
  return p as Lean;
}
const warningsOf = (d: ProductDto) => {
  const w: string[] = [];
  if (d.belowCost) w.push('Le prix de vente est inférieur au coût de revient.');
  if (d.minSalePriceMinor !== null && d.salePriceMinor < d.minSalePriceMinor) w.push('Le prix de vente est inférieur au prix minimum de vente.');
  if (d.vatRatePct === null) w.push('TVA : aucune règle validée applicable (Fiscalité).');
  return w;
};
export async function get(companyId: Id, id: string, access: Access = FULL) {
  const p = await getOwn(companyId, id); const stock = access.stock ? await stockMap(companyId, [p._id]) : undefined; const ctx = await context(companyId, access, [p], stock);
  const dto = toDto(p, ctx); const serialCount = await ProductSerial.countDocuments({ companyId, productId: id });
  return { ...dto, serialCount, warnings: warningsOf(dto) };
}

// ---------- Écriture ----------
type Pk = { lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null; netWeightKg?: number | null; grossWeightKg?: number | null; type?: string | null; typeLabel?: string | null; parcelCount?: number | null; dimensionsPerParcel?: boolean };
type Cu = { supplierHsCode?: string | null; tnHsCode?: string | null; ddPct?: number | null; fodecPct?: number | null; rpdPct?: number | null; originCountry?: string | null; provenanceCountry?: string | null; specialRegulation?: string | null };
export type Input = Partial<{
  reference: string; name: string; brand: string | null; model: string | null; description: string; kind: 'product' | 'service'; categoryId: string | null; unitId: string; purchasePriceMinor: number; salePriceMinor: number;
  purchaseCurrency: string | null; purchasePriceForeignMinor: number | null; estimatedCostMinor: number | null; minSalePriceMinor: number | null; maxDiscountPct: number | null;
  vatRateCode: string; minStock: number; mainSupplierId: string | null; hasSerial: boolean; packaging: Pk; customs: Cu;
}>;

async function validateRefs(companyId: Id, d: Input) {
  if (d.categoryId && !(await Category.exists({ _id: d.categoryId, companyId }))) throw AppError.badRequest('Catégorie invalide');
  if (d.unitId && !(await Unit.exists({ _id: d.unitId, companyId }))) throw AppError.badRequest('Unité de vente invalide');
  if (d.mainSupplierId && !(await Supplier.exists({ _id: d.mainSupplierId, companyId }))) throw AppError.badRequest('Fournisseur habituel invalide');
  if (d.vatRateCode && !(await vatCodeExists(companyId, d.vatRateCode))) throw AppError.badRequest(`Code de TVA « ${d.vatRateCode} » inconnu : aucune règle fiscale validée (Fiscalité > TVA)`);
  const problems = packagingProblems(d.packaging as never); if (problems.length) throw AppError.badRequest(problems.join(' ; '));
  if (d.minSalePriceMinor != null && d.salePriceMinor != null && d.minSalePriceMinor > d.salePriceMinor) throw AppError.badRequest('Le prix minimum de vente ne peut pas dépasser le prix de vente');
}

/** Contre-valeur du prix d'achat en devise de base : taux enregistré (module Importations / taux de change), plus petite unité de chaque devise. */
async function convertPurchase(companyId: Id, currency: string, foreignMinor: number) {
  const s = await Setting.findOne({ companyId }).lean(); const base = s?.baseCurrency ?? 'TND';
  const cur = s?.currencies.find((c) => c.code === currency); const baseCur = s?.currencies.find((c) => c.code === base);
  if (!cur) throw AppError.badRequest(`Devise « ${currency} » non configurée dans les paramètres`);
  const { rate, rateDate } = await resolveRate(companyId, currency, new Date());
  return { baseMinor: toBaseMinor(foreignMinor, rate, cur.decimals, baseCur?.decimals ?? 3), rate, rateDate };
}

/** Normalise les champs calculés : devise d'achat, volumes, statut. Le serveur recalcule toujours (jamais confiance au client). */
async function normalise(companyId: Id, d: Input, existing?: Lean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...d };
  const s = await Setting.findOne({ companyId }).lean(); const base = s?.baseCurrency ?? 'TND';
  const touchedCur = 'purchaseCurrency' in d || 'purchasePriceForeignMinor' in d;
  if (touchedCur) {
    const cur = (d.purchaseCurrency === undefined ? existing?.purchaseCurrency : d.purchaseCurrency) ?? null; const foreign = d.purchasePriceForeignMinor === undefined ? existing?.purchasePriceForeignMinor ?? null : d.purchasePriceForeignMinor;
    if (cur && cur !== base) {
      if (foreign == null) throw AppError.badRequest('Prix d’achat en devise étrangère requis');
      const c = await convertPurchase(companyId, cur, foreign);
      Object.assign(out, { purchaseCurrency: cur, purchasePriceForeignMinor: foreign, purchasePriceMinor: c.baseMinor, purchaseRate: c.rate, purchaseRateDate: c.rateDate });
    } else Object.assign(out, { purchaseCurrency: null, purchasePriceForeignMinor: null, purchaseRate: null, purchaseRateDate: null }); // achat en devise de base : prix saisi directement
  }
  if (d.packaging) {
    const merged = { ...(existing?.packaging ? (existing.packaging as unknown as Pk) : {}), ...d.packaging };
    const v = volumes(merged); out.packaging = { ...merged, volumeM3: v.volumeM3 ?? null, totalVolumeM3: v.totalVolumeM3 ?? null };
  }
  return out;
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const TECH = ['reference', 'name', 'brand', 'model', 'description', 'kind', 'categoryId', 'unitId', 'vatRateCode', 'minStock', 'mainSupplierId', 'hasSerial', 'packaging', 'customs'] as const;
const FIELD_LABEL: Record<string, string> = { reference: 'code', name: 'nom', brand: 'marque', model: 'modèle', description: 'description', kind: 'type', categoryId: 'catégorie', unitId: 'unité', vatRateCode: 'TVA', minStock: 'stock minimum', mainSupplierId: 'fournisseur habituel', hasSerial: 'suivi par numéro de série', packaging: 'packaging et poids', customs: 'douane' };

async function logAuto(companyId: Id, productId: Id | string, kind: string, title: string, actor: Actor, meta?: Record<string, unknown>, description?: string) {
  await ProductActivity.create({ companyId, productId, auto: true, kind: kind as never, title, ...(description && { description }), occurredAt: new Date(), userId: actor.userId, userName: actor.name, ...(meta && { meta }) });
}
export { logAuto as logProductAuto };

export async function create(companyId: Id, d: Input, access: Access, actor: Actor = {}) {
  if (!access.purchase && (d.purchasePriceMinor || d.purchaseCurrency || d.purchasePriceForeignMinor || d.estimatedCostMinor)) throw AppError.forbidden('Permission requise pour renseigner les prix d’achat : costCalculation:view, purchases:view ou imports:view');
  await validateRefs(companyId, d);
  const data = await normalise(companyId, d);
  const p = await Product.create({ ...data, companyId, status: 'active', isActive: true });
  await logAuto(companyId, p._id, 'product_created', 'Article créé', actor, { reference: p.reference });
  return get(companyId, p._id.toString(), access);
}

export async function update(companyId: Id, id: string, d: Input, access: Access, actor: Actor = {}) {
  const existing = await getOwn(companyId, id);
  if (effectiveStatus(existing) === 'archived') throw AppError.conflict('Article archivé : réactivez-le avant de le modifier');
  const wantsPurchase = ['purchasePriceMinor', 'purchaseCurrency', 'purchasePriceForeignMinor', 'estimatedCostMinor'].some((k) => k in d);
  if (wantsPurchase && !access.purchase) throw AppError.forbidden('Permission requise pour modifier les prix d’achat : costCalculation:view, purchases:view ou imports:view');
  if (d.customs && !access.customs) throw AppError.forbidden('Permission requise pour modifier les données douanières');
  await validateRefs(companyId, { ...d, ...(d.minSalePriceMinor != null && d.salePriceMinor === undefined && { salePriceMinor: existing.salePriceMinor ?? 0 }), ...(d.salePriceMinor != null && d.minSalePriceMinor === undefined && existing.minSalePriceMinor != null && { minSalePriceMinor: existing.minSalePriceMinor }) });
  if (d.hasSerial === false && existing.hasSerial && (await ProductSerial.exists({ companyId, productId: id }))) throw AppError.conflict('Des numéros de série existent : impossible de désactiver le suivi par numéro de série');
  const data = await normalise(companyId, d, existing);
  // Champs imbriqués : mise à jour champ par champ (les autres champs du groupe sont conservés) ; null / undefined = effacer
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  const put = (k: string, v: unknown) => { if (v === undefined || v === null) $unset[k] = 1; else $set[k] = v; };
  for (const [k, v] of Object.entries(data)) {
    if ((k === 'packaging' || k === 'customs') && v && typeof v === 'object') for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(`${k}.${k2}`, v2);
    else put(k, v);
  }
  if (!Object.keys($set).length && !Object.keys($unset).length) return get(companyId, id, access);
  await Product.updateOne({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { runValidators: true });
  const after = await getOwn(companyId, id);

  // Événements automatiques (historique des prix et des informations) — générés uniquement pour de vrais changements
  const val = (x: Lean, k: string) => { const v = (x as unknown as Record<string, any>)[k]; return k === 'categoryId' || k === 'unitId' || k === 'mainSupplierId' ? refId(v) : v && typeof v === 'object' && 'toObject' in v ? v.toObject() : v; };
  const changedTech = TECH.filter((k) => k in d && !eq(val(existing, k), val(after, k)));
  if (changedTech.length) await logAuto(companyId, id, 'technical_changed', 'Informations modifiées', actor, { fields: changedTech }, changedTech.map((k) => FIELD_LABEL[k]).join(', '));
  const pChanged = (existing.purchasePriceMinor ?? 0) !== (after.purchasePriceMinor ?? 0) || (existing.estimatedCostMinor ?? null) !== (after.estimatedCostMinor ?? null) || (existing.purchaseCurrency ?? null) !== (after.purchaseCurrency ?? null) || (existing.purchasePriceForeignMinor ?? null) !== (after.purchasePriceForeignMinor ?? null);
  if (pChanged) await logAuto(companyId, id, 'purchase_price_changed', 'Prix d’achat modifié', actor, { purchaseFrom: existing.purchasePriceMinor ?? 0, purchaseTo: after.purchasePriceMinor ?? 0, estimatedFrom: existing.estimatedCostMinor ?? null, estimatedTo: after.estimatedCostMinor ?? null, currencyFrom: existing.purchaseCurrency ?? null, currencyTo: after.purchaseCurrency ?? null, foreignFrom: existing.purchasePriceForeignMinor ?? null, foreignTo: after.purchasePriceForeignMinor ?? null });
  const sChanged = (existing.salePriceMinor ?? 0) !== (after.salePriceMinor ?? 0) || (existing.minSalePriceMinor ?? null) !== (after.minSalePriceMinor ?? null) || (existing.maxDiscountPct ?? null) !== (after.maxDiscountPct ?? null);
  if (sChanged) await logAuto(companyId, id, 'sale_price_changed', 'Prix de vente modifié', actor, { saleFrom: existing.salePriceMinor ?? 0, saleTo: after.salePriceMinor ?? 0, minFrom: existing.minSalePriceMinor ?? null, minTo: after.minSalePriceMinor ?? null, discountFrom: existing.maxDiscountPct ?? null, discountTo: after.maxDiscountPct ?? null });
  return get(companyId, id, access);
}

/**
 * Statuts et conséquences (voir docs/15-FICHE-ARTICLE.md) : seul un article ACTIF peut être vendu ou acheté ; un article inactif garde ses mouvements correctifs
 * de stock ; bloqué : plus d'entrée de stock ; archivé : plus aucune nouvelle opération. Un archivé ne peut être que réactivé. Les opérations passées restent consultables.
 */
export async function setStatus(companyId: Id, id: string, status: ProductStatus, actor: Actor = {}, reason?: string, access: Access = FULL) {
  const p = await getOwn(companyId, id); const from = effectiveStatus(p);
  if (from === status) throw AppError.conflict(`L’article est déjà « ${STATUS_LABEL[status].toLowerCase()} »`);
  if (from === 'archived' && status !== 'active') throw AppError.conflict('Un article archivé ne peut être que réactivé (statut Actif)');
  const $set: Record<string, unknown> = { status, isActive: status === 'active', statusChangedAt: new Date() }; const $unset: Record<string, 1> = {};
  if (reason) $set.statusReason = reason; else $unset.statusReason = 1;
  await Product.updateOne({ _id: id, companyId }, { $set, $unset });
  await logAuto(companyId, id, 'status_changed', `Statut : ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`, actor, { from, to: status, ...(reason && { reason }) });
  return get(companyId, id, access);
}
export const setActive = (companyId: Id, id: string, isActive: boolean, actor: Actor = {}, access: Access = FULL) => setStatus(companyId, id, isActive ? 'active' : 'inactive', actor, undefined, access);

/** Duplication : nouveau code obligatoire ; copie l'identité, le packaging, les prix et la douane — ni coût de revient, ni stock, ni séries, ni documents, ni activités. */
export async function duplicate(companyId: Id, id: string, d: { reference: string; name?: string | undefined }, access: Access, actor: Actor = {}) {
  const src = await getOwn(companyId, id);
  const o = src as unknown as { toObject?: () => unknown };
  const plain = JSON.parse(JSON.stringify(o.toObject ? o.toObject() : src)) as Record<string, any>;
  const p = await Product.create({
    companyId, reference: d.reference, name: d.name ?? `${src.name} (copie)`, description: src.description, kind: src.kind, brand: src.brand, model: src.model,
    categoryId: refId(src.categoryId) ?? undefined, unitId: refId(src.unitId)!, purchasePriceMinor: access.purchase ? src.purchasePriceMinor : 0, salePriceMinor: src.salePriceMinor, vatRateCode: src.vatRateCode, minStock: src.minStock,
    mainSupplierId: refId(src.mainSupplierId) ?? undefined, hasSerial: src.hasSerial, status: 'active', isActive: true, minSalePriceMinor: src.minSalePriceMinor, maxDiscountPct: src.maxDiscountPct,
    ...(access.purchase && { purchaseCurrency: src.purchaseCurrency, purchasePriceForeignMinor: src.purchasePriceForeignMinor, purchaseRate: src.purchaseRate, purchaseRateDate: src.purchaseRateDate, estimatedCostMinor: src.estimatedCostMinor }),
    ...(plain.packaging && { packaging: plain.packaging }), ...(access.customs && plain.customs && { customs: plain.customs }),
  });
  await logAuto(companyId, p._id, 'product_created', 'Article créé (duplication)', actor, { from: src.reference });
  return get(companyId, p._id.toString(), access);
}

export async function remove(companyId: Id, id: string) {
  const p = await getOwn(companyId, id);
  if (await ProductSerial.exists({ companyId, productId: id })) throw AppError.conflict('Suppression impossible : des numéros de série sont enregistrés. Désactivez ou archivez l’article.');
  await assertNotReferenced('product', companyId, p._id);
  if (await StockLevel.exists({ companyId, productId: p._id, qty: { $ne: 0 } })) throw AppError.conflict('Suppression impossible : du stock existe. Archivez l’article.');
  const docs = await ProductDocument.find({ companyId, productId: p._id }).select('fileId').lean();
  await Product.deleteOne({ _id: id, companyId });
  await Promise.all([ProductActivity.deleteMany({ companyId, productId: p._id }), ProductDocument.deleteMany({ companyId, productId: p._id }), ProductStockSetting.deleteMany({ companyId, productId: p._id }), ...docs.map((x) => deleteFile(x.fileId, PRODUCT_BUCKET))]);
  return p;
}

/** Simulation de prix (moteur fiscal et formules de marge uniques) pour l'aperçu en direct du formulaire. */
export async function pricingPreview(companyId: Id, b: { salePriceMinor: number; costMinor?: number | null | undefined; vatRateCode: string }, access: Access) {
  const vat = await vatFor(companyId, b.vatRateCode); if (!vat) throw AppError.badRequest(`TVA « ${b.vatRateCode} » : aucune règle validée applicable`);
  const ttc = ttcOf(b.salePriceMinor, vat);
  const m = access.cost && b.costMinor != null ? margins(b.salePriceMinor, b.costMinor, ttc, vat.ratePct) : null;
  return { vatRatePct: vat.ratePct, vatRegime: vat.regime, saleTtcMinor: ttc, margins: m, belowCost: m ? b.salePriceMinor < b.costMinor! : null };
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
  const whs = new Map((await Warehouse.find({ companyId, _id: { $in: items.map((s) => s.warehouseId).filter(Boolean) } }).select('code name').lean()).map((w) => [w._id.toString(), `${w.code} — ${w.name}`]));
  return { items: items.map((s) => ({ id: s._id.toString(), serialNumber: s.serialNumber, status: s.status, note: s.note ?? null, warehouseId: s.warehouseId?.toString() ?? null, warehouse: s.warehouseId ? whs.get(s.warehouseId.toString()) ?? null : null, soldOn: s.soldOn ? { type: s.soldOn.type ?? null, id: s.soldOn.id?.toString() ?? null, number: s.soldOn.number ?? null } : null })), total, page: q.page, limit: q.limit };
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

// ---- Marques (suggestions du filtre) ----
export async function brands(companyId: Id): Promise<string[]> { return ((await Product.distinct('brand', { companyId })) as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr')); }

// ---- Export ----
export async function exportRows(companyId: Id, f: ProductFilters, access: Access = FULL) {
  const filter = await buildFilter(companyId, f, access);
  const rows = (await Product.find(filter).populate(POPULATE).sort({ reference: 1 }).limit(50000).lean()) as Lean[];
  const stock = access.stock ? await stockMap(companyId, rows.map((p) => p._id), f.warehouseId) : undefined; const ctx = await context(companyId, access, rows, stock);
  return rows.map((p) => toDto(p, ctx));
}
export const exportColumns = (d: number, access: Access, extended: boolean): Column<ProductDto>[] => {
  const m = (v: number | null) => (v == null ? '' : Number((v / 10 ** d).toFixed(d)));
  return [
    { header: 'Code article', key: 'reference', width: 16, value: (p) => p.reference },
    { header: 'Désignation', key: 'name', width: 34, value: (p) => p.name },
    { header: 'Marque', key: 'brand', width: 16, value: (p) => p.brand },
    { header: 'Modèle', key: 'model', width: 16, value: (p) => p.model },
    { header: 'Type', key: 'kind', width: 10, value: (p) => (p.kind === 'service' ? 'Service' : 'Produit') },
    { header: 'Catégorie', key: 'family', width: 16, value: (p) => p.familyName },
    { header: 'Sous-catégorie', key: 'sub', width: 16, value: (p) => p.subName },
    { header: 'Unité', key: 'unit', width: 8, value: (p) => p.unitCode },
    ...(access.purchase ? [{ header: 'Prix d\'achat HT', key: 'purchase', width: 12, align: 'right' as const, value: (p: ProductDto) => m(p.purchasePriceMinor) }] : []),
    { header: 'Prix de vente HT', key: 'sale', width: 12, align: 'right', value: (p) => m(p.salePriceMinor) },
    { header: 'Prix de vente TTC', key: 'ttc', width: 12, align: 'right', value: (p) => m(p.saleTtcMinor) },
    { header: 'Code TVA', key: 'vat', width: 9, value: (p) => p.vatRateCode },
    ...(extended && access.cost ? [
      { header: 'Coût de revient', key: 'cost', width: 12, align: 'right' as const, value: (p: ProductDto) => m(p.effectiveCostMinor) },
      { header: 'Marge HT', key: 'margin', width: 12, align: 'right' as const, value: (p: ProductDto) => m(p.marginMinor) },
      { header: 'Taux de marge (%)', key: 'rate', width: 10, align: 'right' as const, value: (p: ProductDto) => p.marginRatePct },
    ] : []),
    ...(access.stock ? [{ header: 'Stock disponible', key: 'stock', width: 10, align: 'right' as const, value: (p: ProductDto) => p.stockQty }] : []),
    { header: 'Stock minimum', key: 'min', width: 10, align: 'right', value: (p) => p.minStock },
    { header: 'Fournisseur habituel', key: 'sup', width: 22, value: (p) => p.mainSupplierName },
    { header: 'Série', key: 'serial', width: 7, value: (p) => (p.hasSerial ? 'Oui' : 'Non') },
    { header: 'Statut', key: 'status', width: 9, value: (p) => p.statusLabel },
  ];
};
