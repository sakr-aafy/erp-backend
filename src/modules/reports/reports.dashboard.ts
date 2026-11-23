import { AuditLog } from '../../models/audit-log.model.js';
import { Invoice } from '../../models/sales.model.js';
import { PurchaseInvoice, PurchaseOrder } from '../../models/logistics.model.js';
import { Expense } from '../../models/finance.model.js';
import { Customer } from '../../models/customer.model.js';
import { payables, receivables } from '../accounting/accounting.service.js';
import { overview } from '../stock/stock.queries.js';
import { position } from '../treasury/treasury.service.js';
import { bucketExpr, fillPeriods, nameMap, range, sumField } from './report.helpers.js';
import { productSales, salesMatch } from './reports.commercial.js';
import type { Ctx, GroupBy, Id } from './report.types.js';

const DAY = 86_400_000;
const startOfUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const delta = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);
const cmp = (cur: number, prev: number) => ({ current: cur, previous: prev, deltaPct: delta(cur, prev) });

/** Période par défaut : mois en cours. Période de comparaison : même durée, juste avant. */
export function periods(from?: Date, to?: Date, now = new Date()) {
  const t = startOfUtc(now);
  const f = from ? startOfUtc(from) : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const e = to ? startOfUtc(to) : from ? t : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  const days = Math.max(1, Math.round((e.getTime() - f.getTime()) / DAY) + 1);
  const pe = new Date(f.getTime() - DAY); const pf = new Date(pe.getTime() - (days - 1) * DAY);
  const granularity: GroupBy = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
  return { from: f, to: e, prevFrom: pf, prevTo: pe, days, granularity };
}

const salesTotals = async (companyId: Id, from: Date, to: Date) => {
  const c: Ctx = { companyId, f: { from, to, groupBy: 'month' } };
  const [g] = await Invoice.aggregate<{ htMinor: number; ttcMinor: number; invoices: number; creditNotes: number }>([{ $match: salesMatch(c) }, { $group: { _id: null, htMinor: sumField('totals.totalHtMinor', true), ttcMinor: sumField('totals.totalTtcMinor', true),
    invoices: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } }, creditNotes: { $sum: { $cond: [{ $eq: ['$type', 'credit_note'] }, 1, 0] } } } }]);
  return g ?? { htMinor: 0, ttcMinor: 0, invoices: 0, creditNotes: 0 };
};
const unpaidOf = async (companyId: Id) => (await Invoice.aggregate<{ n: number; due: number; overdue: number }>([{ $match: { companyId, status: 'validated', type: 'invoice', paymentStatus: { $ne: 'paid' } } },
  { $group: { _id: null, n: { $sum: 1 }, due: { $sum: { $max: [0, { $subtract: [{ $subtract: ['$totals.totalPayableMinor', { $ifNull: ['$paidMinor', 0] }] }, { $ifNull: ['$creditedMinor', 0] }] }] } },
    overdue: { $sum: { $reduce: { input: '$schedule', initialValue: 0, in: { $add: ['$$value', { $cond: [{ $lt: ['$$this.dueDate', startOfUtc(new Date())] }, { $max: [0, { $subtract: [{ $subtract: ['$$this.amountMinor', { $ifNull: ['$$this.paidMinor', 0] }] }, { $ifNull: ['$$this.creditedMinor', 0] }] }] }, 0] }] } } } } } }]))[0] ?? { n: 0, due: 0, overdue: 0 };
const sumExpenses = async (companyId: Id, from: Date, to: Date) => (await Expense.aggregate<{ v: number }>([{ $match: { companyId, status: 'validated', date: range({ from, to }) } }, { $group: { _id: null, v: { $sum: '$amountMinor' } } }]))[0]?.v ?? 0;
const purchaseTotals = async (companyId: Id, from: Date, to: Date) => (await PurchaseInvoice.aggregate<{ ht: number; ttc: number; n: number }>([{ $match: { companyId, status: 'validated', invoiceDate: range({ from, to }) } },
  { $group: { _id: null, ht: { $sum: '$totals.totalHtMinor' }, ttc: { $sum: '$totals.totalTtcMinor' }, n: { $sum: 1 } } }]))[0] ?? { ht: 0, ttc: 0, n: 0 };
const marginOf = async (companyId: Id, from: Date, to: Date) => { const ps = await productSales({ companyId, f: { from, to, groupBy: 'month' } }); const costed = ps.filter((p) => p.marginMinor !== null);
  return { marginMinor: costed.reduce((s, p) => s + (p.marginMinor ?? 0), 0), baseHtMinor: costed.reduce((s, p) => s + p.htMinor, 0) }; };
async function revenueSeries(companyId: Id, from: Date, to: Date, g: GroupBy) {
  const c: Ctx = { companyId, f: { from, to, groupBy: g } };
  const rows = await Invoice.aggregate<{ _id: string; v: number }>([{ $match: salesMatch(c) }, { $group: { _id: bucketExpr(g, 'issueDate'), v: sumField('totals.totalHtMinor', true) } }]);
  return fillPeriods(rows.map((x) => ({ period: x._id, v: x.v })), g, { from, to }, { v: 0 }).map((x) => ({ label: String(x['period']), value: Number(x['v']) }));
}

/**
 * Tableau de bord : chaque bloc n'est calculé et renvoyé QUE si l'utilisateur possède les permissions de son module
 * (les autres blocs sont absents de la réponse, jamais « à zéro »).
 */
export async function dashboard(companyId: Id, has: (p: string) => boolean, q: { from?: Date | undefined; to?: Date | undefined }) {
  const p = periods(q.from, q.to); const out: Record<string, unknown> = { period: { from: iso(p.from), to: iso(p.to), previousFrom: iso(p.prevFrom), previousTo: iso(p.prevTo), days: p.days, granularity: p.granularity }, generatedAt: new Date().toISOString() };
  const jobs: Promise<void>[] = [];
  if (has('invoices:view')) jobs.push((async () => {
    const sc: Ctx = { companyId, f: { from: p.from, to: p.to, groupBy: 'month' } };
    const [cur, prev, un, series, prevSeries, rec, topC, topP] = await Promise.all([
      salesTotals(companyId, p.from, p.to), salesTotals(companyId, p.prevFrom, p.prevTo), unpaidOf(companyId),
      revenueSeries(companyId, p.from, p.to, p.granularity), revenueSeries(companyId, p.prevFrom, p.prevTo, p.granularity), receivables(companyId),
      Invoice.aggregate<{ _id: unknown; v: number }>([{ $match: salesMatch(sc) }, { $group: { _id: '$customerId', v: sumField('totals.totalHtMinor', true) } }, { $sort: { v: -1 } }, { $limit: 5 }]),
      productSales(sc)]);
    const cn = await nameMap(Customer, topC.map((x) => x._id as string));
    out['sales'] = { revenueHt: cmp(cur.htMinor, prev.htMinor), revenueTtc: cmp(cur.ttcMinor, prev.ttcMinor), invoices: cmp(cur.invoices, prev.invoices), creditNotes: cmp(cur.creditNotes, prev.creditNotes),
      series: { granularity: p.granularity, current: series, previous: prevSeries.map((x, i) => ({ label: series[i]?.label ?? x.label, value: x.value })) },
      unpaid: { count: un.n, dueMinor: un.due, overdueMinor: un.overdue }, receivablesMinor: rec.totalMinor,
      topCustomers: topC.map((x) => ({ name: cn.get(String(x._id)) ?? '—', htMinor: x.v })), topProducts: topP.slice(0, 5).map((x) => ({ name: x.name, htMinor: x.htMinor, qty: x.qty })) };
    if (has('costCalculation:view')) { const [m, mp] = await Promise.all([marginOf(companyId, p.from, p.to), marginOf(companyId, p.prevFrom, p.prevTo)]); out['margin'] = { amount: cmp(m.marginMinor, mp.marginMinor), pct: m.baseHtMinor ? Math.round((m.marginMinor / m.baseHtMinor) * 1000) / 10 : null, note: 'Marge estimée au coût de revient actuel, sur les lignes dont le coût est connu.' }; }
  })());
  if (has('purchases:view')) jobs.push((async () => {
    const [cur, prev, pay, pend] = await Promise.all([purchaseTotals(companyId, p.from, p.to), purchaseTotals(companyId, p.prevFrom, p.prevTo), payables(companyId), PurchaseOrder.countDocuments({ companyId, status: { $in: ['confirmed', 'partially_received'] } })]);
    out['purchases'] = { purchasesHt: cmp(cur.ht, prev.ht), purchasesTtc: cmp(cur.ttc, prev.ttc), invoices: cmp(cur.n, prev.n), payablesMinor: pay.totalMinor, pendingOrders: pend };
  })());
  if (has('expenses:view')) jobs.push((async () => { const [a, b] = await Promise.all([sumExpenses(companyId, p.from, p.to), sumExpenses(companyId, p.prevFrom, p.prevTo)]); out['expenses'] = { total: cmp(a, b) }; })());
  if (has('treasury:view')) jobs.push((async () => { const t = await position(companyId); out['treasury'] = { totalMinor: t.totalMinor, bankMinor: t.bankMinor, cashMinor: t.cashMinor, accounts: t.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balanceMinor: a.balanceMinor })) }; })());
  if (has('inventory:view')) jobs.push((async () => { const o = await overview(companyId, { status: 'alert', page: 1, limit: 8 }); out['stock'] = { valueMinor: o.summary.valueMinor, lowCount: o.summary.lowCount, outCount: o.summary.outCount, alerts: o.items.map((i) => ({ reference: i.reference, name: i.name, qty: i.qty, minStock: i.minStock, status: i.status })) }; })());
  if (has('audit:view')) jobs.push((async () => { const items = await AuditLog.find({ companyId }).sort({ at: -1 }).limit(8).select('userName action resource at success').lean(); out['activity'] = items.map((a) => ({ id: String(a._id), user: a.userName ?? null, action: a.action, resource: a.resource, at: a.at, success: a.success !== false })); })());
  await Promise.all(jobs);
  return out;
}
