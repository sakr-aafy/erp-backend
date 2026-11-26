import type { Types } from 'mongoose';
import { z } from 'zod';
import { Category, Product } from '../../models/product.model.js';
import { CostHistory, StockLevel } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId, paginationQuery } from '../../utils/pagination.js';
import { minorInt } from '../parties/party.shared.js';
import { needsRealRate, realPurchaseOrNull } from '../products/purchase-price.js';
import { withTransaction } from '../../utils/transaction.js';

type Id = Types.ObjectId;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
export const simulateBody = z.object({ productId: objectId.optional(), purchasePriceMinor: minorInt.optional(), extraCostsMinor: minorInt.default(0), salePriceMinor: minorInt.optional(), targetMarginPct: z.number().min(0).max(1000).optional() }).strict();
export const recalcBody = z.object({ justification: z.string().trim().min(10, 'Justification d’au moins 10 caractères').max(500) }).strict();
export const reportQuery = paginationQuery.extend({ categoryId: objectId.optional(), belowCost: z.enum(['true', 'false']).optional() });

/** Marge d'un article : sur le coût (taux de marge) et sur le prix de vente (taux de marque) — HT. */
export const marginOf = (cost: number, sale: number) => ({ marginMinor: sale - cost, marginRatePct: pct(sale - cost, cost), markPct: pct(sale - cost, sale) });

/** Fiche coût de revient d'un article : coût actuel (CMP), décomposition de la dernière entrée, marge, stock valorisé, historique récent. */
export async function sheet(companyId: Id, productId: string) {
  const p = await Product.findOne({ _id: productId, companyId }).populate('categoryId', 'name').lean();
  if (!p) throw AppError.notFound('Article introuvable');
  const levels = await StockLevel.find({ companyId, productId }).populate('warehouseId', 'code name').lean();
  const history = await CostHistory.find({ companyId, productId }).sort({ at: -1 }).limit(10).lean();
  // Rapport financier : coût réel (CMP), sinon prix d'achat converti au taux RÉEL ; inconnu (null) sans taux réel — jamais le taux estimatif
  const purchaseReal = await realPurchaseOrNull(companyId, p);
  const cost = p.costPriceMinor ?? purchaseReal; const qty = levels.reduce((s, l) => s + l.qty, 0); const value = levels.reduce((s, l) => s + l.valueMinor, 0);
  return { productId, reference: p.reference, name: p.name, category: (p.categoryId as unknown as { name?: string } | null)?.name ?? null, purchasePriceMinor: purchaseReal, costPriceMinor: p.costPriceMinor ?? null, effectiveCostMinor: cost, salePriceMinor: p.salePriceMinor ?? 0,
    ...(cost === null ? { marginMinor: null, marginRatePct: null, markPct: null } : marginOf(cost, p.salePriceMinor ?? 0)), belowCost: cost !== null && (p.salePriceMinor ?? 0) < cost, stock: { qty, valueMinor: value, cmpMinor: qty > 0 ? Math.round(value / qty) : null, byWarehouse: levels.map((l) => ({ warehouse: (l.warehouseId as unknown as { code: string }).code, qty: l.qty, valueMinor: l.valueMinor })) },
    lastEntry: history[0] ? { purchaseUnitCostMinor: history[0].purchaseUnitCostMinor ?? 0, extraUnitCostMinor: history[0].extraUnitCostMinor ?? 0, reason: history[0].reason, at: history[0].at } : null,
    history: history.map(historyDto) };
}
const historyDto = (h: { _id: Id; at?: Date | null; previousCostMinor?: number | null; newCostMinor: number; purchaseUnitCostMinor?: number | null; extraUnitCostMinor?: number | null; quantity?: number | null; reason: string; justification?: string | null; source?: { type?: string | null; number?: string | null } | null }) =>
  ({ id: h._id.toString(), at: h.at, previousCostMinor: h.previousCostMinor ?? null, newCostMinor: h.newCostMinor, purchaseUnitCostMinor: h.purchaseUnitCostMinor ?? 0, extraUnitCostMinor: h.extraUnitCostMinor ?? 0, quantity: h.quantity ?? null, reason: h.reason, justification: h.justification ?? null, source: h.source?.type ? { type: h.source.type, number: h.source.number ?? null } : null });
export async function history(companyId: Id, productId: string, f: { page: number; limit: number }) {
  const [items, total] = await Promise.all([CostHistory.find({ companyId, productId }).sort({ at: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), CostHistory.countDocuments({ companyId, productId })]);
  return { items: items.map(historyDto), total, page: f.page, limit: f.limit };
}

/** Simulation de marge (aucune écriture) : coût = achat + frais ; marge, taux, et prix de vente minimal pour une marge cible. */
export async function simulate(companyId: Id, b: z.infer<typeof simulateBody>) {
  const p = b.productId ? await Product.findOne({ _id: b.productId, companyId }).lean() : null; if (b.productId && !p) throw AppError.notFound('Article introuvable');
  const purchase = b.purchasePriceMinor ?? p?.costPriceMinor ?? (p ? await realPurchaseOrNull(companyId, p) : null) ?? undefined; const sale = b.salePriceMinor ?? p?.salePriceMinor;
  if (purchase === undefined) throw AppError.badRequest('Prix d’achat requis (ou article)');
  const cost = purchase + b.extraCostsMinor;
  return { costMinor: cost, saleMinor: sale ?? null, ...(sale !== undefined && { ...marginOf(cost, sale), belowCost: sale < cost }), ...(b.targetMarginPct !== undefined && { minSalePriceForTargetMinor: Math.ceil(cost * (1 + b.targetMarginPct / 100)) }) };
}

/** Recalcul justifié du coût de revient = CMP global recalculé depuis les niveaux ; historisé avec sa justification. */
export async function recalculate(companyId: Id, userId: Id, productId: string, justification: string) {
  return withTransaction(async (session) => {
    const p = await Product.findOne({ _id: productId, companyId }).session(session).lean(); if (!p) throw AppError.notFound('Article introuvable');
    const agg = await StockLevel.aggregate<{ q: number; v: number }>([{ $match: { companyId: p.companyId, productId: p._id, qty: { $gt: 0 } } }, { $group: { _id: null, q: { $sum: '$qty' }, v: { $sum: '$valueMinor' } } }]).session(session);
    if (!agg[0]?.q) throw AppError.conflict('Aucun stock valorisé : coût de revient non recalculable (il provient des entrées en stock)');
    const next = Math.round(agg[0].v / agg[0].q); const prev = p.costPriceMinor ?? null;
    if (prev === next) return { changed: false, costPriceMinor: next };
    await Product.updateOne({ _id: p._id }, { costPriceMinor: next }, { session });
    await CostHistory.create([{ companyId, productId: p._id, previousCostMinor: prev, newCostMinor: next, reason: 'manual_recalculation', justification, userId }] as never[], { session });
    return { changed: true, previousCostMinor: prev, costPriceMinor: next };
  });
}

/** Rapport coût de revient / marge par article et par catégorie. */
export async function report(companyId: Id, f: { categoryId?: string | undefined; belowCost?: string | undefined; page: number; limit: number; q?: string | undefined }) {
  const cats = await Category.find({ companyId }).lean(); const byId = new Map(cats.map((c) => [c._id.toString(), c]));
  const filter: Record<string, unknown> = { companyId, kind: 'product', isActive: true };
  if (f.categoryId) { const kids = cats.filter((c) => String(c.parentId) === f.categoryId).map((c) => c._id); filter.categoryId = { $in: [f.categoryId, ...kids] }; }
  const all = await Product.find(filter).sort({ reference: 1 }).lean();
  // Taux réels résolus une seule fois par devise ; le taux estimatif n'intervient jamais dans ce rapport
  const real = new Map<string, number | null>();
  for (const p of all) if (p.costPriceMinor === undefined || p.costPriceMinor === null) real.set(p._id.toString(), await realPurchaseOrNull(companyId, p));
  let items = all.map((p) => { const cost = p.costPriceMinor ?? real.get(p._id.toString()) ?? null; const sale = p.salePriceMinor ?? 0; const cat = p.categoryId ? byId.get(p.categoryId.toString()) : undefined; const parent = cat?.parentId ? byId.get(cat.parentId.toString()) : undefined;
    return { productId: p._id.toString(), reference: p.reference, name: p.name, category: parent?.name ?? cat?.name ?? null, subCategory: parent ? cat?.name ?? null : null,
      purchasePriceMinor: needsRealRate(p) ? real.get(p._id.toString()) ?? null : p.purchasePriceMinor ?? 0, costPriceMinor: cost, salePriceMinor: sale,
      ...(cost === null ? { marginMinor: null, marginRatePct: null, markPct: null } : marginOf(cost, sale)), belowCost: cost !== null && sale < cost }; });
  if (f.belowCost === 'true') items = items.filter((i) => i.belowCost);
  const groups = new Map<string, { category: string; count: number; cost: number; sale: number }>();
  // Les articles au coût réel inconnu sont comptés mais exclus des marges (ils fausseraient les totaux)
  for (const i of items) { const k = i.category ?? 'Sans catégorie'; const g = groups.get(k) ?? { category: k, count: 0, cost: 0, sale: 0 }; g.count++; if (i.costPriceMinor !== null) { g.cost += i.costPriceMinor; g.sale += i.salePriceMinor; } groups.set(k, g); }
  return { items: items.slice((f.page - 1) * f.limit, f.page * f.limit), total: items.length, page: f.page, limit: f.limit,
    byCategory: [...groups.values()].map((g) => ({ category: g.category, count: g.count, marginMinor: g.sale - g.cost, marginRatePct: pct(g.sale - g.cost, g.cost), markPct: pct(g.sale - g.cost, g.sale) })) };
}
