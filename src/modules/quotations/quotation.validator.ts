import { z } from 'zod';
import { objectId, paginationQuery } from '../../utils/pagination.js';
import { baseListQuery } from '../sales/document.http.js';
import { docFields, paymentTermsDocFields } from '../sales/document.builder.js';
import { QUOTATION_DOC_TYPES, QUOTATION_EVENTS } from '../../models/sales.model.js';
import { QUOTATION_STATUSES } from './quotation.workflow.js';
import { SEND_METHODS } from './quotation.service.js';

const dates = { issueDate: z.coerce.date().optional(), validUntil: z.coerce.date() };
const refine = (v: { issueDate?: Date | undefined; validUntil: Date }, ctx: z.RefinementCtx) => {
  const issue = v.issueDate ?? new Date();
  if (v.validUntil.getTime() < new Date(Date.UTC(issue.getUTCFullYear(), issue.getUTCMonth(), issue.getUTCDate())).getTime()) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'La validité doit être postérieure à la date du devis' });
};
export const quotationBody = z.object({ ...docFields, ...paymentTermsDocFields, ...dates, terms: z.string().trim().max(1000).optional(),
  /** Texte libre ; jamais converti en date. */
  deliveryTime: z.string().trim().max(500).optional(),
  /** Numéro de révision lu avant la modification : une modification concurrente est refusée. */
  revision: z.number().int().min(0).optional() }).strict().superRefine(refine);
export const listQuery = baseListQuery.extend({ status: z.enum(QUOTATION_STATUSES).optional(), sort: z.string().regex(/^-?(number|issueDate|validUntil|createdAt|status|customer|totalHtMinor|totalTtcMinor)$/).optional() });
export const newVersionBody = z.object({ validUntil: z.coerce.date().optional() }).strict().default({});
export const versionParams = z.object({ id: objectId, version: z.coerce.number().int().min(1).max(10000) });
const docVersion = z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number().int().min(1).optional());
export const docMetaBody = z.object({ type: z.enum(QUOTATION_DOC_TYPES), description: z.string().trim().max(300).optional(), version: docVersion }).strict();
export const docUpdateBody = docMetaBody.partial().strict();
export const docParams = z.object({ id: objectId, docId: objectId });
export const commentBody = z.object({ body: z.string().trim().min(1, 'Commentaire vide').max(4000) }).strict();
export const commentParams = z.object({ id: objectId, commentId: objectId });
export const convertBody = z.object({ validUntil: z.coerce.date().optional() }).strict();
export const duplicateBody = z.object({}).strict();
const note = z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined));
export const acceptBody = z.object({ comment: note }).strict().default({});
export const refuseBody = z.object({ reason: note }).strict().default({});
export const markSentBody = z.object({ method: z.enum(SEND_METHODS), recipient: z.string().trim().max(150).optional().or(z.literal('').transform(() => undefined)), note }).strict();
export const activitiesQuery = paginationQuery.pick({ page: true, limit: true }).extend({ kind: z.enum(QUOTATION_EVENTS).optional() });
export { objectId };
