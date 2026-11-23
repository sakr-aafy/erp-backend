import { z } from 'zod';
import { objectId } from '../../utils/pagination.js';
import { baseListQuery, boolQuery } from '../sales/document.http.js';
import { lineBody } from '../sales/document.builder.js';

export const deliveryBody = z.object({
  customerId: objectId.optional(), source: z.object({ type: z.enum(['quotation', 'proforma', 'invoice']), id: objectId }).strict().optional(),
  lines: z.array(lineBody).min(1, 'Au moins une ligne').max(500), deliveryDate: z.coerce.date().optional(),
  carrier: z.string().trim().max(120).optional(), notes: z.string().trim().max(2000).optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.source && !v.customerId) ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Client requis (ou document source)' });
  if (v.source && v.lines.some((l) => !l.sourceLineId)) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Chaque ligne doit référencer une ligne du document source' });
});
export const cancelBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const listQuery = baseListQuery.extend({
  status: z.enum(['draft', 'validated', 'cancelled']).optional(), invoiced: boolQuery.optional(), sort: z.string().regex(/^-?(number|deliveryDate|createdAt)$/).optional(),
});
export const sourceQuery = z.object({ type: z.enum(['quotation', 'proforma', 'invoice']), id: objectId });
export const validateBody = z.object({ warehouseId: objectId.optional(), allowNegativeStock: z.boolean().optional() }).strict();
