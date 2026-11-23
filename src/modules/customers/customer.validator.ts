import { z } from 'zod';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { minorInt, partyFields } from '../parties/party.shared.js';

export const customerBody = z.object({
  ...partyFields,
  creditLimitMinor: minorInt.nullable().optional(),
  subjectToWithholding: z.boolean().optional(),
  stampExempt: z.boolean().optional(),
}).strict();
export const createCustomerBody = customerBody;
export const updateCustomerBody = customerBody.partial().strict();

export const listFilters = {
  status: z.enum(['active', 'archived', 'all']).default('active'),
  debtors: boolQuery.optional(),
};
export const listQuery = paginationQuery.extend(listFilters);
export const exportQuery = z.object({ q: z.string().trim().max(100).optional(), ...listFilters, format: exportFormat });
export const idParam = z.object({ id: objectId });
