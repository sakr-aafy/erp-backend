import type { Types } from 'mongoose';
import { CostHistory, GoodsReceipt, ImportFile, PurchaseInvoice, PurchaseOrder, StockMovement, Warehouse } from '../../models/logistics.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { escapeRegex } from '../../utils/pagination.js';
import { getOwn } from './product.service.js';

type Id = Types.ObjectId;
type Perms = ReadonlySet<string>;
export type Group = 'purchases' | 'sales' | 'stock' | 'imports';
export type Kind = 'purchase_order' | 'goods_receipt' | 'purchase_invoice' | 'quotation' | 'proforma' | 'invoice' | 'credit_note' | 'delivery_note' | 'stock_movement' | 'import_file' | 'cost_history';

interface KindDef { group: Group; label: string; permission: string; statuses: string[]; webPath: string; pdfPath?: string }
/** Chaque type de transaction exige la permission de SON module source : la fiche article n'ouvre l'accès à aucun module protégé. */
export const KINDS: Record<Kind, KindDef> = {
  purchase_order: { group: 'purchases', label: 'Commande fournisseur', permission: 'purchases:view', statuses: ['draft', 'confirmed', 'partially_received', 'received', 'cancelled'], webPath: '/purchase-orders' },
  goods_receipt: { group: 'purchases', label: 'Bon de réception', permission: 'purchases:view', statuses: ['draft', 'validated'], webPath: '/goods-receipts' },
  purchase_invoice: { group: 'purchases', label: 'Facture d’achat', permission: 'purchases:view', statuses: ['draft', 'validated'], webPath: '/purchase-invoices' },
  quotation: { group: 'sales', label: 'Devis', permission: 'quotations:view', statuses: ['pending', 'accepted', 'refused', 'expired'], webPath: '/quotations', pdfPath: '/quotations' },
  proforma: { group: 'sales', label: 'Facture proforma', permission: 'proformas:view', statuses: ['pending', 'converted', 'expired', 'cancelled'], webPath: '/proformas', pdfPath: '/proformas' },
  invoice: { group: 'sales', label: 'Facture de vente', permission: 'invoices:view', statuses: ['draft', 'validated'], webPath: '/invoices', pdfPath: '/invoices' },
  credit_note: { group: 'sales', label: 'Avoir', permission: 'invoices:view', statuses: ['draft', 'validated'], webPath: '/invoices', pdfPath: '/invoices' },
  delivery_note: { group: 'sales', label: 'Bon de livraison', permission: 'deliveryNotes:view', statuses: ['draft', 'validated', 'cancelled'], webPath: '/delivery-notes', pdfPath: '/delivery-notes' },
  stock_movement: { group: 'stock', label: 'Mouvement de stock', permission: 'inventory:view', statuses: [], webPath: '/stock/movements' },
  import_file: { group: 'imports', label: 'Dossier d’importation', permission: 'imports:view', statuses: ['draft', 'ordered', 'shipped', 'customs', 'arrived', 'closed', 'integrated', 'cancelled'], webPath: '/imports' },
  cost_history: { group: 'imports', label: 'Coût de revient', permission: 'costCalculation:view', statuses: [], webPath: '/costs' },
};
export const MOVEMENT_LABEL: Record<string, string> = { receipt: 'Réception', import: 'Intégration d’importation', delivery: 'Livraison', delivery_cancel: 'Annulation de livraison', transfer_out: 'Transfert (sortie)', transfer_in: 'Transfert (entrée)', inventory_in: 'Inventaire (écart +)', inventory_out: 'Inventaire (écart −)', manual_in: 'Entrée manuelle', manual_out: 'Sortie manuelle' };
const COST_REASON: Record<string, string> = { goods_receipt: 'Réception', import_integration: 'Intégration d’importation', manual_recalculation: 'Recalcul manuel', initial: 'Coût initial' };
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon', confirmed: 'Confirmée', partially_received: 'Partiellement reçue', received: 'Reçue', cancelled: 'Annulé', validated: 'Validé', pending: 'En attente', accepted: 'Accepté', refused: 'Refusé', expired: 'Expiré', converted: 'Converti',
  ordered: 'Commandé', shipped: 'Expédié', customs: 'En douane', arrived: 'Arrivé', closed: 'Clôturé', integrated: 'Intégré au stock', unpaid: 'Impayée', partial: 'Partiellement payée', paid: 'Payée', done: 'Effectué',
};
/** Phase d'affichage demandée par le cahier : En cours / Terminé / Annulé. */
export const phaseOf = (status: string): 'En cours' | 'Terminé' | 'Annulé' =>
  ['cancelled', 'refused', 'expired'].includes(status) ? 'Annulé' : ['validated', 'received', 'accepted', 'converted', 'closed', 'integrated', 'done', 'paid'].includes(status) ? 'Terminé' : 'En cours';

export interface TxRow {
  key: string; group: Group; kind: Kind; kindLabel: string; number: string | null; date: Date; customer: string | null; supplier: string | null; quantity: number | null; unitPriceMinor: number | null; currency: string | null; totalMinor: number | null;
  status: string; statusLabel: string; phase: string; warehouse: string | null; extra: string | null; webPath: string; pdfPath: string | null; direction: 'in' | 'out' | null;
}
export const allowedKinds = (perms: Perms): Kind[] => (Object.keys(KINDS) as Kind[]).filter((k) => perms.has(KINDS[k].permission));

interface Q { group?: Group | undefined; type?: string | undefined; status?: string | undefined; from?: Date | undefined; to?: Date | undefined; q?: string | undefined; warehouseId?: string | undefined; page: number; limit: number }
const sum = (a: { quantity?: number | null; netHtMinor?: number | null }[], k: 'quantity' | 'netHtMinor') => a.reduce((t, l) => t + (l[k] ?? 0), 0);
const range = (f?: Date, t?: Date) => (f || t ? { ...(f && { $gte: f }), ...(t && { $lte: t }) } : undefined);

export async function transactions(companyId: Id, productId: string, perms: Perms, baseCurrency: string, q: Q) {
  const p = await getOwn(companyId, productId); const pid = p._id;
  const allowed = allowedKinds(perms);
  let kinds = q.type ? allowed.filter((k) => k === q.type) : allowed;
  if (q.group) kinds = kinds.filter((k) => KINDS[k].group === q.group);
  const take = q.page * q.limit; const whs = new Map((await Warehouse.find({ companyId }).select('code name').lean()).map((w) => [w._id.toString(), `${w.code} — ${w.name}`]));
  const rx = q.q ? new RegExp(escapeRegex(q.q), 'i') : undefined;
  const base = { companyId, 'lines.productId': pid };
  const statusOk = (k: Kind) => !q.status || KINDS[k].statuses.includes(q.status);

  type Doc = { _id: Id; number?: string | null; status: string; type?: string; lines: { productId?: Id; quantity?: number | null; unitPriceMinor?: number | null; netHtMinor?: number | null; unitCostMinor?: number | null; valueMinor?: number | null; allocatedChargesMinor?: number | null; landedTotalMinor?: number | null }[]; warehouseId?: Id; customerSnapshot?: { name?: string }; supplier?: { name?: string }; currency?: string; supplierInvoiceNumber?: string } & Record<string, unknown>;
  const parts = await Promise.all(kinds.map(async (kind): Promise<{ rows: TxRow[]; total: number }> => {
    const def = KINDS[kind]; if (!statusOk(kind)) return { rows: [], total: 0 };
    const mk = (d: Doc, dateKey: string, over: Partial<TxRow>): TxRow => {
      const ls = d.lines.filter((l) => String(l.productId) === String(pid)); const qty = sum(ls, 'quantity');
      const total = ls.reduce((t, l) => t + (l.netHtMinor ?? l.valueMinor ?? l.landedTotalMinor ?? 0), 0);
      return { key: `${kind}:${d._id}`, group: def.group, kind, kindLabel: def.label, number: d.number ?? null, date: d[dateKey] as Date, customer: d.customerSnapshot?.name ?? null, supplier: d.supplier?.name ?? null, quantity: qty,
        unitPriceMinor: qty > 0 ? Math.round(total / qty) : (ls[0]?.unitPriceMinor ?? null), currency: baseCurrency, totalMinor: total, status: d.status, statusLabel: STATUS_LABEL[d.status] ?? d.status, phase: phaseOf(d.status),
        warehouse: d.warehouseId ? whs.get(String(d.warehouseId)) ?? null : null, extra: null, webPath: `${def.webPath}/${d._id}`, pdfPath: def.pdfPath ? `${def.pdfPath}/${d._id}/pdf` : null, direction: null, ...over };
    };
    const docs = async (M: any, dateKey: string, extra: Record<string, unknown> = {}, overFn?: (d: Doc) => Partial<TxRow>) => {
      const f: Record<string, unknown> = { ...base, ...extra, ...(q.status && { status: q.status }), ...(rx && { number: rx }), ...(range(q.from, q.to) && { [dateKey]: range(q.from, q.to) }), ...(q.warehouseId && ['goods_receipt', 'delivery_note'].includes(kind) && { warehouseId: q.warehouseId }) };
      const [items, total] = await Promise.all([M.find(f).sort({ [dateKey]: -1, _id: -1 }).limit(take).lean() as Promise<Doc[]>, M.countDocuments(f)]);
      return { rows: items.map((d) => mk(d, dateKey, overFn?.(d) ?? {})), total };
    };
    switch (kind) {
      case 'purchase_order': return docs(PurchaseOrder, 'orderDate');
      case 'goods_receipt': return docs(GoodsReceipt, 'receiptDate', {}, (d) => ({ totalMinor: d.lines.filter((l) => String(l.productId) === String(pid)).reduce((t, l) => t + (l.valueMinor ?? 0), 0) }));
      case 'purchase_invoice': return docs(PurchaseInvoice, 'invoiceDate', {}, (d) => ({ number: d.number ?? d.supplierInvoiceNumber ?? null, extra: d.supplierInvoiceNumber ? `Facture fournisseur ${d.supplierInvoiceNumber}` : null }));
      case 'quotation': return docs(Quotation, 'issueDate');
      case 'proforma': return docs(Proforma, 'issueDate');
      case 'invoice': return docs(Invoice, 'issueDate', { type: 'invoice' });
      case 'credit_note': return docs(Invoice, 'issueDate', { type: 'credit_note' });
      case 'delivery_note': return docs(DeliveryNote, 'deliveryDate');
      case 'import_file': return docs(ImportFile, 'orderDate', {}, (d) => {
        const l = d.lines.filter((x) => String(x.productId) === String(pid)); const charges = l.reduce((t, x) => t + (x.allocatedChargesMinor ?? 0), 0);
        return { currency: d.currency ?? null, unitPriceMinor: l[0]?.unitPriceMinor ?? null, totalMinor: l.reduce((t, x) => t + (x.landedTotalMinor ?? 0), 0), extra: `Frais affectés : ${charges}` };
      });
      case 'stock_movement': {
        const f: Record<string, unknown> = { companyId, productId: pid, ...(q.type === 'stock_movement' || !q.type ? {} : {}), ...(range(q.from, q.to) && { createdAt: range(q.from, q.to) }), ...(q.warehouseId && { warehouseId: q.warehouseId }), ...(q.status && { reason: q.status }), ...(rx && { 'source.number': rx }) };
        if (q.status && !MOVEMENT_LABEL[q.status]) return { rows: [], total: 0 };
        const [items, total] = await Promise.all([StockMovement.find(f).sort({ createdAt: -1, _id: -1 }).limit(take).lean(), StockMovement.countDocuments(f)]);
        return { total, rows: items.map((m) => ({
          key: `mv:${m._id}`, group: 'stock' as Group, kind, kindLabel: MOVEMENT_LABEL[m.reason] ?? m.reason, number: m.source?.number ?? null, date: (m as unknown as { createdAt: Date }).createdAt, customer: null, supplier: null, quantity: m.direction === 'in' ? m.quantity : -m.quantity,
          unitPriceMinor: m.unitCostMinor ?? null, currency: baseCurrency, totalMinor: m.valueMinor ?? null, status: 'done', statusLabel: 'Effectué', phase: 'Terminé', warehouse: whs.get(m.warehouseId.toString()) ?? null, extra: m.note ?? null, webPath: '/stock/movements', pdfPath: null, direction: m.direction,
        })) };
      }
      case 'cost_history': {
        const f: Record<string, unknown> = { companyId, productId: pid, ...(range(q.from, q.to) && { at: range(q.from, q.to) }), ...(q.status && { reason: q.status }), ...(rx && { 'source.number': rx }) };
        if (q.status && !COST_REASON[q.status]) return { rows: [], total: 0 };
        const [items, total] = await Promise.all([CostHistory.find(f).sort({ at: -1, _id: -1 }).limit(take).lean(), CostHistory.countDocuments(f)]);
        return { total, rows: items.map((c) => ({
          key: `cost:${c._id}`, group: 'imports' as Group, kind, kindLabel: `Coût de revient — ${COST_REASON[c.reason] ?? c.reason}`, number: c.source?.number ?? null, date: c.at, customer: null, supplier: null, quantity: c.quantity ?? null, unitPriceMinor: c.newCostMinor, currency: baseCurrency,
          totalMinor: null, status: 'done', statusLabel: 'Effectué', phase: 'Terminé', warehouse: null, extra: c.previousCostMinor != null ? `Précédent : ${c.previousCostMinor}` : null, webPath: '/costs', pdfPath: null, direction: null,
        })) };
      }
      default: return { rows: [], total: 0 };
    }
  }));
  const all = parts.flatMap((x) => x.rows).sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.key.localeCompare(a.key));
  return { items: all.slice((q.page - 1) * q.limit, q.page * q.limit), total: parts.reduce((s, x) => s + x.total, 0), page: q.page, limit: q.limit, allowedKinds: allowed, groups: [...new Set(allowed.map((k) => KINDS[k].group))] };
}
