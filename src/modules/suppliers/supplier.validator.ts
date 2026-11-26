import { z } from 'zod';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { minorInt, partyFields } from '../parties/party.shared.js';

export const supplierBody = z.object({
  ...partyFields,
  tradeName: z.string().trim().max(150).nullable().optional().or(z.literal('').transform(() => undefined)),
  leadTimeDays: z.number().int().min(0).max(1000).nullable().optional(),
  blockThresholdMinor: minorInt.nullable().optional(),
  isForeign: z.boolean().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
}).strict();
export const createSupplierBody = supplierBody;
export const updateSupplierBody = supplierBody.partial().strict();

export const listFilters = {
  status: z.enum(['active', 'archived', 'all']).default('active'),
  withBalance: boolQuery.optional(),
  foreign: boolQuery.optional(),
};
export const listQuery = paginationQuery.extend(listFilters);
export const exportQuery = z.object({ q: z.string().trim().max(100).optional(), ...listFilters, format: exportFormat });
export const idParam = z.object({ id: objectId });
