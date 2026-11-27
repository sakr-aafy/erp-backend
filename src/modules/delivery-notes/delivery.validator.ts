import { z } from 'zod';
import { objectId } from '../../utils/pagination.js';
import { baseListQuery, boolQuery } from '../sales/document.http.js';
import { lineBody } from '../sales/document.builder.js';

export const deliveryBody = z.object({
  customerId: objectId.optional(), source: z.object({ type: z.enum(['quotation', 'proforma', 'invoice']), id: objectId }).strict().optional(),
  lines: z.array(lineBody).min(1, 'Au moins une ligne').max(500), deliveryDate: z.coerce.date().optional(),
  carrier: z.string().trim().max(120).optional(), deliveryAddressId: objectId.nullable().optional(), notes: z.string().trim().max(2000).optional(), warehouseId: objectId.optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.source && !v.customerId) ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Client requis (ou document source)' });
  if (v.source && v.lines.some((l) => !l.sourceLineId)) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Chaque ligne doit référencer une ligne du document source' });
});
/** La réintégration au stock n'a lieu qu'après confirmation explicite que la marchandise est physiquement en magasin. */
const physical = z.literal(true, { error: 'Confirmez que la marchandise est physiquement en magasin' });
export const cancelBody = z.object({ reason: z.string().trim().min(3).max(300), returnConfirmed: physical }).strict();
export const returnBody = z.object({
  reason: z.string().trim().min(3).max(300), returnConfirmed: physical, warehouseId: objectId.optional(), date: z.coerce.date().optional(), requestId: z.string().trim().min(8).max(80).optional(),
  lines: z.array(z.object({ lineId: objectId, quantity: z.number().gt(0).max(1e9).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, '3 décimales maximum'), serials: z.array(z.string().trim().min(1).max(80)).max(1000).optional() }).strict()).min(1).max(500),
}).strict();
export const serialsQuery = z.object({ productId: objectId, warehouseId: objectId, excludeId: objectId.optional() });
export const listQuery = baseListQuery.extend({
  status: z.enum(['draft', 'validated', 'cancelled']).optional(), invoiced: boolQuery.optional(), sourceId: objectId.optional(), sort: z.string().regex(/^-?(number|deliveryDate|createdAt)$/).optional(),
});
export const sourceQuery = z.object({ type: z.enum(['quotation', 'proforma', 'invoice']), id: objectId, excludeId: objectId.optional() });
export const validateBody = z.object({ warehouseId: objectId.optional(), allowNegativeStock: z.boolean().optional() }).strict();
