import type { Types } from 'mongoose';
import { ProductSerial, ProductStockSetting } from '../../models/product.model.js';
import { StockLevel, Warehouse } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { effectiveStatus, getOwn, logProductAuto, type Actor } from './product.service.js';

type Id = Types.ObjectId;
export type StockStatus = 'out' | 'below_min' | 'above_max' | 'negative' | 'ok';
export const STOCK_STATUS_LABEL: Record<StockStatus, string> = { out: 'Rupture', below_min: 'Sous le minimum', above_max: 'Au-dessus du maximum', negative: 'Stock négatif', ok: 'Normal' };

/** Statut d'un stock : rupture (0), négatif (autorisé exceptionnellement par le module Stock), sous le minimum, au-dessus du maximum. */
export function stockStatus(qty: number, min: number | null, max: number | null): StockStatus {
  if (qty < 0) return 'negative';
  if (qty === 0) return 'out';
  if (min != null && min > 0 && qty < min) return 'below_min';
  if (max != null && max > 0 && qty > max) return 'above_max';
  return 'ok';
}

/**
 * Onglet Stock : lecture seule des niveaux réels (StockLevel — seule source de vérité des quantités et du CMP) + réglages propres à l'article
 * par magasin (emplacement, minimum, maximum). Aucune quantité n'est modifiable ici : réception, sortie, BL, transfert, inventaire ou ajustement.
 */
export async function stockTab(companyId: Id, productId: string, canSeeValues: boolean) {
  const p = await getOwn(companyId, productId);
  const [whs, levels, settings, serialCount] = await Promise.all([
    Warehouse.find({ companyId, isActive: true }).sort({ isDefault: -1, code: 1 }).lean(),
    StockLevel.find({ companyId, productId: p._id }).lean(),
    ProductStockSetting.find({ companyId, productId: p._id }).lean(),
    ProductSerial.countDocuments({ companyId, productId: p._id }),
  ]);
  const lv = new Map(levels.map((l) => [l.warehouseId.toString(), l])); const st = new Map(settings.map((s) => [s.warehouseId.toString(), s]));
  const known = new Set(whs.map((w) => w._id.toString()));
  // magasins désactivés qui contiennent encore du stock : toujours listés (jamais de stock « invisible »)
  const extra = levels.filter((l) => !known.has(l.warehouseId.toString()) && l.qty !== 0);
  const extraWhs = extra.length ? await Warehouse.find({ companyId, _id: { $in: extra.map((l) => l.warehouseId) } }).lean() : [];
  const rows = [...whs, ...extraWhs].map((w) => {
    const l = lv.get(w._id.toString()); const s = st.get(w._id.toString()); const qty = l?.qty ?? 0; const value = l?.valueMinor ?? 0;
    const min = s?.minQty ?? (p.minStock && p.minStock > 0 ? p.minStock : null); const max = s?.maxQty ?? null; const status = p.kind === 'service' ? 'ok' : stockStatus(qty, min, max);
    return {
      warehouseId: w._id.toString(), code: w.code, name: w.name, isDefault: !!w.isDefault, isActive: !!w.isActive, location: s?.location ?? null, qty, minQty: s?.minQty ?? null, maxQty: s?.maxQty ?? null, effectiveMinQty: min,
      cmpMinor: canSeeValues && qty > 0 ? Math.round(value / qty) : null, valueMinor: canSeeValues ? value : null, status, statusLabel: STOCK_STATUS_LABEL[status as StockStatus],
    };
  });
  const totalQty = rows.reduce((a, r) => a + r.qty, 0); const totalValue = levels.reduce((a, l) => a + l.valueMinor, 0);
  return {
    kind: p.kind, hasSerial: !!p.hasSerial, serialCount, globalMinStock: p.minStock ?? 0, canSeeValues,
    warehouses: rows, total: { qty: totalQty, valueMinor: canSeeValues ? totalValue : null, cmpMinor: canSeeValues && totalQty > 0 ? Math.round(totalValue / totalQty) : null, status: p.kind === 'service' ? 'ok' : stockStatus(totalQty, p.minStock && p.minStock > 0 ? p.minStock : null, null) },
    alerts: rows.filter((r) => r.status !== 'ok').map((r) => ({ warehouseId: r.warehouseId, warehouse: `${r.code} — ${r.name}`, status: r.status, label: r.statusLabel, qty: r.qty })),
  };
}

export async function saveStockSetting(companyId: Id, productId: string, warehouseId: string, d: { location?: string | null | undefined; minQty?: number | null | undefined; maxQty?: number | null | undefined }, actor: Actor) {
  const p = await getOwn(companyId, productId);
  if (effectiveStatus(p) === 'archived') throw AppError.conflict('Article archivé : réactivez-le avant de modifier ses réglages');
  if (p.kind === 'service') throw AppError.badRequest('Un service n’a pas de stock');
  const w = await Warehouse.findOne({ _id: warehouseId, companyId }).lean(); if (!w) throw AppError.notFound('Magasin introuvable');
  const cur = await ProductStockSetting.findOne({ companyId, productId, warehouseId }).lean();
  const next = { location: d.location === undefined ? cur?.location ?? null : d.location, minQty: d.minQty === undefined ? cur?.minQty ?? null : d.minQty, maxQty: d.maxQty === undefined ? cur?.maxQty ?? null : d.maxQty };
  if (next.minQty != null && next.maxQty != null && next.minQty > next.maxQty) throw AppError.badRequest('Le stock minimum ne peut pas dépasser le stock maximum');
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(next)) { if (v === null || v === '') $unset[k] = 1; else $set[k] = v; }
  if (!Object.keys($set).length) await ProductStockSetting.deleteOne({ companyId, productId, warehouseId }); // plus aucun réglage : on retire la ligne
  else await ProductStockSetting.updateOne({ companyId, productId, warehouseId }, { $set, ...(Object.keys($unset).length && { $unset }) }, { upsert: true, runValidators: true });
  if (JSON.stringify(cur ? { location: cur.location ?? null, minQty: cur.minQty ?? null, maxQty: cur.maxQty ?? null } : { location: null, minQty: null, maxQty: null }) !== JSON.stringify(next)) {
    await logProductAuto(companyId, productId, 'stock_setting_changed', `Réglages de stock modifiés (${w.code})`, actor, { warehouse: w.code, from: cur ? { location: cur.location ?? null, minQty: cur.minQty ?? null, maxQty: cur.maxQty ?? null } : null, to: next });
  }
  return stockTab(companyId, productId, true);
}
