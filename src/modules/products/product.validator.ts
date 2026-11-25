import { z } from 'zod';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { PACKAGING_TYPES, PRODUCT_ACTIVITY_KINDS, PRODUCT_DOC_TYPES, PRODUCT_STATUSES } from '../../models/product.model.js';
import { minorInt } from '../parties/party.shared.js';

const nullableId = objectId.nullable().optional();
const blank = <T extends z.ZodType>(x: T) => z.union([x, z.literal('').transform(() => undefined)]);
const text = (max: number) => blank(z.string().trim().max(max)).nullable().optional();
const nn = (max: number) => z.number().min(0, 'Valeur négative interdite').max(max).nullable().optional();
const pct = z.number().min(0, 'Entre 0 et 100 %').max(100, 'Entre 0 et 100 %').multipleOf(0.01).nullable().optional();
/** Codes NGP : chaînes (les zéros initiaux sont significatifs), chiffres / points / espaces / tirets. */
const hs = blank(z.string().trim().max(20).regex(/^[0-9A-Za-z .-]*$/, 'Code invalide')).nullable().optional();

export const packagingBody = z.object({
  lengthMm: nn(1e7), widthMm: nn(1e7), heightMm: nn(1e7), netWeightKg: nn(1e7), grossWeightKg: nn(1e7),
  type: z.enum(PACKAGING_TYPES).nullable().optional(), typeLabel: text(60), parcelCount: z.number().int('Entier requis').min(1, 'Au moins 1 colis').max(1e6).nullable().optional(),
  dimensionsPerParcel: z.boolean().optional(),
}).strict();
export const customsBody = z.object({
  supplierHsCode: hs, tnHsCode: hs, ddPct: nn(1000), fodecPct: nn(1000), rpdPct: nn(1000), originCountry: text(60), provenanceCountry: text(60), specialRegulation: text(500),
}).strict();
export const pricingBody = z.object({
  purchasePriceMinor: minorInt.optional(), purchaseCurrency: blank(z.string().trim().length(3).toUpperCase()).nullable().optional(), purchasePriceForeignMinor: minorInt.nullable().optional(),
  estimatedCostMinor: minorInt.nullable().optional(), salePriceMinor: minorInt.optional(), vatRateCode: z.string().trim().min(1).max(20).optional(),
  minSalePriceMinor: minorInt.nullable().optional(), maxDiscountPct: pct, mainSupplierId: nullableId,
}).strict();

/** Champs de l'article SANS valeurs par défaut : une modification partielle ne doit jamais réinitialiser un champ absent de la requête (prix, stock minimum, type…). */
const productFields = {
  reference: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(200),
  brand: text(80), model: text(80),
  description: z.string().trim().max(2000).optional(),
  kind: z.enum(['product', 'service']),
  categoryId: nullableId,
  unitId: objectId,
  purchasePriceMinor: minorInt,
  salePriceMinor: minorInt,
  purchaseCurrency: blank(z.string().trim().length(3).toUpperCase()).nullable().optional(), purchasePriceForeignMinor: minorInt.nullable().optional(),
  estimatedCostMinor: minorInt.nullable().optional(), minSalePriceMinor: minorInt.nullable().optional(), maxDiscountPct: pct,
  vatRateCode: z.string().trim().min(1).max(20),
  minStock: z.number().min(0).max(1e9),
  mainSupplierId: nullableId,
  hasSerial: z.boolean(),
  packaging: packagingBody.optional(), customs: customsBody.optional(),
};
export const productBody = z.object(productFields).strict();
/** Création : valeurs par défaut (type produit, prix 0, stock minimum 0, sans suivi par série). */
export const createProductBody = z.object({ ...productFields, kind: productFields.kind.default('product'), purchasePriceMinor: productFields.purchasePriceMinor.default(0), salePriceMinor: productFields.salePriceMinor.default(0), minStock: productFields.minStock.default(0), hasSerial: productFields.hasSerial.default(false) }).strict();
export const updateProductBody = z.object(productFields).partial().strict();
export const duplicateBody = z.object({ reference: z.string().trim().min(1).max(60), name: z.string().trim().min(2).max(200).optional() }).strict();
export const activeBody = z.object({ isActive: z.boolean() }).strict();

export const statusBody = z.object({ status: z.enum(PRODUCT_STATUSES), reason: z.string().trim().max(300).optional() }).strict();
export const stockSettingBody = z.object({ location: text(80), minQty: nn(1e9), maxQty: nn(1e9) }).strict();
export const stockParams = z.object({ id: objectId, warehouseId: objectId });
export const docMetaBody = z.object({ type: z.enum(PRODUCT_DOC_TYPES), description: z.string().trim().max(300).optional() }).strict();
export const docUpdateBody = docMetaBody.partial().strict();
export const docParams = z.object({ id: objectId, docId: objectId });
export const activityBody = z.object({
  kind: z.enum(PRODUCT_ACTIVITY_KINDS), title: z.string().trim().min(2).max(150), description: z.string().trim().max(2000).optional(), occurredAt: z.coerce.date().optional(), dueDate: z.coerce.date().nullable().optional(),
}).strict();
export const activityUpdateBody = activityBody.partial().extend({ done: z.boolean().optional() }).strict();
export const activityParams = z.object({ id: objectId, activityId: objectId });
const dateQ = z.coerce.date().optional();
export const activitiesQuery = paginationQuery.pick({ page: true, limit: true }).extend({ kind: z.string().trim().max(30).optional(), from: dateQ, to: dateQ, open: boolQuery.optional() });
export const transactionsQuery = paginationQuery.extend({
  group: z.enum(['purchases', 'sales', 'stock', 'imports']).optional(), type: z.string().trim().max(30).optional(), status: z.string().trim().max(30).optional(), from: dateQ, to: dateQ, warehouseId: objectId.optional(),
});
export const transactionsExportQuery = z.object({ group: z.enum(['purchases', 'sales', 'stock', 'imports']).optional(), type: z.string().trim().max(30).optional(), status: z.string().trim().max(30).optional(), from: dateQ, to: dateQ, q: z.string().trim().max(100).optional(), warehouseId: objectId.optional(), format: exportFormat }).strict();
export const pricingPreviewBody = z.object({ salePriceMinor: minorInt, costMinor: minorInt.nullable().optional(), vatRateCode: z.string().trim().min(1).max(20) }).strict();
export const stockTabQuery = z.object({ serialStatus: z.enum(['available', 'sold', 'returned', 'scrapped']).optional() });

/** `open` = tous les articles non archivés (défaut). `active` (true/false/all) est conservé pour la compatibilité. */
export const listFilters = {
  categoryId: objectId.optional(), kind: z.enum(['product', 'service']).optional(), supplierId: objectId.optional(), brand: z.string().trim().max(80).optional(), warehouseId: objectId.optional(),
  status: z.enum(['open', 'all', ...PRODUCT_STATUSES]).optional(), active: z.enum(['true', 'false', 'all']).optional(),
  stockState: z.enum(['out', 'below_min']).optional(), belowCost: boolQuery.optional(),
};
export const listQuery = paginationQuery.extend(listFilters);
export const exportQuery = z.object({ q: z.string().trim().max(100).optional(), ...listFilters, format: exportFormat });
export const idParam = z.object({ id: objectId });
export const serialParam = z.object({ id: objectId, serialId: objectId });
export const serialsBody = z.object({ serials: z.array(z.string().trim().min(1).max(80)).min(1).max(500), note: z.string().trim().max(200).optional() }).strict();
export const serialsQuery = paginationQuery.extend({ status: z.enum(['available', 'sold', 'returned', 'scrapped']).optional() });
export const importQuery = z.object({ mode: z.enum(['create', 'upsert']).default('create'), dryRun: boolQuery.default(true) });

export const categoryBody = z.object({ name: z.string().trim().min(1).max(80), parentId: nullableId }).strict();
export const categoryUpdateBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const unitBody = z.object({ code: z.string().trim().min(1).max(12), name: z.string().trim().min(1).max(60) }).strict();
export const unitUpdateBody = unitBody.partial().strict();
