import { z } from 'zod';
import { objectId, paginationQuery } from '../../utils/pagination.js';
import { baseListQuery } from '../sales/document.http.js';
import { docFields, paymentTermsDocFields } from '../sales/document.builder.js';
import { QUOTATION_EVENTS } from '../../models/sales.model.js';
import { QUOTATION_STATUSES } from './quotation.workflow.js';
import { SEND_METHODS } from './quotation.service.js';

const dates = { issueDate: z.coerce.date().optional(), validUntil: z.coerce.date() };
const refine = (v: { issueDate?: Date | undefined; validUntil: Date }, ctx: z.RefinementCtx) => {
  const issue = v.issueDate ?? new Date();
  if (v.validUntil.getTime() < new Date(Date.UTC(issue.getUTCFullYear(), issue.getUTCMonth(), issue.getUTCDate())).getTime()) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'La validité doit être postérieure à la date du devis' });
};
export const quotationBody = z.object({ ...docFields, ...paymentTermsDocFields, ...dates, terms: z.string().trim().max(1000).optional() }).strict().superRefine(refine);
export const listQuery = baseListQuery.extend({ status: z.enum(QUOTATION_STATUSES).optional(), sort: z.string().regex(/^-?(number|issueDate|validUntil|createdAt|status|customer|totalHtMinor|totalTtcMinor)$/).optional() });
export const convertBody = z.object({ validUntil: z.coerce.date().optional() }).strict();
export const duplicateBody = z.object({}).strict();
const note = z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined));
export const acceptBody = z.object({ comment: note }).strict().default({});
export const refuseBody = z.object({ reason: note }).strict().default({});
export const markSentBody = z.object({ method: z.enum(SEND_METHODS), recipient: z.string().trim().max(150).optional().or(z.literal('').transform(() => undefined)), note }).strict();
export const activitiesQuery = paginationQuery.pick({ page: true, limit: true }).extend({ kind: z.enum(QUOTATION_EVENTS).optional() });
export { objectId };
