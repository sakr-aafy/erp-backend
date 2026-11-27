import { Types } from 'mongoose';
import { Product } from '../../models/product.model.js';
import { StockLevel, StockMovement, Warehouse, MOVEMENT_REASONS } from '../../models/logistics.model.js';
import { applyMovement, ensureLevels } from '../../services/stock.service.js';
import { withTransaction } from '../../utils/transaction.js';
import { escapeRegex } from '../../utils/pagination.js';
import { rangeFilter } from '../sales/document.http.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import type { Column } from '../../services/export.service.js';
import { assertQuantities } from '../products/units.js';

type Id = Types.ObjectId;
const oid = (v: string) => new Types.ObjectId(v);

/** État du stock par article (tous magasins confondus, ou un magasin) avec seuil minimum. */
export async function overview(companyId: Id, f: { q?: string | undefined; warehouseId?: string | undefined; status?: string | undefined; page: number; limit: number }) {
  const match: Record<string, unknown> = { companyId, ...(f.warehouseId && { warehouseId: oid(f.warehouseId) }) };
  const rows = await StockLevel.aggregate<{ _id: Id; qty: number; valueMinor: number }>([{ $match: match }, { $group: { _id: '$productId', qty: { $sum: '$qty' }, valueMinor: { $sum: '$valueMinor' } } }]);
  const stock = new Map(rows.map((r) => [r._id.toString(), r]));
  const pf: Record<string, unknown> = { companyId, kind: 'product', isActive: true };
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); pf.$or = [{ reference: rx }, { name: rx }]; }
  // « en rupture » / « sous le seuil » concernent aussi les articles sans aucun niveau : on part du catalogue
  const products = await Product.find(pf).sort({ reference: 1 }).populate('unitId', 'code').lean();
  let items = products.map((p) => {
    const s = stock.get(p._id.toString()); const qty = s?.qty ?? 0;
    const status = qty <= 0 ? 'out' : (p.minStock ?? 0) > 0 && qty < (p.minStock ?? 0) ? 'low' : 'ok';
    return { productId: p._id.toString(), reference: p.reference, name: p.name, unit: (p.unitId as { code?: string } | null)?.code ?? null, qty, valueMinor: s?.valueMinor ?? 0, avgCostMinor: qty > 0 ? Math.round((s?.valueMinor ?? 0) / qty) : 0, minStock: p.minStock ?? 0, status, hasSerial: !!p.hasSerial };
  });
  if (f.status) items = items.filter((i) => i.status === f.status || (f.status === 'alert' && i.status !== 'ok'));
  const totals = { valueMinor: items.reduce((s, i) => s + i.valueMinor, 0), lowCount: items.filter((i) => i.status === 'low').length, outCount: items.filter((i) => i.status === 'out').length };
  return { items: items.slice((f.page - 1) * f.limit, f.page * f.limit), total: items.length, page: f.page, limit: f.limit, summary: totals };
}
export const overviewAll = async (companyId: Id, f: { q?: string | undefined; warehouseId?: string | undefined; status?: string | undefined }) => (await overview(companyId, { ...f, page: 1, limit: 100000 })).items;

/** Niveaux détaillés par article ET magasin. */
export async function levels(companyId: Id, f: { productId?: string | undefined; warehouseId?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, ...(f.productId && { productId: f.productId }), ...(f.warehouseId && { warehouseId: f.warehouseId }) };
  const [items, total] = await Promise.all([StockLevel.find(filter).populate('productId', 'reference name').populate('warehouseId', 'code name').sort({ updatedAt: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), StockLevel.countDocuments(filter)]);
  return { items: items.map((l) => ({ id: l._id.toString(), productId: (l.productId as unknown as { _id: Id })._id.toString(), reference: (l.productId as unknown as { reference: string }).reference, name: (l.productId as unknown as { name: string }).name,
    warehouseId: (l.warehouseId as unknown as { _id: Id })._id.toString(), warehouse: (l.warehouseId as unknown as { code: string }).code, qty: l.qty, valueMinor: l.valueMinor, avgCostMinor: l.qty > 0 ? Math.round(l.valueMinor / l.qty) : 0 })), total, page: f.page, limit: f.limit };
}

/** Valorisation du stock (CMP) : par magasin et totale. */
export async function valuation(companyId: Id) {
  const rows = await StockLevel.aggregate<{ _id: Id; qty: number; valueMinor: number }>([{ $match: { companyId } }, { $group: { _id: '$warehouseId', qty: { $sum: '$qty' }, valueMinor: { $sum: '$valueMinor' } } }]);
  const whs = await Warehouse.find({ companyId }).lean(); const byId = new Map(whs.map((w) => [w._id.toString(), w]));
  const warehouses = rows.map((r) => ({ warehouseId: r._id.toString(), code: byId.get(r._id.toString())?.code ?? '?', name: byId.get(r._id.toString())?.name ?? '?', qty: r.qty, valueMinor: r.valueMinor }));
  return { warehouses, totalValueMinor: warehouses.reduce((s, w) => s + w.valueMinor, 0) };
}

export interface MovementFilters { productId?: string | undefined; warehouseId?: string | undefined; reason?: string | undefined; direction?: string | undefined; from?: Date | undefined; to?: Date | undefined; sourceId?: string | undefined; page: number; limit: number }
const movementFilter = (companyId: Id, f: MovementFilters): Record<string, unknown> => ({ companyId, ...(f.productId && { productId: f.productId }), ...(f.warehouseId && { warehouseId: f.warehouseId }), ...(f.reason && { reason: f.reason }), ...(f.direction && { direction: f.direction }),
  ...(f.sourceId && { 'source.id': f.sourceId }), ...(rangeFilter(f.from, f.to) && { createdAt: rangeFilter(f.from, f.to) }) });
const mdto = (m: { _id: Id; productId: unknown; warehouseId: unknown; direction: string; reason: string; quantity: number; unitCostMinor?: number | null; valueMinor?: number | null; qtyBefore?: number | null; qtyAfter?: number | null; source?: { type?: string | null; id?: Id | null; number?: string | null } | null; serials?: string[]; note?: string | null; forced?: boolean | null; createdAt?: Date }) => {
  const p = m.productId as { _id: Id; reference: string; name: string }; const w = m.warehouseId as { _id: Id; code: string };
  return { id: m._id.toString(), productId: p._id.toString(), reference: p.reference, name: p.name, warehouseId: w._id.toString(), warehouse: w.code, direction: m.direction, reason: m.reason, quantity: m.quantity, unitCostMinor: m.unitCostMinor ?? 0, valueMinor: m.valueMinor ?? 0,
    qtyBefore: m.qtyBefore ?? 0, qtyAfter: m.qtyAfter ?? 0, source: m.source?.type ? { type: m.source.type, id: m.source.id?.toString(), number: m.source.number ?? null } : null, serials: m.serials ?? [], note: m.note ?? null, forced: !!m.forced, at: m.createdAt };
};
/** Historique des mouvements (par article, par magasin, par période, par document). */
export async function movements(companyId: Id, f: MovementFilters) {
  const filter = movementFilter(companyId, f);
  const [rows, total] = await Promise.all([StockMovement.find(filter).populate('productId', 'reference name').populate('warehouseId', 'code').sort({ createdAt: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), StockMovement.countDocuments(filter)]);
  const items = rows as unknown as Parameters<typeof mdto>[0][];
  return { items: items.map(mdto), total, page: f.page, limit: f.limit };
}
export async function movementsAll(companyId: Id, f: Omit<MovementFilters, 'page' | 'limit'>) {
  const rows = await StockMovement.find(movementFilter(companyId, { ...f, page: 1, limit: 1 })).populate('productId', 'reference name').populate('warehouseId', 'code').sort({ createdAt: -1 }).limit(50000).lean();
  return (rows as unknown as Parameters<typeof mdto>[0][]).map(mdto);
}

export const REASON_LABELS: Record<string, string> = { receipt: 'Réception', import: 'Importation', delivery: 'Livraison', delivery_cancel: 'Annulation de livraison', transfer_out: 'Transfert (sortie)', transfer_in: 'Transfert (entrée)',
  inventory_in: 'Inventaire (+)', inventory_out: 'Inventaire (−)', manual_in: 'Entrée manuelle', manual_out: 'Sortie manuelle' };
type Ov = Awaited<ReturnType<typeof overviewAll>>[number]; type Mv = ReturnType<typeof mdto>;
export const overviewColumns = (d: number): Column<Ov>[] => [
  { header: 'Référence', key: 'ref', width: 16, value: (r) => r.reference }, { header: 'Désignation', key: 'name', width: 34, value: (r) => r.name }, { header: 'Unité', key: 'unit', width: 8, value: (r) => r.unit },
  { header: 'Quantité', key: 'qty', width: 10, align: 'right', value: (r) => r.qty }, { header: 'Seuil min.', key: 'min', width: 10, align: 'right', value: (r) => r.minStock }, { header: 'CMP', key: 'cmp', width: 12, align: 'right', value: (r) => (r.avgCostMinor / 10 ** d).toFixed(d) },
  { header: 'Valeur', key: 'val', width: 14, align: 'right', value: (r) => (r.valueMinor / 10 ** d).toFixed(d) }, { header: 'Statut', key: 'st', width: 12, value: (r) => ({ ok: 'Normal', low: 'Sous le seuil', out: 'Rupture' })[r.status] },
];
export const movementColumns = (d: number): Column<Mv>[] => [
  { header: 'Date', key: 'at', width: 18, value: (m) => (m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : '') }, { header: 'Article', key: 'ref', width: 16, value: (m) => m.reference }, { header: 'Magasin', key: 'wh', width: 10, value: (m) => m.warehouse },
  { header: 'Motif', key: 'reason', width: 22, value: (m) => REASON_LABELS[m.reason] ?? m.reason }, { header: 'Sens', key: 'dir', width: 6, value: (m) => (m.direction === 'in' ? 'Entrée' : 'Sortie') }, { header: 'Quantité', key: 'qty', width: 10, align: 'right', value: (m) => m.quantity },
  { header: 'Valeur', key: 'val', width: 14, align: 'right', value: (m) => (m.valueMinor / 10 ** d).toFixed(d) }, { header: 'Stock après', key: 'after', width: 10, align: 'right', value: (m) => m.qtyAfter }, { header: 'Document', key: 'doc', width: 18, value: (m) => m.source?.number },
];

/** Entrée / sortie manuelle (régularisation) : motif obligatoire, traçable, audité. */
export async function manualMovement(companyId: Id, userId: Id, b: { direction: 'in' | 'out'; productId: string; warehouseId: string; quantity: number; unitCostMinor?: number | undefined; reason: string; serials?: string[] | undefined; allowNegativeStock?: boolean | undefined }) {
  if (b.direction === 'in' && b.unitCostMinor === undefined) throw AppError.badRequest('Coût unitaire requis pour une entrée');
  await assertQuantities(companyId, [{ productId: b.productId, quantity: b.quantity, label: 'Mouvement' }]);
  await ensureLevels(companyId, [{ productId: b.productId, warehouseId: b.warehouseId }]);
  return withTransaction(async (session) => {
    const r = await applyMovement({ companyId, session, userId, productId: b.productId, warehouseId: b.warehouseId, direction: b.direction, quantity: b.quantity, reason: b.direction === 'in' ? 'manual_in' : 'manual_out', eventKey: `manual:${randomUUID()}`,
      unitCostMinor: b.unitCostMinor, serials: b.serials, allowNegative: b.allowNegativeStock, note: b.reason, touchCost: b.direction === 'in', costInfo: { purchaseUnitMinor: b.unitCostMinor ?? 0, extraUnitMinor: 0 } });
    if (!r.movement) throw AppError.badRequest('Les services ne sont pas gérés en stock');
    return { id: r.movement._id.toString(), qtyAfter: r.movement.qtyAfter, valueMinor: r.movement.valueMinor, forced: r.movement.forced, belowMin: r.belowMin };
  });
}
export { MOVEMENT_REASONS };
