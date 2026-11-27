import { z } from 'zod';
import { SUPPLIER_ACTIVITY_KINDS, SUPPLIER_DOC_TYPES, SUPPLIER_STATUSES } from '../../models/supplier.model.js';
import { PAYMENT_METHODS } from '../../models/sales.model.js';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { contactZ, minorInt, partyFields } from '../parties/party.shared.js';
import { SUPPLIER_TX_KINDS } from './supplier.detail.service.js';

const blank = <T extends z.ZodType>(s: T) => z.union([s, z.literal('').transform(() => undefined)]);
/** URL http(s) uniquement (aucun javascript:, data:…), 300 caractères max. */
const isHttpUrl = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const urlField = blank(z.string().trim().max(300).refine(isHttpUrl, 'URL invalide (http:// ou https://)')).nullable().optional();
const phoneField = blank(z.string().trim().regex(/^\+?[\d\s().\-/]{6,25}$/, 'Numéro de téléphone invalide')).nullable().optional();
const text = (max: number) => blank(z.string().trim().max(max)).nullable().optional();

export const supplierBody = z.object({
  ...partyFields,
  categoryId: blank(objectId).nullable().optional(),
  tradeName: text(150),
  phone: phoneField, secondaryPhone: phoneField, website: urlField, mapsUrl: urlField,
  social: z.object({ facebook: urlField, linkedin: urlField, instagram: urlField }).strict().optional(),
  /** Conditions libres (ex. « 30 % à la commande et 70 % avant expédition ») : aucune échéance n'en est déduite. */
  paymentTerms: text(500),
  paymentTermsCustom: z.boolean().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  discountPct: z.number().min(0, 'Remise entre 0 et 100 %').max(100, 'Remise entre 0 et 100 %').multipleOf(0.01).optional(),
  leadTimeDays: z.number().int().min(0).max(1000).nullable().optional(),
  blockThresholdMinor: minorInt.nullable().optional(),
  isForeign: z.boolean().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
}).strict();
const customTermsNeedText = (v: { paymentTermsCustom?: boolean | undefined; paymentTerms?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.paymentTermsCustom && !v.paymentTerms) ctx.addIssue({ code: 'custom', path: ['paymentTerms'], message: 'Saisissez le texte des conditions personnalisées' });
};
export const createSupplierBody = supplierBody.superRefine(customTermsNeedText);
export const updateSupplierBody = supplierBody.partial().strict().superRefine(customTermsNeedText);

export const statusBody = z.object({ status: z.enum(SUPPLIER_STATUSES), reason: z.string().trim().max(300).optional() }).strict();
export const contactBody = contactZ.omit({ _id: true });
export const contactParams = z.object({ id: objectId, contactId: objectId });
export const docMetaBody = z.object({ type: z.enum(SUPPLIER_DOC_TYPES), description: z.string().trim().max(300).optional() }).strict();
export const docUpdateBody = docMetaBody.partial().strict();
export const docParams = z.object({ id: objectId, docId: objectId });
export const activityBody = z.object({
  kind: z.enum(SUPPLIER_ACTIVITY_KINDS), title: z.string().trim().min(2).max(150), description: z.string().trim().max(2000).optional(), occurredAt: z.coerce.date().optional(),
}).strict();
export const activityUpdateBody = activityBody.partial().strict();
export const activityParams = z.object({ id: objectId, activityId: objectId });

/** `open` = tous les fournisseurs non archivés (défaut) ; `categoryId=none` = non classés. */
export const listFilters = {
  /** Fournisseur choisi dans la recherche : la liste se limite à lui. */
  supplierId: objectId.optional(),
  status: z.enum(['open', 'all', ...SUPPLIER_STATUSES]).default('open'),
  categoryId: z.union([objectId, z.literal('none')]).optional(),
  country: z.string().trim().max(60).optional(),
  withBalance: boolQuery.optional(),
  foreign: boolQuery.optional(),
};
export const listQuery = paginationQuery.extend(listFilters);
export const exportQuery = z.object({ q: z.string().trim().max(100).optional(), ...listFilters, format: exportFormat });
export const idParam = z.object({ id: objectId });

const dateQ = z.coerce.date().optional();
const txFilters = { type: z.enum(SUPPLIER_TX_KINDS).optional(), status: z.string().trim().max(30).optional(), from: dateQ, to: dateQ };
export const transactionsQuery = paginationQuery.extend(txFilters);
export const transactionsExportQuery = z.object({ q: z.string().trim().max(100).optional(), ...txFilters, format: exportFormat });
export const paymentsQuery = paginationQuery.pick({ page: true, limit: true });
export const formatQuery = z.object({ format: exportFormat }).strict();
export const activitiesQuery = paginationQuery.pick({ page: true, limit: true }).extend({ kind: z.string().trim().max(40).optional() });

export const categoryBody = z.object({ name: z.string().trim().min(1, 'Nom obligatoire').max(80), description: text(300) }).strict();
export const categoryUpdateBody = categoryBody.partial().strict();
export const categoryListQuery = z.object({ q: z.string().trim().max(80).optional(), active: boolQuery.optional() });
export const categoryDeleteQuery = z.object({ reassignTo: objectId.optional() });
