import { z } from 'zod';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { minorInt } from '../parties/party.shared.js';

const nullableId = objectId.nullable().optional();
export const productBody = z.object({
  reference: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  kind: z.enum(['product', 'service']).default('product'),
  categoryId: nullableId,
  unitId: objectId,
  purchasePriceMinor: minorInt.default(0),
  salePriceMinor: minorInt.default(0),
  vatRateCode: z.string().trim().min(1).max(20),
  minStock: z.number().min(0).max(1e9).default(0),
  mainSupplierId: nullableId,
  hasSerial: z.boolean().default(false),
}).strict();
export const createProductBody = productBody;
export const updateProductBody = productBody.partial().strict();
export const duplicateBody = z.object({ reference: z.string().trim().min(1).max(60), name: z.string().trim().min(2).max(200).optional() }).strict();
export const activeBody = z.object({ isActive: z.boolean() }).strict();

export const listFilters = {
  categoryId: objectId.optional(), kind: z.enum(['product', 'service']).optional(), supplierId: objectId.optional(),
  active: z.enum(['true', 'false', 'all']).default('all'), belowCost: boolQuery.optional(),
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
