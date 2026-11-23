import { z } from 'zod';
import { objectId } from '../../utils/pagination.js';
import { baseListQuery } from '../sales/document.http.js';
import { docFields } from '../sales/document.builder.js';

const dates = { issueDate: z.coerce.date().optional(), validUntil: z.coerce.date() };
const refine = (v: { issueDate?: Date | undefined; validUntil: Date }, ctx: z.RefinementCtx) => {
  const issue = v.issueDate ?? new Date();
  if (v.validUntil.getTime() < new Date(Date.UTC(issue.getUTCFullYear(), issue.getUTCMonth(), issue.getUTCDate())).getTime()) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'La validité doit être postérieure à la date du devis' });
};
export const quotationBody = z.object({ ...docFields, ...dates, terms: z.string().trim().max(1000).optional() }).strict().superRefine(refine);
export const listQuery = baseListQuery.extend({ status: z.enum(['pending', 'accepted', 'refused', 'expired']).optional(), sort: z.string().regex(/^-?(number|issueDate|validUntil|createdAt)$/).optional() });
export const convertBody = z.object({ validUntil: z.coerce.date().optional() }).strict();
export const duplicateBody = z.object({}).strict();
export { objectId };
