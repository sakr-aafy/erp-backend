import type { RequestHandler } from 'express';
import { Product } from '../../models/product.model.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import { asyncHandler } from '../../utils/async-handler.js';

interface Violation { line: number; reference: string; rule: 'min_price' | 'max_discount'; message: string; limit: number; actual: number }

/**
 * Règles commerciales de l'article, contrôlées CÔTÉ SERVEUR sur chaque devis, proforma et facture (création et modification) :
 *  - prix unitaire HT après remise de ligne ≥ prix minimum de vente de l'article ;
 *  - remise de ligne ≤ remise maximale autorisée de l'article.
 * Une dérogation exige un motif (`priceOverrideReason`) ET la permission `products:validate` ; elle est journalisée dans l'audit.
 */
export const enforcePriceRules: RequestHandler = asyncHandler(async (req, _res, next) => {
  const lines = (req.body?.lines ?? []) as { productId?: string; unitPriceMinor?: number; discountPct?: number }[];
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean) as string[])]; if (!ids.length) return next();
  const prods = await Product.find({ _id: { $in: ids }, companyId: req.auth!.companyId }).select('reference salePriceMinor minSalePriceMinor maxDiscountPct').lean();
  const by = new Map(prods.map((p) => [p._id.toString(), p])); const out: Violation[] = [];
  lines.forEach((l, i) => {
    const p = l.productId ? by.get(l.productId) : undefined; if (!p) return;
    const unit = l.unitPriceMinor ?? p.salePriceMinor ?? 0; const disc = l.discountPct ?? 0; const net = unit * (1 - disc / 100);
    if (p.minSalePriceMinor != null && net < p.minSalePriceMinor - 1e-9) out.push({ line: i + 1, reference: p.reference, rule: 'min_price', message: `Ligne ${i + 1} (${p.reference}) : prix net inférieur au prix minimum de vente`, limit: p.minSalePriceMinor, actual: Math.round(net) });
    if (p.maxDiscountPct != null && disc > p.maxDiscountPct + 1e-9) out.push({ line: i + 1, reference: p.reference, rule: 'max_discount', message: `Ligne ${i + 1} (${p.reference}) : remise supérieure à la remise maximale autorisée (${p.maxDiscountPct} %)`, limit: p.maxDiscountPct, actual: disc });
  });
  if (!out.length) return next();
  const reason = (req.body.priceOverrideReason as string | undefined)?.trim();
  if (!reason) throw new AppError(409, `Règle commerciale non respectée : ${out.map((v) => v.message).join(' ; ')}. Une dérogation exige un motif et la permission « products:validate ».`, 'PRICE_RULE_VIOLATION', { violations: out });
  if (!req.auth!.permissions.has('products:validate')) throw new AppError(403, 'Dérogation de prix refusée : permission « products:validate » requise.', 'PRICE_OVERRIDE_FORBIDDEN', { violations: out });
  await audit(req, { action: 'price-override', resource: 'product', meta: { reason, route: `${req.method} ${req.baseUrl}`, violations: out } });
  next();
});
