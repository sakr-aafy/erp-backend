import { z } from 'zod';
import { PAYMENT_METHODS } from '../../models/sales.model.js';
import { minorInt } from '../parties/party.shared.js';
import { objectId } from '../../utils/pagination.js';
import { baseListQuery, boolQuery } from '../sales/document.http.js';
import { docFields } from '../sales/document.builder.js';

const schedule = z.array(z.object({ dueDate: z.coerce.date(), percent: z.number().gt(0).max(100) }).strict()).max(24)
  .refine((s) => !s.length || Math.abs(s.reduce((a, b) => a + b.percent, 0) - 100) < 0.001, 'Le total des échéances doit faire 100 %');
export const invoiceBody = z.object({ ...docFields, issueDate: z.coerce.date().optional(), paymentMethod: z.enum(PAYMENT_METHODS).optional(), schedule: schedule.optional() }).strict();
export const fromDeliveryNotesBody = z.object({ deliveryNoteIds: z.array(objectId).min(1).max(50), issueDate: z.coerce.date().optional() }).strict();
export const creditNoteBody = z.object({
  reason: z.string().trim().min(3).max(300),
  lines: z.array(z.object({ sourceLineId: objectId, quantity: z.number().gt(0).max(1e9) }).strict()).min(1).optional(), // absent = avoir total
}).strict();
export const paymentBody = z.object({
  amountMinor: minorInt.refine((v) => v > 0, 'Montant positif requis'), method: z.enum(PAYMENT_METHODS), paidAt: z.coerce.date().optional(),
  reference: z.string().trim().max(100).optional(), note: z.string().trim().max(300).optional(), treasuryAccountId: objectId.optional(),
}).strict();
export const cancelPaymentBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const listQuery = baseListQuery.extend({
  type: z.enum(['invoice', 'credit_note']).optional(), status: z.enum(['draft', 'validated']).optional(), paymentStatus: z.enum(['unpaid', 'partial', 'paid']).optional(),
  overdue: boolQuery.optional(), sort: z.string().regex(/^-?(number|issueDate|createdAt)$/).optional(),
});
export const summaryQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
export const paymentsQuery = baseListQuery.extend({ invoiceId: objectId.optional(), status: z.enum(['active', 'cancelled']).optional() });
