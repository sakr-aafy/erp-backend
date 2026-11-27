import { z } from 'zod';
import { CUSTOMER_DOC_TYPES, ACTIVITY_KINDS, CUSTOMER_PAYMENT_METHODS, CUSTOMER_STATUSES, CUSTOMER_TYPES } from '../../models/customer.model.js';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { contactZ, minorInt, partyFields } from '../parties/party.shared.js';

const blank = <T extends z.ZodType>(s: T) => z.union([s, z.literal('').transform(() => undefined)]);
/** URL http(s) uniquement (aucun javascript:, data:…), 300 caractères max. */
const isHttpUrl = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const urlField = blank(z.string().trim().max(300).refine(isHttpUrl, 'URL invalide (http:// ou https://)')).nullable().optional();
/** Téléphone : chiffres, espaces, +, tirets, points, parenthèses (6 à 25 caractères). */
const phoneField = blank(z.string().trim().regex(/^\+?[\d\s().\-/]{6,25}$/, 'Numéro de téléphone invalide')).nullable().optional();
const text = (max: number) => blank(z.string().trim().max(max)).nullable().optional();

export const customerBody = z.object({
  ...partyFields,
  type: z.enum(CUSTOMER_TYPES).optional(),
  tradeName: text(150),
  /** Conditions libres (ex. « 30 % à la commande et le solde avant la livraison ») : plus longues que les préréglages. */
  paymentTerms: text(500),
  paymentTermsCustom: z.boolean().optional(),
  phone: phoneField,
  secondaryPhone: phoneField,
  website: urlField,
  social: z.object({ facebook: urlField, linkedin: urlField, instagram: urlField }).strict().optional(),
  mapsUrl: urlField,
  paymentMethod: z.enum(CUSTOMER_PAYMENT_METHODS).nullable().optional(),
  /** Remise habituelle proposée sur les lignes : un chiffre après la virgule. */
  discountPct: z.number().min(0, 'Remise entre 0 et 100 %').max(100, 'Remise entre 0 et 100 %').refine((d) => Math.abs(d * 10 - Math.round(d * 10)) < 1e-6, 'Remise : un seul chiffre après la virgule').optional(),
  creditLimitMinor: minorInt.nullable().optional(),
  subjectToWithholding: z.boolean().optional(),
  stampExempt: z.boolean().optional(),
}).strict();
const customTermsNeedText = (v: { paymentTermsCustom?: boolean | undefined; paymentTerms?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.paymentTermsCustom && !v.paymentTerms) ctx.addIssue({ code: 'custom', path: ['paymentTerms'], message: 'Saisissez le texte des conditions personnalisées' });
};
export const createCustomerBody = customerBody.superRefine(customTermsNeedText);
export const updateCustomerBody = customerBody.partial().strict().superRefine(customTermsNeedText);

export const statusBody = z.object({ status: z.enum(CUSTOMER_STATUSES), reason: z.string().trim().max(300).optional() }).strict();
export const contactBody = contactZ.omit({ _id: true });
export const contactParams = z.object({ id: objectId, contactId: objectId });

export const docMetaBody = z.object({ type: z.enum(CUSTOMER_DOC_TYPES), description: z.string().trim().max(300).optional() }).strict();
export const docUpdateBody = docMetaBody.partial().strict();
export const docParams = z.object({ id: objectId, docId: objectId });

export const activityBody = z.object({
  kind: z.enum(ACTIVITY_KINDS), title: z.string().trim().min(2).max(150), description: z.string().trim().max(2000).optional(), occurredAt: z.coerce.date().optional(),
}).strict();
export const activityUpdateBody = activityBody.partial().strict();
export const activityParams = z.object({ id: objectId, activityId: objectId });

/** `open` = tous les clients non archivés (défaut). */
export const listFilters = {
  status: z.enum(['open', 'all', ...CUSTOMER_STATUSES]).default('open'),
  type: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().trim().max(80).optional(),
  debtors: boolQuery.optional(),
  /** Client choisi dans les suggestions : la liste est limitée à sa fiche. */
  customerId: objectId.optional(),
};
export const listQuery = paginationQuery.extend(listFilters);
export const exportQuery = z.object({ q: z.string().trim().max(100).optional(), ...listFilters, format: exportFormat });
export const idParam = z.object({ id: objectId });

const dateQ = z.coerce.date().optional();
export const transactionsQuery = paginationQuery.extend({
  type: z.enum(['quotation', 'proforma', 'invoice', 'credit_note', 'delivery_note']).optional(),
  status: z.string().trim().max(30).optional(), from: dateQ, to: dateQ,
});
export const paymentsQuery = paginationQuery.pick({ page: true, limit: true });
export const summaryQuery = z.object({}).strict();
export const activitiesQuery = paginationQuery.pick({ page: true, limit: true }).extend({ kind: z.string().trim().max(30).optional() });
export const statementQuery = z.object({ format: exportFormat }).strict();
