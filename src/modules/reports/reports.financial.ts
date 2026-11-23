import { Types } from 'mongoose';
import { Expense, SupplierPayment, TreasuryAccount, TreasuryMovement } from '../../models/finance.model.js';
import { Payment } from '../../models/sales.model.js';
import { payables, receivables } from '../accounting/accounting.service.js';
import { barChart, bucketExpr, fillPeriods, lineChart, oid, pct, range, sum } from './report.helpers.js';
import type { ReportDef, Row } from './report.types.js';

const money = (key: string, label: string) => ({ key, label, type: 'money' as const });
const AGING: { key: string; label: string }[] = [{ key: 'notDue', label: 'Non échu' }, { key: 'd1_30', label: '1–30 j' }, { key: 'd31_60', label: '31–60 j' }, { key: 'd61_90', label: '61–90 j' }, { key: 'd90plus', label: '> 90 j' }];
const agingCols = (who: string) => [{ key: 'name', label: who }, ...AGING.map((a) => money(a.key, a.label)), money('totalMinor', 'Total dû')];
const METHODS: Record<string, string> = { cash: 'Espèces', check: 'Chèque', transfer: 'Virement', card: 'Carte', draft: 'Traite', other: 'Autre' };

export const financialReports: ReportDef[] = [
  { key: 'receivables-aging', group: 'financial', title: 'Créances clients et ancienneté', description: 'Restes à encaisser par client, répartis par ancienneté d’échéance.',
    perms: ['invoices:view', 'accounting:view'], filters: ['asOf', 'customerId'], columns: agingCols('Client'),
    async run(c) {
      const r = await receivables(c.companyId, c.f.asOf); let cust = r.customers; if (c.f.customerId) cust = cust.filter((x) => x.customerId === c.f.customerId);
      const rows: Row[] = cust.map((x) => ({ name: x.name, customerId: x.customerId, ...x.buckets, totalMinor: x.totalMinor }));
      const totals: Row = { name: 'Total', ...Object.fromEntries(AGING.map((a) => [a.key, sum(rows, a.key)])), totalMinor: sum(rows, 'totalMinor') };
      return { rows, totals, chart: { type: 'bar', valueType: 'money', series: [{ label: 'Créances', points: AGING.map((a) => ({ label: a.label, value: Number(totals[a.key]) })) }] },
        note: `Situation au ${r.asOf.toISOString().slice(0, 10)}. Les soldes clients des fiches (${r.customerBalancesMinor}) incluent d’éventuels avoirs excédentaires non ventilés.` };
    } },
  { key: 'payables-aging', group: 'financial', title: 'Dettes fournisseurs et ancienneté', description: 'Restes à payer par fournisseur, répartis par ancienneté d’échéance.',
    perms: ['purchases:view', 'accounting:view'], filters: ['asOf', 'supplierId'], columns: agingCols('Fournisseur'),
    async run(c) {
      const r = await payables(c.companyId, c.f.asOf); let sup = r.suppliers; if (c.f.supplierId) sup = sup.filter((x) => x.supplierId === c.f.supplierId);
      const rows: Row[] = sup.map((x) => ({ name: x.name, supplierId: x.supplierId, ...x.buckets, totalMinor: x.totalMinor }));
      const totals: Row = { name: 'Total', ...Object.fromEntries(AGING.map((a) => [a.key, sum(rows, a.key)])), totalMinor: sum(rows, 'totalMinor') };
      return { rows, totals, chart: { type: 'bar', valueType: 'money', series: [{ label: 'Dettes', points: AGING.map((a) => ({ label: a.label, value: Number(totals[a.key]) })) }] }, note: `Situation au ${r.asOf.toISOString().slice(0, 10)}.` };
    } },
  { key: 'receipts', group: 'financial', title: 'Encaissements', description: 'Encaissements clients par période et par mode de règlement.',
    perms: ['invoices:view'], filters: ['period', 'groupBy', 'customerId', 'status'], statusOptions: [{ value: 'active', label: 'Actifs' }, { value: 'cancelled', label: 'Annulés' }],
    columns: [{ key: 'period', label: 'Période' }, { key: 'count', label: 'Encaissements', type: 'int' }, money('amountMinor', 'Montant')],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to }); const m = { companyId: c.companyId, status: c.f.status ?? 'active', ...(r && { paidAt: r }), ...(c.f.customerId && { customerId: oid(c.f.customerId) }) };
      const [byP, byM] = await Promise.all([
        Payment.aggregate<{ _id: string; count: number; amountMinor: number }>([{ $match: m }, { $group: { _id: bucketExpr(c.f.groupBy, 'paidAt'), count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } }]),
        Payment.aggregate<{ _id: string; amountMinor: number }>([{ $match: m }, { $group: { _id: '$method', amountMinor: { $sum: '$amountMinor' } } }, { $sort: { amountMinor: -1 } }])]);
      const rows = fillPeriods(byP.map((x) => ({ period: x._id, count: x.count, amountMinor: x.amountMinor })), c.f.groupBy, c.f, { count: 0, amountMinor: 0 });
      return { rows, totals: { period: 'Total', count: sum(rows, 'count'), amountMinor: sum(rows, 'amountMinor') }, kpis: byM.map((x) => ({ label: METHODS[x._id] ?? x._id, value: x.amountMinor, type: 'money' as const })),
        chart: { type: 'bar', valueType: 'money', series: [{ label: 'Encaissements', points: rows.map((x) => ({ label: String(x['period']), value: Number(x['amountMinor']) })) }] } };
    } },
  { key: 'disbursements', group: 'financial', title: 'Décaissements', description: 'Règlements fournisseurs et dépenses validées par période.',
    perms: ['treasury:view', 'expenses:view'], filters: ['period', 'groupBy', 'supplierId'],
    columns: [{ key: 'period', label: 'Période' }, money('supplierMinor', 'Règlements fournisseurs'), money('expensesMinor', 'Dépenses'), money('totalMinor', 'Total')],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to });
      const [sp, ex] = await Promise.all([
        SupplierPayment.aggregate<{ _id: string; v: number }>([{ $match: { companyId: c.companyId, status: 'active', ...(r && { paidAt: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }) } }, { $group: { _id: bucketExpr(c.f.groupBy, 'paidAt'), v: { $sum: '$amountMinor' } } }]),
        c.f.supplierId ? Promise.resolve([] as { _id: string; v: number }[]) : Expense.aggregate<{ _id: string; v: number }>([{ $match: { companyId: c.companyId, status: 'validated', ...(r && { date: r }) } }, { $group: { _id: bucketExpr(c.f.groupBy, 'date'), v: { $sum: '$amountMinor' } } }])]);
      const by = new Map<string, Row>(); const get = (p: string) => by.get(p) ?? (by.set(p, { period: p, supplierMinor: 0, expensesMinor: 0, totalMinor: 0 }), by.get(p)!);
      for (const x of sp) { const e = get(x._id); e['supplierMinor'] = x.v; e['totalMinor'] = Number(e['totalMinor']) + x.v; }
      for (const x of ex) { const e = get(x._id); e['expensesMinor'] = x.v; e['totalMinor'] = Number(e['totalMinor']) + x.v; }
      const rows = fillPeriods([...by.values()], c.f.groupBy, c.f, { supplierMinor: 0, expensesMinor: 0, totalMinor: 0 });
      return { rows, totals: { period: 'Total', supplierMinor: sum(rows, 'supplierMinor'), expensesMinor: sum(rows, 'expensesMinor'), totalMinor: sum(rows, 'totalMinor') },
        chart: lineChart('money', [{ label: 'Règlements fournisseurs', key: 'supplierMinor' }, { label: 'Dépenses', key: 'expensesMinor' }], rows),
        note: c.f.supplierId ? 'Filtre fournisseur : les dépenses (sans fournisseur) sont exclues.' : undefined } as never;
    } },
  { key: 'expenses-by-category', group: 'financial', title: 'Dépenses par catégorie', description: 'Dépenses validées regroupées par catégorie.',
    perms: ['expenses:view'], filters: ['period', 'categoryId'],
    columns: [{ key: 'category', label: 'Catégorie' }, { key: 'count', label: 'Dépenses', type: 'int' }, money('totalMinor', 'Montant'), { key: 'sharePct', label: 'Part', type: 'pct' }],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to });
      const g = await Expense.aggregate<{ _id: Types.ObjectId; name: string; count: number; totalMinor: number }>([{ $match: { companyId: c.companyId, status: 'validated', ...(r && { date: r }), ...(c.f.categoryId && { categoryId: oid(c.f.categoryId) }) } },
        { $group: { _id: '$categoryId', name: { $first: '$categoryName' }, count: { $sum: 1 }, totalMinor: { $sum: '$amountMinor' } } }, { $sort: { totalMinor: -1 } }]);
      const total = g.reduce((s, x) => s + x.totalMinor, 0); const rows: Row[] = g.map((x) => ({ category: x.name ?? '—', categoryId: String(x._id), count: x.count, totalMinor: x.totalMinor, sharePct: pct(x.totalMinor, total) }));
      return { rows, totals: { category: 'Total', count: sum(rows, 'count'), totalMinor: total }, chart: barChart('money', 'Dépenses', rows, 'category', 'totalMinor', 10) };
    } },
  { key: 'treasury-by-account', group: 'financial', title: 'Trésorerie par compte', description: 'Solde d’ouverture, entrées, sorties et solde de clôture de chaque compte sur la période.',
    perms: ['treasury:view'], filters: ['period', 'accountId'],
    columns: [{ key: 'account', label: 'Compte' }, { key: 'type', label: 'Type' }, money('openingMinor', 'Ouverture'), money('inMinor', 'Entrées'), money('outMinor', 'Sorties'), money('closingMinor', 'Clôture')],
    async run(c) {
      const accs = await TreasuryAccount.find({ companyId: c.companyId, ...(c.f.accountId && { _id: oid(c.f.accountId) }) }).sort({ type: 1, code: 1 }).lean();
      const agg = (m: object) => TreasuryMovement.aggregate<{ _id: Types.ObjectId; inMinor: number; outMinor: number }>([{ $match: { companyId: c.companyId, ...m } }, { $group: { _id: '$accountId', inMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', 0] } }, outMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountMinor', 0] } } } }]);
      const [before, within] = await Promise.all([c.f.from ? agg({ date: { $lt: c.f.from } }) : Promise.resolve([]), agg(range({ from: c.f.from, to: c.f.to }) ? { date: range({ from: c.f.from, to: c.f.to }) } : {})]);
      const b = new Map(before.map((x) => [String(x._id), x])); const w = new Map(within.map((x) => [String(x._id), x]));
      const rows: Row[] = accs.map((a) => { const pre = b.get(String(a._id)); const cur = w.get(String(a._id)); const opening = (a.openingBalanceMinor ?? 0) + (pre ? pre.inMinor - pre.outMinor : 0); const i = cur?.inMinor ?? 0; const o = cur?.outMinor ?? 0;
        return { account: `${a.code} — ${a.name}`, type: a.type === 'bank' ? 'Banque' : 'Caisse', openingMinor: opening, inMinor: i, outMinor: o, closingMinor: opening + i - o }; });
      return { rows, totals: { account: 'Total', openingMinor: sum(rows, 'openingMinor'), inMinor: sum(rows, 'inMinor'), outMinor: sum(rows, 'outMinor'), closingMinor: sum(rows, 'closingMinor') }, chart: barChart('money', 'Solde de clôture', rows, 'account', 'closingMinor'),
        note: 'Les virements internes figurent en entrée sur un compte et en sortie sur l’autre (total neutre).' };
    } },
  { key: 'cashflow', group: 'financial', title: 'Évolution des flux financiers', description: 'Entrées et sorties de trésorerie par période (hors virements internes), avec flux net cumulé.',
    perms: ['treasury:view'], filters: ['period', 'groupBy', 'accountId'],
    columns: [{ key: 'period', label: 'Période' }, money('inMinor', 'Entrées'), money('outMinor', 'Sorties'), money('netMinor', 'Flux net'), money('cumulMinor', 'Cumul')],
    async run(c) {
      const r = range({ from: c.f.from, to: c.f.to });
      const g = await TreasuryMovement.aggregate<{ _id: string; inMinor: number; outMinor: number }>([{ $match: { companyId: c.companyId, 'source.type': { $ne: 'treasuryTransfer' }, ...(r && { date: r }), ...(c.f.accountId && { accountId: oid(c.f.accountId) }) } },
        { $group: { _id: bucketExpr(c.f.groupBy, 'date'), inMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amountMinor', 0] } }, outMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountMinor', 0] } } } }]);
      let cum = 0; const rows = fillPeriods(g.map((x) => ({ period: x._id, inMinor: x.inMinor, outMinor: x.outMinor })), c.f.groupBy, c.f, { inMinor: 0, outMinor: 0 }).map((x) => { const net = Number(x['inMinor']) - Number(x['outMinor']); cum += net; return { ...x, netMinor: net, cumulMinor: cum }; });
      return { rows, totals: { period: 'Total', inMinor: sum(rows, 'inMinor'), outMinor: sum(rows, 'outMinor'), netMinor: sum(rows, 'netMinor') }, chart: lineChart('money', [{ label: 'Entrées', key: 'inMinor' }, { label: 'Sorties', key: 'outMinor' }], rows) };
    } },
];
