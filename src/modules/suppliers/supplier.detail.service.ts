import type { Types } from 'mongoose';
import { GoodsReceipt, IMPORT_STATUSES, ImportFile, PurchaseInvoice, PurchaseOrder } from '../../models/logistics.model.js';
import { SupplierPayment, TreasuryAccount } from '../../models/finance.model.js';
import { Setting } from '../../models/setting.model.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex } from '../../utils/pagination.js';
import { thirdPartyStatement } from '../accounting/accounting.service.js';
import { canSeeAmounts, categoryMap, companyThresholdOf, getOwn, redact, toDto } from './supplier.service.js';

type Id = Types.ObjectId;
type Perms = ReadonlySet<string>;
export const SUPPLIER_TX_KINDS = ['purchase_order', 'goods_receipt', 'purchase_invoice', 'import_file'] as const;
export type TxKind = (typeof SUPPLIER_TX_KINDS)[number];

/** Permission du module propriétaire de chaque type : la fiche fournisseur n'ouvre jamais l'accès à un module protégé. */
export const TX_PERMISSION: Record<TxKind, string> = { purchase_order: 'purchases:view', goods_receipt: 'purchases:view', purchase_invoice: 'purchases:view', import_file: 'imports:view' };
export const allowedKinds = (perms: Perms) => SUPPLIER_TX_KINDS.filter((k) => perms.has(TX_PERMISSION[k]));
export const TX_LABEL: Record<TxKind, string> = { purchase_order: 'Commande d’achat', goods_receipt: 'Bon de réception', purchase_invoice: 'Facture d’achat', import_file: 'Dossier d’importation' };
const WEB_PATH: Record<TxKind, string> = { purchase_order: '/purchase-orders', goods_receipt: '/goods-receipts', purchase_invoice: '/purchase-invoices', import_file: '/imports' };

const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const n = (v: number | null | undefined) => v ?? 0;
const baseCurrencyOf = async (companyId: Id) => (await Setting.findOne({ companyId }).select('baseCurrency').lean())?.baseCurrency ?? 'TND';

export interface TxRow {
  id: string; kind: TxKind; number: string | null; externalRef: string | null; date: Date; totalHtMinor: number | null; totalTtcMinor: number | null; currency: string;
  /** Montant dans la devise d'origine (dossiers d'importation) ; les montants HT / TTC sont en devise de base. */
  foreignMinor: number | null; status: string; paymentStatus: string | null; webPath: string;
}
interface DocLean {
  _id: Id; number?: string | null; supplierInvoiceNumber?: string; reference?: string | null; status: string; orderDate?: Date; receiptDate?: Date; invoiceDate?: Date; paymentStatus?: string | null; currency?: string;
  totals?: { totalHtMinor?: number | null; totalTtcMinor?: number | null; fobBaseMinor?: number | null } | null; lines?: { quantity?: number; unitPriceMinor?: number; valueMinor?: number }[];
}
const KIND = {
  purchase_order: { model: PurchaseOrder, date: 'orderDate', select: 'number status orderDate totals', statuses: ['draft', 'confirmed', 'partially_received', 'received', 'cancelled'], search: ['number'] },
  goods_receipt: { model: GoodsReceipt, date: 'receiptDate', select: 'number status receiptDate lines.valueMinor deliveryNoteRef', statuses: ['draft', 'validated'], search: ['number', 'deliveryNoteRef'] },
  purchase_invoice: { model: PurchaseInvoice, date: 'invoiceDate', select: 'number supplierInvoiceNumber status invoiceDate totals paymentStatus', statuses: ['draft', 'validated', 'unpaid', 'partial', 'paid'], search: ['number', 'supplierInvoiceNumber'] },
  import_file: { model: ImportFile, date: 'orderDate', select: 'number reference status orderDate totals currency lines.quantity lines.unitPriceMinor', statuses: [...IMPORT_STATUSES] as string[], search: ['number', 'reference'] },
} as const;

const toRow = (kind: TxKind, d: DocLean, base: string): TxRow => {
  const imported = kind === 'import_file';
  return {
    id: d._id.toString(), kind, number: d.number ?? null, externalRef: (kind === 'purchase_invoice' ? d.supplierInvoiceNumber : imported ? d.reference : (d as { deliveryNoteRef?: string }).deliveryNoteRef) ?? null,
    date: (d.orderDate ?? d.receiptDate ?? d.invoiceDate)!,
    totalHtMinor: kind === 'goods_receipt' ? (d.lines ?? []).reduce((s, l) => s + n(l.valueMinor), 0) : imported ? d.totals?.fobBaseMinor ?? null : d.totals?.totalHtMinor ?? null,
    totalTtcMinor: kind === 'goods_receipt' || imported ? null : d.totals?.totalTtcMinor ?? null,
    currency: imported ? d.currency ?? base : base,
    foreignMinor: imported ? (d.lines ?? []).reduce((s, l) => s + Math.round(n(l.quantity) * n(l.unitPriceMinor)), 0) : null,
    status: d.status, paymentStatus: kind === 'purchase_invoice' ? d.paymentStatus ?? null : null, webPath: `${WEB_PATH[kind]}/${d._id}`,
  };
};

export interface TxQuery { type?: TxKind | undefined; status?: string | undefined; from?: Date | undefined; to?: Date | undefined; q?: string | undefined }
function kindFilter(kind: TxKind, companyId: Id, supplierId: Id, f: TxQuery): Record<string, unknown> | null {
  const k = KIND[kind]; const filter: Record<string, unknown> = { companyId, supplierId };
  if (f.status) {
    if (!(k.statuses as readonly string[]).includes(f.status)) return null;
    if (kind === 'purchase_invoice' && ['unpaid', 'partial', 'paid'].includes(f.status)) { filter.status = 'validated'; filter.paymentStatus = f.status; } else filter.status = f.status;
  }
  if (f.from || f.to) filter[k.date] = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = k.search.map((s) => ({ [s]: rx })); }
  return filter;
}
type Finder = { find: (f: object) => { select: (s: string) => { sort: (s: object) => { limit: (n: number) => { lean: () => Promise<DocLean[]> } } } }; countDocuments: (f: object) => Promise<number> };

async function rows(companyId: Id, supplierId: Id, perms: Perms, q: TxQuery, take: number) {
  const allowed = allowedKinds(perms);
  if (q.type && !allowed.includes(q.type)) throw AppError.forbidden(`Permission requise : ${TX_PERMISSION[q.type]}`);
  const base = await baseCurrencyOf(companyId);
  const parts = await Promise.all((q.type ? [q.type] : allowed).map(async (kind) => {
    const filter = kindFilter(kind, companyId, supplierId, q); if (!filter) return { rows: [] as TxRow[], total: 0 };
    const k = KIND[kind]; const M = k.model as unknown as Finder;
    const [docs, total] = await Promise.all([M.find(filter).select(k.select).sort({ [k.date]: -1, _id: -1 }).limit(take).lean(), M.countDocuments(filter)]);
    return { rows: docs.map((d) => toRow(kind, d, base)), total };
  }));
  const all = parts.flatMap((p) => p.rows).sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.id.localeCompare(a.id));
  return { all, total: parts.reduce((s, p) => s + p.total, 0), allowed };
}

/** Historique des achats : lit les documents réels des modules Achats et Importations (aucune copie). */
export async function transactions(companyId: Id, supplierId: string, perms: Perms, q: TxQuery & { page: number; limit: number }) {
  const s = await getOwn(companyId, supplierId);
  const r = await rows(companyId, s._id, perms, q, q.page * q.limit);
  return { items: r.all.slice((q.page - 1) * q.limit, q.page * q.limit), total: r.total, page: q.page, limit: q.limit, allowedKinds: r.allowed };
}
export async function transactionsExport(companyId: Id, supplierId: string, perms: Perms, q: TxQuery) {
  const s = await getOwn(companyId, supplierId);
  return { supplier: s.name, rows: (await rows(companyId, s._id, perms, q, 10_000)).all };
}

// ---------- Situation financière (calculée à partir des opérations réelles) ----------
const DUE = { $ifNull: ['$dueDate', '$invoiceDate'] };
const OPEN = { $max: [0, { $subtract: [{ $ifNull: ['$totals.totalTtcMinor', 0] }, { $ifNull: ['$paidMinor', 0] }] }] };
export async function finance(companyId: Id, supplierId: string, perms: Perms) {
  const s = await getOwn(companyId, supplierId); const sid = s._id; const today = startOfUtcDay();
  const match = { companyId, supplierId: sid, status: 'validated' as const };
  const isOverdue = { $and: [{ $lt: [DUE, today] }, { $gt: [OPEN, 0] }] };
  const [inv, pay, threshold, lastOrder, lastInvoice, lastImport] = await Promise.all([
    PurchaseInvoice.aggregate<{ ht: number; ttc: number; count: number; unpaid: number; unpaidCount: number; overdue: number; overdueCount: number }>([
      { $match: match },
      { $group: { _id: null, ht: { $sum: '$totals.totalHtMinor' }, ttc: { $sum: '$totals.totalTtcMinor' }, count: { $sum: 1 }, unpaid: { $sum: OPEN }, unpaidCount: { $sum: { $cond: [{ $gt: [OPEN, 0] }, 1, 0] } },
        overdue: { $sum: { $cond: [isOverdue, OPEN, 0] } }, overdueCount: { $sum: { $cond: [isOverdue, 1, 0] } } } },
    ]),
    SupplierPayment.aggregate<{ paid: number; count: number }>([{ $match: { companyId, supplierId: sid, status: 'active' } }, { $group: { _id: null, paid: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
    companyThresholdOf(companyId),
    perms.has('purchases:view') ? PurchaseOrder.findOne({ companyId, supplierId: sid, status: { $in: ['confirmed', 'partially_received', 'received'] } }).sort({ orderDate: -1 }).select('number orderDate').lean() : null,
    PurchaseInvoice.findOne(match).sort({ invoiceDate: -1 }).select('number invoiceDate').lean(),
    perms.has('imports:view') ? ImportFile.findOne({ companyId, supplierId: sid, status: { $nin: ['draft', 'cancelled'] } }).sort({ orderDate: -1 }).select('number orderDate').lean() : null,
  ]);
  const i = inv[0]; const paid = pay[0]?.paid ?? 0; const billed = n(i?.ttc); const computed = billed - paid; const dto = toDto(s, threshold);
  const last = [lastOrder && { date: lastOrder.orderDate, number: lastOrder.number }, lastInvoice && { date: lastInvoice.invoiceDate, number: lastInvoice.number ?? null }, lastImport && { date: lastImport.orderDate, number: lastImport.number }]
    .filter((x): x is { date: Date; number: string | null } => !!x).sort((a, b) => +new Date(b.date) - +new Date(a.date))[0];
  return {
    purchasesHtMinor: n(i?.ht), billedMinor: billed, invoiceCount: i?.count ?? 0, paidMinor: paid, paymentsCount: pay[0]?.count ?? 0,
    /** Solde officiel = solde tenu à jour par les factures d'achat validées et les règlements. */
    balanceMinor: n(s.balanceMinor), computedBalanceMinor: computed, consistent: computed === n(s.balanceMinor),
    unpaidMinor: n(i?.unpaid), unpaidCount: i?.unpaidCount ?? 0, overdueMinor: n(i?.overdue), overdueInvoices: i?.overdueCount ?? 0,
    upcomingMinor: n(i?.unpaid) - n(i?.overdue),
    /** Solde négatif : somme en faveur de la société. */
    excessMinor: n(s.balanceMinor) < 0 ? -n(s.balanceMinor) : 0,
    thresholdMinor: dto.effectiveThresholdMinor, ordersBlocked: dto.ordersBlocked,
    lastPurchaseDate: last?.date ?? null, lastPurchaseNumber: last?.number ?? null,
  };
}

/** Résumé : coordonnées toujours ; indicateurs financiers et opérations selon les permissions des modules sources. */
export async function summary(companyId: Id, supplierId: string, perms: Perms) {
  const s = await getOwn(companyId, supplierId);
  const [th, cats] = await Promise.all([companyThresholdOf(companyId), categoryMap(companyId)]);
  const kinds = allowedKinds(perms);
  const fin = canSeeAmounts(perms) ? await finance(companyId, supplierId, perms) : null;
  const recentDocs = kinds.length ? (await rows(companyId, s._id, perms, {}, 8)).all.slice(0, 8) : [];
  const recentPayments = perms.has('treasury:view')
    ? (await SupplierPayment.find({ companyId, supplierId: s._id, status: 'active' }).sort({ paidAt: -1, _id: -1 }).limit(5).lean()).map((p) => paymentRow(p, new Map())) : [];
  return { supplier: redact(toDto(s, th, cats), perms), finance: fin, recent: { documents: recentDocs, payments: recentPayments }, allowedKinds: kinds };
}

// ---------- Règlements ----------
interface PaymentLean { _id: Id; number: string; allocations: { purchaseInvoiceId?: Id | null; number?: string | null; amountMinor: number }[]; amountMinor: number; method: string; paidAt: Date; reference?: string | null; status: string; treasuryAccountId?: Id | null; cancelledAt?: Date | null }
const paymentRow = (p: PaymentLean, accounts: Map<string, string>) => ({
  id: p._id.toString(), number: p.number, reference: p.reference ?? null, paidAt: p.paidAt, amountMinor: p.amountMinor, method: p.method, status: p.status, cancelledAt: p.cancelledAt ?? null,
  invoices: (p.allocations ?? []).map((a) => ({ id: String(a.purchaseInvoiceId), number: a.number ?? null, amountMinor: a.amountMinor })),
  account: p.treasuryAccountId ? accounts.get(String(p.treasuryAccountId)) ?? null : null,
});
const accountNames = async (companyId: Id, items: PaymentLean[]) => {
  const ids = [...new Set(items.map((p) => p.treasuryAccountId?.toString()).filter(Boolean) as string[])];
  return new Map((ids.length ? await TreasuryAccount.find({ companyId, _id: { $in: ids } }).select('name').lean() : []).map((a) => [a._id.toString(), a.name]));
};

/** Factures d'achat ouvertes, de la plus ancienne échéance à la plus récente. */
async function openInvoices(companyId: Id, supplierId: Id) {
  const today = startOfUtcDay();
  const list = await PurchaseInvoice.find({ companyId, supplierId, status: 'validated', paymentStatus: { $ne: 'paid' } }).select('number supplierInvoiceNumber invoiceDate dueDate totals paidMinor paymentStatus').lean();
  return list.map((i) => {
    const due = i.dueDate ?? i.invoiceDate;
    return { id: i._id.toString(), number: i.number ?? null, supplierInvoiceNumber: i.supplierInvoiceNumber, invoiceDate: i.invoiceDate, dueDate: due, totalMinor: n(i.totals?.totalTtcMinor), paidMinor: n(i.paidMinor),
      remainingMinor: Math.max(0, n(i.totals?.totalTtcMinor) - n(i.paidMinor)), paymentStatus: i.paymentStatus ?? 'unpaid', overdue: new Date(due) < today };
  }).filter((i) => i.remainingMinor > 0).sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate)).slice(0, 200);
}

/** Onglet Paiements : situation et factures ouvertes (permission financière) ; historique des règlements réservé à la Trésorerie. */
export async function payments(companyId: Id, supplierId: string, perms: Perms, q: { page: number; limit: number }) {
  const s = await getOwn(companyId, supplierId);
  const treasury = perms.has('treasury:view');
  const filter = { companyId, supplierId: s._id };
  const [fin, unpaid, items, total] = await Promise.all([
    finance(companyId, supplierId, perms), openInvoices(companyId, s._id),
    treasury ? SupplierPayment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean() : [],
    treasury ? SupplierPayment.countDocuments(filter) : 0,
  ]);
  const accounts = await accountNames(companyId, items);
  return { finance: fin, unpaidInvoices: unpaid, items: items.map((p) => paymentRow(p, accounts)), total, page: q.page, limit: q.limit, canSeeHistory: treasury, currency: await baseCurrencyOf(companyId) };
}
export async function paymentsExport(companyId: Id, supplierId: string) {
  const s = await getOwn(companyId, supplierId);
  const items = await SupplierPayment.find({ companyId, supplierId: s._id }).sort({ paidAt: -1, _id: -1 }).limit(10_000).lean();
  const accounts = await accountNames(companyId, items);
  return { supplier: s.name, currency: await baseCurrencyOf(companyId), rows: items.map((p) => paymentRow(p, accounts)) };
}

/** Relevé de compte fournisseur : mêmes données que la comptabilité (permission accounting:view). */
export async function statement(companyId: Id, supplierId: string) {
  await getOwn(companyId, supplierId);
  const st = await thirdPartyStatement(companyId, 'supplier', supplierId);
  return st as { name: string; balanceMinor: number; documents: { id: string; number: string | null; supplierInvoiceNumber: string; date: Date; dueDate: Date | null; amountMinor: number; paidMinor: number; paymentStatus?: string }[] };
}
