import { z } from 'zod';
import { objectId } from '../../utils/pagination.js';
import { minorInt } from '../parties/party.shared.js';

export const DOC_TYPES = ['quotation', 'proforma', 'invoice', 'creditNote', 'deliveryNote'] as const;
const date = z.coerce.date();

const common = {
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_.-]+$/, 'Lettres, chiffres, . _ - uniquement'),
  label: z.string().trim().max(120).optional(),
  effectiveFrom: date,
  active: z.boolean().default(true),
  legalReference: z.string().trim().max(300).optional(),
};
export const ruleBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vat'), ...common, vat: z.object({ regime: z.enum(['taxable', 'zero', 'exempt', 'suspended']), ratePct: z.number().min(0).max(100).optional() }).strict() }).strict()
    .superRefine((v, ctx) => { if (v.vat.regime === 'taxable' && v.vat.ratePct === undefined) ctx.addIssue({ code: 'custom', path: ['vat', 'ratePct'], message: 'Taux requis pour un régime taxable' }); }),
  z.object({ kind: z.literal('withholding'), ...common, withholding: z.object({
    ratePct: z.number().min(0).max(100), base: z.enum(['ht', 'ttc']), minTotalMinor: minorInt.nullable().optional(), requireCustomerFlag: z.boolean().default(true) }).strict() }).strict(),
  z.object({ kind: z.literal('stamp'), ...common, stamp: z.object({
    amountMinor: minorInt, docTypes: z.array(z.enum(DOC_TYPES)).min(1), minTotalMinor: minorInt.nullable().optional(), exemptCustomerFlag: z.boolean().default(true) }).strict() }).strict(),
]);
export const listQuery = z.object({ kind: z.enum(['vat', 'withholding', 'stamp']).optional(), code: z.string().max(30).optional(), status: z.enum(['draft', 'validated']).optional() });
export const idParam = z.object({ id: objectId });
export const templateBody = z.object({ effectiveFrom: date }).strict();
