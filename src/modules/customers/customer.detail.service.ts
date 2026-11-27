import type { PipelineStage, QueryFilter as FilterQuery, Types } from 'mongoose';
import { DeliveryNote, Invoice, Payment, Proforma, Quotation } from '../../models/sales.model.js';
import { TreasuryAccount } from '../../models/finance.model.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex } from '../../utils/pagination.js';
import { thirdPartyStatement } from '../accounting/accounting.service.js';
import { getOwn, toDto } from './customer.service.js';
import { expireOverdue as expireQuotations } from '../quotations/quotation.service.js';
import { QUOTATION_STATUSES, statusOf, storedStatuses, type QuotationStatus } from '../quotations/quotation.workflow.js';

type Id = Types.ObjectId;
export type DocKind = 'quotation' | 'proforma' | 'invoice' | 'credit_note' | 'delivery_note';
type Perms = ReadonlySet<string>;

/** Permission du module propriétaire de chaque type de document : la fiche client n'ouvre jamais l'accès à un module protégé. */
export const KIND_PERMISSION: Record<DocKind, string> = { quotation: 'quotations:view', proforma: 'proformas:view', invoice: 'invoices:view', credit_note: 'invoices:view', delivery_note: 'deliveryNotes:view' };
const allowedKinds = (perms: Perms) => (Object.keys(KIND_PERMISSION) as DocKind[]).filter((k) => perms.has(KIND_PERMISSION[k]));
const PDF_PATH: Record<DocKind, string> = { quotation: '/quotations', proforma: '/proformas', invoice: '/invoices', credit_note: '/invoices', delivery_note: '/delivery-notes' };
const WEB_PATH: Record<DocKind, string> = { quotation: '/quotations', proforma: '/proformas', invoice: '/invoices', credit_note: '/invoices', delivery_note: '/delivery-notes' };

const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const n = (v: number | null | undefined) => v ?? 0;

export interface Row {
  id: string; kind: DocKind; number: string | null; date: Date; totalHtMinor: number | null; totalTtcMinor: number | null; payableMinor: number | null;
  status: string; paymentStatus: string | null; pdfPath: string; webPath: string;
}
interface DocLean { _id: Id; number?: string | null; status: string; issueDate?: Date; deliveryDate?: Date; totals?: { totalHtMinor?: number | null; totalTtcMinor?: number | null; totalPayableMinor?: number | null } | null; type?: string; paymentStatus?: string | null }
const toRow = (kind: DocKind, d: DocLean): Row => ({
  id: d._id.toString(), kind, number: d.number ?? null, date: (d.issueDate ?? d.deliveryDate)!, totalHtMinor: d.totals?.totalHtMinor ?? null, totalTtcMinor: d.totals?.totalTtcMinor ?? null,
  payableMinor: d.totals?.totalPayableMinor ?? null, status: kind === 'quotation' ? statusOf(d.status) : d.status, paymentStatus: d.paymentStatus ?? null, pdfPath: `${PDF_PATH[kind]}/${d._id}/pdf`, webPath: `${WEB_PATH[kind]}/${d._id}`,
});

/** Statuts filtrables par type de document (un statut qui n'existe pas pour un type exclut ce type de la recherche). */
const STATUSES: Record<DocKind, string[]> = {
  quotation: [...QUOTATION_STATUSES], proforma: ['pending', 'converted', 'expired', 'cancelled'],
  invoice: ['draft', 'validated', 'unpaid', 'partial', 'paid'], credit_note: ['draft', 'validated'], delivery_note: ['draft', 'validated', 'cancelled'],
};

function kindFilter(kind: DocKind, companyId: Id, customerId: string, f: { status?: string | undefined; from?: Date | undefined; to?: Date | undefined; q?: string | undefined }): FilterQuery<DocLean> | null {
  const filter: Record<string, unknown> = { companyId, customerId };
  if (kind === 'invoice' || kind === 'credit_note') filter.type = kind;
  if (f.status) {
    if (!STATUSES[kind].includes(f.status)) return null;
    if (kind === 'invoice' && ['unpaid', 'partial', 'paid'].includes(f.status)) { filter.status = 'validated'; filter.paymentStatus = f.status; } else filter.status = kind === 'quotation' ? { $in: storedStatuses(f.status as QuotationStatus) } : f.status;
  }
  const dateField = kind === 'delivery_note' ? 'deliveryDate' : 'issueDate';
  if (f.from || f.to) filter[dateField] = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) filter.number = new RegExp(escapeRegex(f.q), 'i');
  return filter as FilterQuery<DocLean>;
}
const MODEL = { quotation: Quotation, proforma: Proforma, invoice: Invoice, credit_note: Invoice, delivery_note: DeliveryNote } as const;
const SELECT = 'number status issueDate deliveryDate totals type paymentStatus';

/** Historique commercial : lit les documents réels des modules Devis / Proforma / Factures / Avoirs / BL (aucune copie). */
export async function transactions(companyId: Id, customerId: string, perms: Perms, q: { type?: DocKind | undefined; status?: string | undefined; from?: Date | undefined; to?: Date | undefined; q?: string | undefined; page: number; limit: number }) {
  await getOwn(companyId, customerId);
  const allowed = allowedKinds(perms);
  if (q.type && !allowed.includes(q.type)) throw AppError.forbidden(`Permission requise : ${KIND_PERMISSION[q.type]}`);
  const kinds = q.type ? [q.type] : allowed;
  if (kinds.includes('quotation')) await expireQuotations(companyId);
  const take = q.page * q.limit;
  const parts = await Promise.all(kinds.map(async (kind) => {
    const filter = kindFilter(kind, companyId, customerId, q); if (!filter) return { rows: [] as Row[], total: 0 };
    const M = MODEL[kind] as unknown as { find: (f: object) => { select: (s: string) => { sort: (s: object) => { limit: (n: number) => { lean: () => Promise<DocLean[]> } } } }; countDocuments: (f: object) => Promise<number> };
    const [docs, total] = await Promise.all([M.find(filter).select(SELECT).sort({ [kind === 'delivery_note' ? 'deliveryDate' : 'issueDate']: -1, _id: -1 }).limit(take).lean(), M.countDocuments(filter)]);
    return { rows: docs.map((d) => toRow(kind, d)), total };
  }));
  const all = parts.flatMap((p) => p.rows).sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.id.localeCompare(a.id));
  return { items: all.slice((q.page - 1) * q.limit, q.page * q.limit), total: parts.reduce((s, p) => s + p.total, 0), page: q.page, limit: q.limit, allowedKinds: allowed };
}

// ---------- Situation financière (calculée à partir des opérations réelles) ----------
const REMAINING = { $max: [0, { $subtract: [{ $subtract: ['$totals.totalPayableMinor', { $ifNull: ['$paidMinor', 0] }] }, { $ifNull: ['$creditedMinor', 0] }] }] };
export async function finance(companyId: Id, customerId: string) {
  const cid = (await getOwn(companyId, customerId))._id;
  const today = startOfUtcDay();
  const sign = { $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] };
  const [inv, pay, last] = await Promise.all([
    Invoice.aggregate<{ _id: null; revenueHt: number; revenueTtc: number; billed: number; credits: number; invoices: number; unpaid: number; unpaidCount: number; overdue: number; overdueCount: number }>([
      { $match: { companyId, customerId: cid, status: 'validated' } },
      { $group: { _id: null,
        revenueHt: { $sum: { $multiply: [sign, '$totals.totalHtMinor'] } }, revenueTtc: { $sum: { $multiply: [sign, '$totals.totalTtcMinor'] } },
        billed: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, '$totals.totalPayableMinor', 0] } }, credits: { $sum: { $cond: [{ $eq: ['$type', 'credit_note'] }, '$totals.totalPayableMinor', 0] } },
        invoices: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } },
        unpaid: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, REMAINING, 0] } }, unpaidCount: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'invoice'] }, { $gt: [REMAINING, 0] }] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, { $reduce: { input: '$schedule', initialValue: 0, in: { $add: ['$$value', { $cond: [{ $lt: ['$$this.dueDate', today] }, { $max: [0, { $subtract: [{ $subtract: ['$$this.amountMinor', { $ifNull: ['$$this.paidMinor', 0] }] }, { $ifNull: ['$$this.creditedMinor', 0] }] }] }, 0] }] } } }, 0] } },
        overdueCount: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'invoice'] }, { $gt: [{ $size: { $filter: { input: '$schedule', as: 's', cond: { $and: [{ $lt: ['$$s.dueDate', today] }, { $gt: [{ $subtract: [{ $subtract: ['$$s.amountMinor', { $ifNull: ['$$s.paidMinor', 0] }] }, { $ifNull: ['$$s.creditedMinor', 0] }] }, 0] }] } } } }, 0] }] }, 1, 0] } } } },
    ] as PipelineStage[]),
    Payment.aggregate<{ _id: null; paid: number; count: number }>([{ $match: { companyId, customerId: cid, status: 'active' } }, { $group: { _id: null, paid: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
    Invoice.findOne({ companyId, customerId: cid, status: 'validated', type: 'invoice' }).sort({ issueDate: -1 }).select('issueDate number').lean(),
  ]);
  const i = inv[0]; const c = await getOwn(companyId, customerId); const dto = toDto(c);
  const paid = pay[0]?.paid ?? 0; const billed = n(i?.billed); const credits = n(i?.credits);
  const computed = billed - credits - paid;
  return {
    revenueHtMinor: n(i?.revenueHt), revenueTtcMinor: n(i?.revenueTtc), billedMinor: billed, creditNotesMinor: credits, paidMinor: paid, paymentsCount: pay[0]?.count ?? 0,
    /** Solde officiel = solde tenu à jour par les opérations validées (factures, avoirs, encaissements). */
    balanceMinor: dto.balanceMinor, computedBalanceMinor: computed, consistent: computed === dto.balanceMinor,
    unpaidMinor: n(i?.unpaid), unpaidCount: i?.unpaidCount ?? 0, overdueMinor: n(i?.overdue), overdueInvoices: i?.overdueCount ?? 0,
    excessMinor: dto.balanceMinor < 0 ? -dto.balanceMinor : 0,
    creditLimitMinor: dto.creditLimitMinor, availableCreditMinor: dto.availableCreditMinor, creditExceeded: dto.creditExceeded,
    lastSaleDate: last?.issueDate ?? null, lastInvoiceNumber: last?.number ?? null, invoiceCount: i?.invoices ?? 0,
  };
}

/** Résumé : coordonnées toujours ; indicateurs financiers et opérations selon les permissions des modules sources. */
export async function summary(companyId: Id, customerId: string, perms: Perms) {
  const c = await getOwn(companyId, customerId); const dto = toDto(c);
  const kinds = allowedKinds(perms);
  const fin = perms.has('invoices:view') ? await finance(companyId, customerId) : null;
  const recentDocs = kinds.length ? (await transactions(companyId, customerId, perms, { page: 1, limit: 8 })).items : [];
  let recentPayments: ReturnType<typeof paymentRow>[] = [];
  if (perms.has('invoices:view')) {
    const ps = await Payment.find({ companyId, customerId: c._id, status: 'active' }).sort({ paidAt: -1 }).limit(5).populate('invoiceId', 'number').lean();
    recentPayments = ps.map((p) => paymentRow(p as never, false, new Map()));
  }
  return { customer: dto, finance: fin, recent: { documents: recentDocs, payments: recentPayments }, allowedKinds: kinds };
}

// ---------- Paiements ----------
const paymentRow = (p: { _id: Id; invoiceId: Id | { _id: Id; number?: string | null }; amountMinor: number; method: string; paidAt: Date; reference?: string | null; status: string; treasuryAccountId?: Id | null }, withAccount: boolean, accounts: Map<string, string>) => {
  const inv = p.invoiceId as { _id?: Id; number?: string | null };
  const invId = inv && typeof inv === 'object' && '_id' in inv && inv._id ? inv._id : (p.invoiceId as Id);
  return {
    id: p._id.toString(), invoiceId: String(invId), invoiceNumber: (inv && 'number' in inv ? inv.number : null) ?? null, amountMinor: p.amountMinor, method: p.method, paidAt: p.paidAt,
    reference: p.reference ?? null, status: p.status, account: withAccount && p.treasuryAccountId ? accounts.get(String(p.treasuryAccountId)) ?? null : null,
  };
};

export async function payments(companyId: Id, customerId: string, perms: Perms, q: { page: number; limit: number }) {
  const c = await getOwn(companyId, customerId);
  const fin = await finance(companyId, customerId);
  const filter = { companyId, customerId: c._id };
  const [items, total, unpaid] = await Promise.all([
    Payment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('invoiceId', 'number').lean(),
    Payment.countDocuments(filter),
    Invoice.find({ companyId, customerId: c._id, status: 'validated', type: 'invoice', paymentStatus: { $ne: 'paid' } }).sort({ issueDate: 1 }).limit(100).select('number issueDate totals paidMinor creditedMinor paymentStatus schedule').lean(),
  ]);
  // Le compte de trésorerie n'est visible qu'avec la permission du module Trésorerie
  const withAccount = perms.has('treasury:view');
  const accIds = withAccount ? [...new Set(items.map((p) => p.treasuryAccountId?.toString()).filter(Boolean) as string[])] : [];
  const accounts = new Map((accIds.length ? await TreasuryAccount.find({ companyId, _id: { $in: accIds } }).select('name').lean() : []).map((a) => [a._id.toString(), a.name]));
  const today = startOfUtcDay();
  return {
    finance: fin, items: items.map((p) => ({ ...paymentRow(p as never, withAccount, accounts), cancelledAt: p.cancelledAt ?? null })), total, page: q.page, limit: q.limit, canSeeAccounts: withAccount,
    unpaidInvoices: unpaid.map((i) => {
      const remaining = Math.max(0, n(i.totals?.totalPayableMinor) - n(i.paidMinor) - n(i.creditedMinor));
      const due = (i.schedule ?? []).filter((s) => n(s.amountMinor) - n(s.paidMinor) - n(s.creditedMinor) > 0).sort((a, b) => +new Date(a.dueDate) - +new Date(b.dueDate))[0];
      return { id: i._id.toString(), number: i.number ?? null, issueDate: i.issueDate, totalMinor: n(i.totals?.totalPayableMinor), paidMinor: n(i.paidMinor), creditedMinor: n(i.creditedMinor), remainingMinor: remaining, paymentStatus: i.paymentStatus, nextDueDate: due?.dueDate ?? null, overdue: !!due && new Date(due.dueDate) < today };
    }),
  };
}

/** Relevé de compte client : mêmes données que la comptabilité (module Comptabilité, permission accounting:view). */
export async function statement(companyId: Id, customerId: string) {
  const st = await thirdPartyStatement(companyId, 'customer', customerId);
  return st as { name: string; balanceMinor: number; documents: { id: string; number: string | null; type: string; date: Date; amountMinor: number; paidMinor?: number; creditedMinor?: number; paymentStatus?: string }[] };
}
