import { z } from 'zod';

const code = z.string().trim().min(1).max(20);
export const updateSettingsBody = z.object({
  baseCurrency: z.string().trim().length(3).toUpperCase(),
  currencies: z.array(z.object({ code: z.string().trim().length(3).toUpperCase(), name: z.string().max(60).optional(), symbol: z.string().max(5).optional(), decimals: z.number().int().min(0).max(6) }).strict()).min(1),
  numbering: z.array(z.object({ docType: code, prefix: z.string().max(10).default(''), padding: z.number().int().min(1).max(12).default(5), includeYear: z.boolean().default(true), resetYearly: z.boolean().default(true) }).strict()),
  supplierBlockThresholdMinor: z.number().int().min(0).nullable().optional(), // null = supprimer le seuil global
}).partial().strict().superRefine((v, ctx) => {
  const dup = (arr: { code?: string; docType?: string }[] | undefined, key: 'code' | 'docType', path: string) => {
    const seen = new Set<string>();
    for (const x of arr ?? []) { const k = x[key]!; if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path], message: `Doublon : ${k}` }); seen.add(k); }
  };
  dup(v.currencies, 'code', 'currencies'); dup(v.numbering, 'docType', 'numbering');
  if (v.baseCurrency && v.currencies && !v.currencies.some((c) => c.code === v.baseCurrency)) ctx.addIssue({ code: 'custom', path: ['baseCurrency'], message: 'La devise de base doit figurer dans la liste des devises' });
});

/** Modification du taux estimatif d'une devise déjà paramétrée (aucune autre devise n'est ajoutée implicitement). */
export const estimateRateBody = z.object({
  currency: z.string().trim().length(3).toUpperCase(),
  rate: z.number().gt(0, 'Taux strictement positif').max(1000).refine((r) => Math.abs(r * 1e6 - Math.round(r * 1e6)) < 1e-4, '6 décimales maximum'),
}).strict();
