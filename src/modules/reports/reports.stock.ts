import { Types } from 'mongoose';
import { Category, Product } from '../../models/product.model.js';
import { CostHistory, Inventory, StockLevel, StockMovement, StockTransfer, Warehouse } from '../../models/logistics.model.js';
import { REASON_LABELS, overviewAll } from '../stock/stock.queries.js';
import { barChart, bucketExpr, fillPeriods, lineChart, nameMap, oid, range, sum } from './report.helpers.js';
import { MAX_ROWS, type Ctx, type ReportDef, type Row } from './report.types.js';

const money = (key: string, label: string) => ({ key, label, type: 'money' as const });
const qty = (key: string, label: string) => ({ key, label, type: 'qty' as const });
const WAREHOUSE_ZERO = 1e-9;

/** Niveaux de stock filtrés (magasin, article, catégorie), valorisés (valeur entière tenue par le module Stock). */
async function levelRows(c: Ctx) {
  let productIds: Types.ObjectId[] | undefined;
  if (c.f.categoryId) productIds = (await Product.find({ companyId: c.companyId, categoryId: oid(c.f.categoryId) }).select('_id').lean()).map((p) => p._id);
  const levels = await StockLevel.find({ companyId: c.companyId, ...(c.f.warehouseId && { warehouseId: oid(c.f.warehouseId) }), ...(c.f.productId && { productId: oid(c.f.productId) }), ...(productIds && { productId: { $in: productIds } }) }).lean();
  const [prods, whs] = await Promise.all([Product.find({ _id: { $in: levels.map((l) => l.productId) } }).select('reference name categoryId').lean(), Warehouse.find({ companyId: c.companyId }).select('code name').lean()]);
  const pm = new Map(prods.map((p) => [String(p._id), p])); const wm = new Map(whs.map((w) => [String(w._id), w]));
  return levels.filter((l) => Math.abs(l.qty) > WAREHOUSE_ZERO || l.valueMinor !== 0).map((l) => { const p = pm.get(String(l.productId)); const w = wm.get(String(l.warehouseId));
    return { warehouse: w ? `${w.code} — ${w.name}` : '—', warehouseId: String(l.warehouseId), reference: p?.reference ?? '—', name: p?.name ?? '—', productId: String(l.productId), categoryId: p?.categoryId ? String(p.categoryId) : null, qty: l.qty, valueMinor: l.valueMinor, cmpMinor: l.qty > 0 ? Math.round(l.valueMinor / l.qty) : 0 }; });
}

export const stockReports: ReportDef[] = [
  { key: 'stock-by-warehouse', group: 'stock', title: 'État du stock par magasin', description: 'Quantité, valeur et coût moyen pondéré (CMP) de chaque article dans chaque magasin.',
    perms: ['inventory:view'], filters: ['warehouseId', 'productId', 'categoryId'],
    columns: [{ key: 'warehouse', label: 'Magasin' }, { key: 'reference', label: 'Référence' }, { key: 'name', label: 'Article' }, qty('qty', 'Quantité'), money('cmpMinor', 'CMP'), money('valueMinor', 'Valeur')],
    async run(c) {
      const all = (await levelRows(c)).sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.reference.localeCompare(b.reference)); const rows: Row[] = all.slice(0, MAX_ROWS);
      const byW = new Map<string, number>(); for (const r of all) byW.set(r.warehouse, (byW.get(r.warehouse) ?? 0) + r.valueMinor);
      return { rows, truncated: all.length > MAX_ROWS, totals: { warehouse: 'Total', valueMinor: all.reduce((s, r) => s + r.valueMinor, 0) }, chart: { type: 'bar', valueType: 'money', series: [{ label: 'Valeur du stock', points: [...byW].map(([label, value]) => ({ label, value })) }] } };
    } },
  { key: 'stock-valuation', group: 'stock', title: 'Valeur du stock par catégorie', description: 'Valorisation du stock au CMP regroupée par famille d’articles.',
    perms: ['inventory:view'], filters: ['warehouseId', 'categoryId'],
    columns: [{ key: 'category', label: 'Catégorie' }, { key: 'products', label: 'Articles', type: 'int' }, qty('qty', 'Quantité'), money('valueMinor', 'Valeur')],
    async run(c) {
      const all = await levelRows({ ...c, f: { ...c.f, productId: undefined } }); const cats = await nameMap(Category, all.map((r) => r.categoryId)); const by = new Map<string, { category: string; set: Set<string>; qty: number; valueMinor: number }>();
      for (const r of all) { const k = r.categoryId ? cats.get(r.categoryId) ?? 'Catégorie supprimée' : 'Sans catégorie'; const e = by.get(k) ?? { category: k, set: new Set<string>(), qty: 0, valueMinor: 0 }; e.set.add(r.productId); e.qty += r.qty; e.valueMinor += r.valueMinor; by.set(k, e); }
      const rows: Row[] = [...by.values()].map(({ set, ...e }) => ({ ...e, products: set.size })).sort((a, b) => b.valueMinor - a.valueMinor);
      return { rows, totals: { category: 'Total', products: new Set(all.map((r) => r.productId)).size, qty: sum(rows, 'qty'), valueMinor: sum(rows, 'valueMinor') }, chart: barChart('money', 'Valeur', rows, 'category', 'valueMinor', 10) };
    } },
  { key: 'stock-movements', group: 'stock', title: 'Mouvements : entrées et sorties', description: 'Entrées et sorties de stock (quantités et valeurs) par période, selon le motif.',
    perms: ['inventory:view'], filters: ['period', 'groupBy', 'warehouseId', 'productId', 'reason'],
    columns: [{ key: 'period', label: 'Période' }, qty('inQty', 'Qté entrée'), money('inValueMinor', 'Valeur entrée'), qty('outQty', 'Qté sortie'), money('outValueMinor', 'Valeur sortie'), money('netValueMinor', 'Variation de valeur')],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to });
      const g = await StockMovement.aggregate<Record<string, number | string>>([{ $match: { companyId: c.companyId, ...(r && { createdAt: r }), ...(c.f.warehouseId && { warehouseId: oid(c.f.warehouseId) }), ...(c.f.productId && { productId: oid(c.f.productId) }), ...(c.f.reason && { reason: c.f.reason }) } },
        { $group: { _id: bucketExpr(c.f.groupBy, 'createdAt'), inQty: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$quantity', 0] } }, inValueMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$valueMinor', 0] } },
          outQty: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$quantity', 0] } }, outValueMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$valueMinor', 0] } } } }]);
      const rows = fillPeriods(g.map(({ _id, ...x }) => ({ period: _id, ...x })), c.f.groupBy, c.f, { inQty: 0, inValueMinor: 0, outQty: 0, outValueMinor: 0 }).map((x) => ({ ...x, netValueMinor: Number(x['inValueMinor']) - Number(x['outValueMinor']) }));
      return { rows, totals: { period: 'Total', inQty: sum(rows, 'inQty'), inValueMinor: sum(rows, 'inValueMinor'), outQty: sum(rows, 'outQty'), outValueMinor: sum(rows, 'outValueMinor'), netValueMinor: sum(rows, 'netValueMinor') },
        chart: lineChart('money', [{ label: 'Valeur entrée', key: 'inValueMinor' }, { label: 'Valeur sortie', key: 'outValueMinor' }], rows), note: `Motifs : ${Object.values(REASON_LABELS).join(', ')}.` };
    } },
  { key: 'stock-low', group: 'stock', title: 'Articles sous le seuil minimum', description: 'Articles actifs dont le stock total est inférieur au seuil d’alerte (hors ruptures).',
    perms: ['inventory:view'], filters: ['warehouseId', 'categoryId'],
    columns: [{ key: 'reference', label: 'Référence' }, { key: 'name', label: 'Article' }, qty('qty', 'Stock'), qty('minStock', 'Seuil'), qty('missing', 'Manquant'), money('valueMinor', 'Valeur')],
    async run(c) {
      let items = await overviewAll(c.companyId, { status: 'low', warehouseId: c.f.warehouseId });
      if (c.f.categoryId) { const ids = new Set((await Product.find({ companyId: c.companyId, categoryId: oid(c.f.categoryId) }).select('_id').lean()).map((p) => String(p._id))); items = items.filter((i) => ids.has(i.productId)); }
      const rows: Row[] = items.map((i) => ({ reference: i.reference, name: i.name, qty: i.qty, minStock: i.minStock, missing: i.minStock - i.qty, valueMinor: i.valueMinor }));
      return { rows, totals: { reference: 'Total', valueMinor: sum(rows, 'valueMinor') }, chart: barChart('qty', 'Manquant', rows.sort((a, b) => Number(b['missing']) - Number(a['missing'])), 'name', 'missing', 10) };
    } },
  { key: 'stock-out', group: 'stock', title: 'Articles en rupture', description: 'Articles actifs dont le stock total est nul ou négatif.',
    perms: ['inventory:view'], filters: ['warehouseId', 'categoryId'],
    columns: [{ key: 'reference', label: 'Référence' }, { key: 'name', label: 'Article' }, qty('qty', 'Stock'), qty('minStock', 'Seuil')],
    async run(c) {
      let items = await overviewAll(c.companyId, { status: 'out', warehouseId: c.f.warehouseId });
      if (c.f.categoryId) { const ids = new Set((await Product.find({ companyId: c.companyId, categoryId: oid(c.f.categoryId) }).select('_id').lean()).map((p) => String(p._id))); items = items.filter((i) => ids.has(i.productId)); }
      return { rows: items.map((i) => ({ reference: i.reference, name: i.name, qty: i.qty, minStock: i.minStock })), kpis: [{ label: 'Articles en rupture', value: items.length, type: 'int' }] };
    } },
  { key: 'inventories', group: 'stock', title: 'Inventaires', description: 'Inventaires validés : écarts constatés et valeur des régularisations.',
    perms: ['inventory:view'], filters: ['period', 'warehouseId'],
    columns: [{ key: 'number', label: 'N°' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'warehouse', label: 'Magasin' }, { key: 'lines', label: 'Lignes', type: 'int' }, { key: 'variances', label: 'Écarts', type: 'int' }, qty('netQty', 'Écart net (qté)'), money('valueMinor', 'Valeur régularisée'), { key: 'reason', label: 'Motif' }],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to }); const docs = await Inventory.find({ companyId: c.companyId, status: 'validated', ...(r && { date: r }), ...(c.f.warehouseId && { warehouseId: oid(c.f.warehouseId) }) }).sort({ date: -1 }).limit(MAX_ROWS).lean();
      const wm = await nameMap(Warehouse, docs.map((d) => d.warehouseId), 'code');
      const mv = await StockMovement.aggregate<{ _id: Types.ObjectId; v: number }>([{ $match: { companyId: c.companyId, 'source.id': { $in: docs.map((d) => d._id) }, reason: { $in: ['inventory_in', 'inventory_out'] } } }, { $group: { _id: '$source.id', v: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$valueMinor', { $multiply: ['$valueMinor', -1] }] } } } }]);
      const vm = new Map(mv.map((x) => [String(x._id), x.v]));
      const rows: Row[] = docs.map((d) => ({ number: d.number, date: d.date, warehouse: wm.get(String(d.warehouseId)) ?? '—', lines: d.lines.length, variances: d.lines.filter((l) => (l.appliedDelta ?? 0) !== 0).length, netQty: d.lines.reduce((s, l) => s + (l.appliedDelta ?? 0), 0), valueMinor: vm.get(String(d._id)) ?? 0, reason: d.reason ?? '' }));
      return { rows, totals: { number: 'Total', lines: sum(rows, 'lines'), variances: sum(rows, 'variances'), netQty: sum(rows, 'netQty'), valueMinor: sum(rows, 'valueMinor') } };
    } },
  { key: 'transfers', group: 'stock', title: 'Transferts entre magasins', description: 'Transferts validés : magasins, quantités et valeur transférée.',
    perms: ['inventory:view'], filters: ['period', 'warehouseId'],
    columns: [{ key: 'number', label: 'N°' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'from', label: 'De' }, { key: 'to', label: 'Vers' }, { key: 'lines', label: 'Articles', type: 'int' }, qty('qty', 'Quantité'), money('valueMinor', 'Valeur')],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to }); const w = c.f.warehouseId ? oid(c.f.warehouseId) : undefined;
      const docs = await StockTransfer.find({ companyId: c.companyId, status: 'validated', ...(r && { date: r }), ...(w && { $or: [{ fromWarehouseId: w }, { toWarehouseId: w }] }) }).sort({ date: -1 }).limit(MAX_ROWS).lean();
      const wm = await nameMap(Warehouse, docs.flatMap((d) => [d.fromWarehouseId, d.toWarehouseId]), 'code');
      const rows: Row[] = docs.map((d) => ({ number: d.number, date: d.date, from: wm.get(String(d.fromWarehouseId)) ?? '—', to: wm.get(String(d.toWarehouseId)) ?? '—', lines: d.lines.length, qty: d.lines.reduce((s, l) => s + l.quantity, 0), valueMinor: d.lines.reduce((s, l) => s + (l.valueMinor ?? 0), 0) }));
      return { rows, totals: { number: 'Total', lines: sum(rows, 'lines'), qty: sum(rows, 'qty'), valueMinor: sum(rows, 'valueMinor') } };
    } },
  { key: 'valuation-history', group: 'stock', title: 'Historique de valorisation (coût de revient)', description: 'Variations du coût de revient / CMP des articles, avec leur origine.',
    perms: ['inventory:view', 'costCalculation:view'], filters: ['period', 'productId', 'categoryId'],
    columns: [{ key: 'at', label: 'Date', type: 'date' }, { key: 'reference', label: 'Référence' }, { key: 'name', label: 'Article' }, money('previousCostMinor', 'Ancien coût'), money('newCostMinor', 'Nouveau coût'), money('deltaMinor', 'Écart'), { key: 'reason', label: 'Origine' }, { key: 'source', label: 'Document' }],
    async run(c) {
      let ids: Types.ObjectId[] | undefined; if (c.f.categoryId) ids = (await Product.find({ companyId: c.companyId, categoryId: oid(c.f.categoryId) }).select('_id').lean()).map((p) => p._id);
      const r = range({ from: c.f.from, to: c.f.to }); const docs = await CostHistory.find({ companyId: c.companyId, ...(r && { at: r }), ...(c.f.productId && { productId: oid(c.f.productId) }), ...(ids && { productId: { $in: ids } }) }).sort({ at: -1 }).limit(MAX_ROWS).lean();
      const pm = new Map((await Product.find({ _id: { $in: docs.map((d) => d.productId) } }).select('reference name').lean()).map((p) => [String(p._id), p]));
      const L: Record<string, string> = { goods_receipt: 'Réception', import_integration: 'Importation', manual_recalculation: 'Recalcul manuel', initial: 'Initial' };
      const rows: Row[] = docs.map((d) => ({ at: d.at, reference: pm.get(String(d.productId))?.reference ?? '—', name: pm.get(String(d.productId))?.name ?? '—', previousCostMinor: d.previousCostMinor ?? 0, newCostMinor: d.newCostMinor, deltaMinor: d.newCostMinor - (d.previousCostMinor ?? 0), reason: L[d.reason] ?? d.reason, source: d.source?.number ?? '' }));
      const chart = c.f.productId ? lineChart('money', [{ label: 'Coût de revient', key: 'newCostMinor' }], [...rows].reverse().map((x) => ({ ...x, period: new Date(x['at'] as Date).toISOString().slice(0, 10) }))) : undefined;
      return { rows, truncated: docs.length >= MAX_ROWS, ...(chart && { chart }) };
    } },
];
