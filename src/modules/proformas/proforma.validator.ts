import { z } from 'zod';
import { baseListQuery } from '../sales/document.http.js';
import { docFields } from '../sales/document.builder.js';

export const proformaBody = z.object({ ...docFields, issueDate: z.coerce.date().optional(), validUntil: z.coerce.date(), terms: z.string().trim().max(1000).optional() }).strict()
  .superRefine((v, ctx) => { const i = v.issueDate ?? new Date(); if (v.validUntil.getTime() < Date.UTC(i.getUTCFullYear(), i.getUTCMonth(), i.getUTCDate())) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'La validité doit être postérieure à la date' }); });
export const listQuery = baseListQuery.extend({ status: z.enum(['pending', 'converted', 'expired', 'cancelled']).optional(), sort: z.string().regex(/^-?(number|issueDate|validUntil|createdAt)$/).optional() });
