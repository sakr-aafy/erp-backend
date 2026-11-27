import { z } from 'zod';
import { PAYMENT_METHODS } from '../../models/sales.model.js';
import { addressZ, minorInt, partyFields } from '../parties/party.shared.js';
import { objectId } from '../../utils/pagination.js';
import { baseListQuery, boolQuery } from '../sales/document.http.js';
import { docFields, paymentTermsDocFields } from '../sales/document.builder.js';

const schedule = z.array(z.object({ dueDate: z.coerce.date(), percent: z.number().gt(0).max(100) }).strict()).max(24)
  .refine((s) => !s.length || Math.abs(s.reduce((a, b) => a + b.percent, 0) - 100) < 0.001, 'Le total des échéances doit faire 100 %');
export const invoiceBody = z.object({ ...docFields, ...paymentTermsDocFields, issueDate: z.coerce.date().optional(), paymentMethod: z.enum(PAYMENT_METHODS).optional(), schedule: schedule.optional() }).strict();
/** Coordonnées complètes à imprimer (chaîne vide = ligne retirée) : tous les champs sont exigés pour ne rien effacer par omission. */
export const customerDetailsBody = z.object({
  name: partyFields.name, taxId: z.string().trim().max(40),
  phone: z.string().trim().regex(/^$|^\+?[\d\s().\-/]{6,25}$/, 'Numéro de téléphone invalide'),
  email: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.union([z.literal(''), z.email()])),
  address: addressZ.required(),
  reason: z.string().trim().min(3, 'Indiquez le motif (3 caractères minimum)').max(300),
  updateCustomer: z.boolean(),
}).strict();
/** Les montants ne sont jamais reçus : seules les livraisons, les quantités choisies et le mode de regroupement le sont. */
export const fromDeliveryNotesBody = z.object({
  deliveryNoteIds: z.array(objectId).min(1).max(50), issueDate: z.coerce.date().optional(), mode: z.enum(['grouped', 'individual']).default('grouped'),
  lines: z.array(z.object({ deliveryNoteId: objectId, lineId: objectId, quantity: z.number().gt(0).max(1e9).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, '3 décimales maximum') }).strict()).min(1).max(500).optional(),
}).strict();
export const billableQuery = z.object({ customerId: objectId.optional(), sourceId: objectId.optional(), q: z.string().trim().max(100).optional() });
export const creditNoteBody = z.object({
  reason: z.string().trim().min(3).max(300),
  effect: z.enum(['financial', 'return', 'billing_correction']).default('financial'),
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
