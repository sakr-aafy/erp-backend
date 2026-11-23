import { z } from 'zod';
import type { QueryFilter, Types } from 'mongoose';
import { AccountingSettings, ENTRY_ROLES, JOURNALS, JournalEntry, TreasuryAccount, TreasuryMovement, type JournalEntryDoc } from '../../models/finance.model.js';
import { Invoice, Payment } from '../../models/sales.model.js';
import { PurchaseInvoice } from '../../models/logistics.model.js';
import { Customer } from '../../models/customer.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex, objectId } from '../../utils/pagination.js';
import { accountMap } from '../../services/accounting.service.js';
import { rangeFilter } from '../sales/document.http.js';

type Id = Types.ObjectId;

// ---------- Paramétrage ----------
export const ROLE_LABELS: Record<string, string> = { customer: 'Clients', sales: 'Ventes', vat_collected: 'TVA collectée', withholding: 'Retenue à la source subie', stamp: 'Timbre fiscal', supplier: 'Fournisseurs', purchases: 'Achats', vat_deductible: 'TVA déductible', cash: 'Caisse', bank: 'Banque', expense: 'Dépenses (par défaut)', internal_transfer: 'Virements internes' };
export const settingsBody = z.object({ accounts: z.partialRecord(z.enum(ENTRY_ROLES), z.string().trim().max(30)).optional(), allowExpenseSelfValidation: z.boolean().optional() }).strict();
export async function getSettings(companyId: Id) {
  const s = await AccountingSettings.findOne({ companyId }).lean();
  return { roles: ENTRY_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], accountCode: (await_get(s?.accounts, r)) ?? null })), allowExpenseSelfValidation: !!s?.allowExpenseSelfValidation };
}
const await_get = (m: unknown, k: string): string | undefined => (m instanceof Map ? m.get(k) : (m as Record<string, string> | undefined)?.[k]);
export async function saveSettings(companyId: Id, b: z.infer<typeof settingsBody>) {
  const set: Record<string, unknown> = {};
  if (b.accounts) { const cur = await accountMap(companyId); const next = { ...cur }; for (const [k, v] of Object.entries(b.accounts)) { if (v) next[k] = v; else delete next[k]; } set.accounts = next; }
  if (b.allowExpenseSelfValidation !== undefined) set.allowExpenseSelfValidation = b.allowExpenseSelfValidation;
  await AccountingSettings.updateOne({ companyId }, { $set: set }, { upsert: true }); return getSettings(companyId);
}

// ---------- Journaux ----------
export const entryDto = (e: JournalEntryDoc & { _id: Id }) => ({ id: e._id.toString(), journal: e.journal, number: e.number, date: e.date, label: e.label, totalMinor: e.totalMinor, reversal: !!e.reversal,
  source: e.source?.type ? { type: e.source.type, id: String(e.source.id), number: e.source.number ?? null } : null,
  lines: e.lines.map((l) => ({ role: l.role, roleLabel: ROLE_LABELS[l.role], accountCode: l.accountCode ?? null, label: l.label ?? null, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0, thirdPartyId: l.thirdPartyId?.toString() ?? null })) });
export interface EntryFilter { journal?: string | undefined; q?: string | undefined; sourceId?: string | undefined; sourceType?: string | undefined; from?: Date | undefined; to?: Date | undefined; page?: number; limit?: number }
const efilter = (companyId: Id, f: EntryFilter) => {
  const filter: QueryFilter<JournalEntryDoc> = { companyId }; if (f.journal) filter.journal = f.journal as never; if (f.sourceId) filter['source.id'] = f.sourceId as never; if (f.sourceType) filter['source.type'] = f.sourceType as never;
  const r = rangeFilter(f.from, f.to); if (r) filter.date = r; if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { label: rx }, { 'source.number': rx }]; } return filter;
};
export async function listEntries(companyId: Id, f: EntryFilter) {
  const filter = efilter(companyId, f); const page = f.page ?? 1; const limit = f.limit ?? 20;
  const [items, total] = await Promise.all([JournalEntry.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), JournalEntry.countDocuments(filter)]);
  return { items: items.map((e) => entryDto(e as never)), total, page, limit };
}
export async function allEntries(companyId: Id, f: EntryFilter) { return (await JournalEntry.find(efilter(companyId, f)).sort({ date: 1, number: 1 }).limit(20000).lean()).map((e) => entryDto(e as never)); }
export async function getEntry(companyId: Id, id: string) { const e = await JournalEntry.findOne({ _id: id, companyId }).lean(); if (!e) throw AppError.notFound('Écriture introuvable'); return entryDto(e as never); }
/** Centralisateur : totaux débit/crédit par journal et par rôle de compte (sur la période). */
export async function centralizer(companyId: Id, f: { from?: Date | undefined; to?: Date | undefined }) {
  const match: Record<string, unknown> = { companyId }; const r = rangeFilter(f.from, f.to); if (r) match.date = r;
  const rows = await JournalEntry.aggregate<{ _id: { j: string; r: string }; d: number; c: number; n: number }>([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: { j: '$journal', r: '$lines.role' }, d: { $sum: '$lines.debitMinor' }, c: { $sum: '$lines.creditMinor' }, n: { $sum: 1 } } }]);
  const counts = await JournalEntry.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$journal', n: { $sum: 1 } } }]); const cn = new Map(counts.map((c) => [c._id, c.n]));
  const journals = JOURNALS.map((j) => { const lines = rows.filter((x) => x._id.j === j).map((x) => ({ role: x._id.r, roleLabel: ROLE_LABELS[x._id.r], debitMinor: x.d, creditMinor: x.c })); return { journal: j, entries: cn.get(j) ?? 0, debitMinor: lines.reduce((s, l) => s + l.debitMinor, 0), creditMinor: lines.reduce((s, l) => s + l.creditMinor, 0), lines }; });
  return { journals, debitMinor: journals.reduce((s, j) => s + j.debitMinor, 0), creditMinor: journals.reduce((s, j) => s + j.creditMinor, 0) };
}
/** Traçabilité : écritures + mouvements de trésorerie rattachés à un document source. */
export async function trace(companyId: Id, sourceId: string) {
  const [entries, movements] = await Promise.all([JournalEntry.find({ companyId, 'source.id': sourceId }).sort({ date: 1, _id: 1 }).lean(), TreasuryMovement.find({ companyId, 'source.id': sourceId }).sort({ date: 1, _id: 1 }).lean()]);
  return { entries: entries.map((e) => entryDto(e as never)), movements: movements.map((m) => ({ id: m._id.toString(), accountId: m.accountId.toString(), direction: m.direction, amountMinor: m.amountMinor, date: m.date, label: m.label, kind: m.kind })) };
}

// ---------- Créances et dettes (suivi + ancienneté) ----------
const DAY = 86400000; export const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const; type Bucket = (typeof BUCKETS)[number];
const bucketOf = (due: Date, today: Date): Bucket => { const late = Math.floor((today.getTime() - due.getTime()) / DAY); return late <= 0 ? 'notDue' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90plus'; };
const emptyB = () => ({ notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 });
export interface Slice { limit?: number; offset?: number }
export async function receivables(companyId: Id, asOf = new Date(), sl: Slice = {}) {
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const invs = await Invoice.find({ companyId, type: 'invoice', status: 'validated', paymentStatus: { $ne: 'paid' } }).select('number issueDate customerId customerSnapshot totals schedule paidMinor creditedMinor').lean();
  const by = new Map<string, { customerId: string; name: string; totalMinor: number; buckets: ReturnType<typeof emptyB>; invoices: { id: string; number: string; issueDate: Date; dueDate: Date | null; openMinor: number; lateDays: number }[] }>();
  for (const i of invs) {
    const key = String(i.customerId); const row = by.get(key) ?? { customerId: key, name: i.customerSnapshot?.name ?? '', totalMinor: 0, buckets: emptyB(), invoices: [] };
    let open = 0; let firstDue: Date | null = null;
    for (const s of i.schedule) { const o = (s.amountMinor ?? 0) - (s.paidMinor ?? 0) - (s.creditedMinor ?? 0); if (o <= 0) continue; open += o; row.buckets[bucketOf(s.dueDate, today)] += o; if (!firstDue || s.dueDate < firstDue) firstDue = s.dueDate; }
    if (open <= 0) continue; row.totalMinor += open;
    row.invoices.push({ id: i._id.toString(), number: i.number ?? '', issueDate: i.issueDate, dueDate: firstDue, openMinor: open, lateDays: firstDue ? Math.max(0, Math.floor((today.getTime() - firstDue.getTime()) / DAY)) : 0 }); by.set(key, row);
  }
  const rows = [...by.values()].sort((a, b) => b.totalMinor - a.totalMinor); const totals = emptyB(); for (const r of rows) for (const b of BUCKETS) totals[b] += r.buckets[b];
  const bal = await Customer.aggregate<{ s: number }>([{ $match: { companyId } }, { $group: { _id: null, s: { $sum: '$balanceMinor' } } }]);
  const off = sl.offset ?? 0; return { asOf: today, totalMinor: rows.reduce((s, r) => s + r.totalMinor, 0), buckets: totals, customerCount: rows.length, customers: sl.limit ? rows.slice(off, off + sl.limit) : rows, customerBalancesMinor: bal[0]?.s ?? 0 };
}
export async function payables(companyId: Id, asOf = new Date(), sl: Slice = {}) {
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const invs = await PurchaseInvoice.find({ companyId, status: 'validated', paymentStatus: { $ne: 'paid' } }).select('number supplierInvoiceNumber invoiceDate dueDate supplierId supplier totals paidMinor').lean();
  const by = new Map<string, { supplierId: string; name: string; totalMinor: number; buckets: ReturnType<typeof emptyB>; invoices: { id: string; number: string; supplierInvoiceNumber: string; invoiceDate: Date; dueDate: Date; openMinor: number; lateDays: number }[] }>();
  for (const i of invs) {
    const open = (i.totals.totalTtcMinor ?? 0) - (i.paidMinor ?? 0); if (open <= 0) continue; const due = i.dueDate ?? i.invoiceDate;
    const key = String(i.supplierId); const row = by.get(key) ?? { supplierId: key, name: i.supplier?.name ?? '', totalMinor: 0, buckets: emptyB(), invoices: [] };
    row.totalMinor += open; row.buckets[bucketOf(due, today)] += open; row.invoices.push({ id: i._id.toString(), number: i.number ?? '', supplierInvoiceNumber: i.supplierInvoiceNumber, invoiceDate: i.invoiceDate, dueDate: due, openMinor: open, lateDays: Math.max(0, Math.floor((today.getTime() - due.getTime()) / DAY)) }); by.set(key, row);
  }
  const rows = [...by.values()].sort((a, b) => b.totalMinor - a.totalMinor); const totals = emptyB(); for (const r of rows) for (const b of BUCKETS) totals[b] += r.buckets[b];
  const bal = await Supplier.aggregate<{ s: number }>([{ $match: { companyId } }, { $group: { _id: null, s: { $sum: '$balanceMinor' } } }]);
  const off = sl.offset ?? 0; return { asOf: today, totalMinor: rows.reduce((s, r) => s + r.totalMinor, 0), buckets: totals, supplierCount: rows.length, suppliers: sl.limit ? rows.slice(off, off + sl.limit) : rows, supplierBalancesMinor: bal[0]?.s ?? 0 };
}
/** Fiche tiers : factures ouvertes + règlements (client ou fournisseur). */
export async function thirdPartyStatement(companyId: Id, kind: 'customer' | 'supplier', id: string) {
  if (kind === 'customer') {
    const c = await Customer.findOne({ _id: id, companyId }).lean(); if (!c) throw AppError.notFound('Client introuvable');
    const [invoices, payments] = await Promise.all([Invoice.find({ companyId, customerId: id, status: 'validated' }).select('number type issueDate totals paidMinor creditedMinor paymentStatus').sort({ issueDate: 1 }).lean(), Payment.find({ companyId, customerId: id, status: 'active' }).sort({ paidAt: 1 }).lean()]);
    return { name: c.name, balanceMinor: c.balanceMinor ?? 0, documents: invoices.map((i) => ({ id: i._id.toString(), number: i.number, type: i.type, date: i.issueDate, amountMinor: i.totals.totalPayableMinor ?? 0, paidMinor: i.paidMinor ?? 0, creditedMinor: i.creditedMinor ?? 0, paymentStatus: i.paymentStatus })), payments: payments.map((p) => ({ id: p._id.toString(), date: p.paidAt, amountMinor: p.amountMinor, method: p.method })) };
  }
  const s = await Supplier.findOne({ _id: id, companyId }).lean(); if (!s) throw AppError.notFound('Fournisseur introuvable');
  const invoices = await PurchaseInvoice.find({ companyId, supplierId: id, status: 'validated' }).select('number supplierInvoiceNumber invoiceDate dueDate totals paidMinor paymentStatus').sort({ invoiceDate: 1 }).lean();
  return { name: s.name, balanceMinor: s.balanceMinor ?? 0, documents: invoices.map((i) => ({ id: i._id.toString(), number: i.number, supplierInvoiceNumber: i.supplierInvoiceNumber, date: i.invoiceDate, dueDate: i.dueDate ?? null, amountMinor: i.totals.totalTtcMinor ?? 0, paidMinor: i.paidMinor ?? 0, paymentStatus: i.paymentStatus })) };
}

// ---------- Contrôles de cohérence ----------
export async function consistency(companyId: Id) {
  const [tot, cust, sup, trLedger, accs, mvs, custBal, supBal] = await Promise.all([
    JournalEntry.aggregate<{ d: number; c: number }>([{ $match: { companyId } }, { $unwind: '$lines' }, { $group: { _id: null, d: { $sum: '$lines.debitMinor' }, c: { $sum: '$lines.creditMinor' } } }]),
    JournalEntry.aggregate<{ s: number }>([{ $match: { companyId } }, { $unwind: '$lines' }, { $match: { 'lines.role': 'customer' } }, { $group: { _id: null, s: { $sum: { $subtract: ['$lines.debitMinor', '$lines.creditMinor'] } } } }]),
    JournalEntry.aggregate<{ s: number }>([{ $match: { companyId } }, { $unwind: '$lines' }, { $match: { 'lines.role': 'supplier' } }, { $group: { _id: null, s: { $sum: { $subtract: ['$lines.creditMinor', '$lines.debitMinor'] } } } }]),
    JournalEntry.aggregate<{ _id: Id; s: number }>([{ $match: { companyId } }, { $unwind: '$lines' }, { $match: { 'lines.treasuryAccountId': { $ne: null } } }, { $group: { _id: '$lines.treasuryAccountId', s: { $sum: { $subtract: ['$lines.debitMinor', '$lines.creditMinor'] } } } }]),
    TreasuryAccount.find({ companyId }).select('code').lean(),
    TreasuryMovement.aggregate<{ _id: Id; s: number }>([{ $match: { companyId } }, { $group: { _id: '$accountId', s: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', { $multiply: ['$amountMinor', -1] }] } } } }]),
    Customer.aggregate<{ s: number }>([{ $match: { companyId } }, { $group: { _id: null, s: { $sum: '$balanceMinor' } } }]),
    Supplier.aggregate<{ s: number }>([{ $match: { companyId } }, { $group: { _id: null, s: { $sum: '$balanceMinor' } } }]),
  ]);
  const issues: { type: string; message: string; detail?: unknown }[] = [];
  const d = tot[0]?.d ?? 0; const c = tot[0]?.c ?? 0; if (d !== c) issues.push({ type: 'unbalanced', message: `Σ débits (${d}) ≠ Σ crédits (${c})` });
  if ((cust[0]?.s ?? 0) !== (custBal[0]?.s ?? 0)) issues.push({ type: 'customer_ledger', message: `Compte clients en écritures (${cust[0]?.s ?? 0}) ≠ soldes clients (${custBal[0]?.s ?? 0})` });
  if ((sup[0]?.s ?? 0) !== (supBal[0]?.s ?? 0)) issues.push({ type: 'supplier_ledger', message: `Compte fournisseurs en écritures (${sup[0]?.s ?? 0}) ≠ soldes fournisseurs (${supBal[0]?.s ?? 0})` });
  const tl = new Map(trLedger.map((x) => [String(x._id), x.s])); const mv = new Map(mvs.map((x) => [String(x._id), x.s]));
  for (const a of accs) { const e = tl.get(String(a._id)) ?? 0; const m = mv.get(String(a._id)) ?? 0; if (e !== m) issues.push({ type: 'treasury_ledger', message: `Compte ${a.code} : écritures ${e} ≠ mouvements ${m}` }); }
  // Documents validés sans écriture
  const missing = async (kind: string, docs: { _id: Id; number?: string | null | undefined }[], key: (id: Id) => string) => {
    if (!docs.length) return; const keys = docs.map((x) => key(x._id)); const have = new Set((await JournalEntry.find({ companyId, eventKey: { $in: keys } }).select('eventKey').lean()).map((e) => e.eventKey));
    for (const x of docs) if (!have.has(key(x._id))) issues.push({ type: 'missing_entry', message: `${kind} ${x.number ?? x._id} sans écriture comptable`, detail: { kind, id: x._id.toString() } });
  };
  await missing('Facture', await Invoice.find({ companyId, type: 'invoice', status: 'validated' }).select('number totals').lean().then((r) => r.filter((x) => (x.totals.totalPayableMinor ?? 0) + (x.totals.withholdingMinor ?? 0) + (x.totals.totalHtMinor ?? 0) > 0)), (id) => `invoice.validated:${id}`);
  await missing('Avoir', await Invoice.find({ companyId, type: 'credit_note', status: 'validated' }).select('number').lean(), (id) => `creditNote.validated:${id}`);
  await missing('Facture d’achat', await PurchaseInvoice.find({ companyId, status: 'validated' }).select('number').lean(), (id) => `purchaseInvoice.validated:${id}`);
  await missing('Mouvement de trésorerie', (await TreasuryMovement.find({ companyId }).select('label').lean()).map((m) => ({ _id: m._id, number: m.label })), (id) => `treasuryMovement.recorded:${id}`);
  await missing('Encaissement sans compte', await Payment.find({ companyId, status: 'active', treasuryAccountId: null }).select('_id').lean(), (id) => `payment.recorded:${id}:entry`);
  return { consistent: issues.length === 0, issues, totals: { debitMinor: d, creditMinor: c } };
}
void objectId;
