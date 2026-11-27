import { Customer } from '../../models/customer.model.js';
import { Product, } from '../../models/product.model.js';
import { Category } from '../../models/product.model.js';
import { Invoice, Quotation } from '../../models/sales.model.js';
import { User } from '../../models/user.model.js';
import { expireOverdue as expireQuotations } from '../quotations/quotation.service.js';
import { barChart, bucketExpr, fillPeriods, lineChart, nameMap, oid, pct, range, sum, sumField } from './report.helpers.js';
import { MAX_ROWS, type Ctx, type ReportDef, type Row } from './report.types.js';

/** Factures et avoirs VALIDÉS de la période (les avoirs comptent en négatif : chiffres nets, comme `GET /invoices/summary`). */
export const salesMatch = (c: Ctx): Record<string, unknown> => {
  const r = range(c.f);
  return { companyId: c.companyId, status: 'validated', ...(r && { issueDate: r }), ...(c.f.customerId && { customerId: oid(c.f.customerId) }), ...(c.f.userId && { createdBy: oid(c.f.userId) }) };
};
const money = (key: string, label: string) => ({ key, label, type: 'money' as const });

/** Ventes par produit : lignes validées (HT net de remise ligne ET de la part de remise globale), avoirs en négatif. */
export async function productSales(c: Ctx) {
  const pipe: import('mongoose').PipelineStage[] = [{ $match: salesMatch(c) }, { $unwind: '$lines' }];
  if (c.f.productId) pipe.push({ $match: { 'lines.productId': oid(c.f.productId) } });
  pipe.push({ $group: { _id: { p: '$lines.productId', d: { $cond: [{ $ifNull: ['$lines.productId', false] }, null, '$lines.designation'] } },
    qty: { $sum: { $multiply: [{ $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] }, '$lines.quantity'] } },
    ht: { $sum: { $multiply: [{ $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] }, { $subtract: ['$lines.netHtMinor', { $ifNull: ['$lines.globalShareMinor', 0] }] }] } } } });
  const g = await Invoice.aggregate<{ _id: { p: import('mongoose').Types.ObjectId | null; d: string | null }; qty: number; ht: number }>(pipe);
  const ids = g.map((x) => x._id.p).filter(Boolean);
  const prods = await Product.find({ _id: { $in: ids } }).select('reference name categoryId costPriceMinor').lean();
  const pm = new Map(prods.map((p) => [String(p._id), p]));
  let rows = g.map((x) => {
    const p = x._id.p ? pm.get(String(x._id.p)) : undefined; const cost = p?.costPriceMinor ?? null;
    return { productId: x._id.p ? String(x._id.p) : null, reference: p?.reference ?? '—', name: p?.name ?? x._id.d ?? 'Ligne libre', categoryId: p?.categoryId ? String(p.categoryId) : null,
      qty: x.qty, htMinor: x.ht, costMinor: cost === null ? null : Math.round(cost * x.qty), marginMinor: cost === null ? null : x.ht - Math.round(cost * x.qty) };
  });
  if (c.f.categoryId) rows = rows.filter((r) => r.categoryId === c.f.categoryId);
  return rows.sort((a, b) => b.htMinor - a.htMinor);
}

/** Une échéance n'est « échue » qu'à partir du lendemain de sa date (une facture due aujourd'hui n'est pas en retard). */
const startOfToday = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
const PAY_LABEL: Record<string, string> = { unpaid: 'Non payées', partial: 'Partiellement payées', paid: 'Payées' };

export const commercialReports: ReportDef[] = [
  { key: 'sales-by-period', group: 'commercial', title: 'Ventes par période', description: 'Chiffre d’affaires HT / TVA / TTC net des avoirs, par jour, semaine, mois, trimestre ou année.',
    perms: ['invoices:view'], filters: ['period', 'groupBy', 'customerId', 'userId'],
    columns: [{ key: 'period', label: 'Période' }, { key: 'invoices', label: 'Factures', type: 'int' }, { key: 'creditNotes', label: 'Avoirs', type: 'int' }, money('htMinor', 'CA HT'), money('vatMinor', 'TVA'), money('ttcMinor', 'CA TTC')],
    async run(c) {
      const g = await Invoice.aggregate<Record<string, number | string>>([{ $match: salesMatch(c) }, { $group: { _id: bucketExpr(c.f.groupBy, 'issueDate'),
        invoices: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } }, creditNotes: { $sum: { $cond: [{ $eq: ['$type', 'credit_note'] }, 1, 0] } },
        htMinor: sumField('totals.totalHtMinor', true), vatMinor: sumField('totals.totalVatMinor', true), ttcMinor: sumField('totals.totalTtcMinor', true) } }]);
      const rows = fillPeriods(g.map(({ _id, ...r }) => ({ period: _id, ...r })), c.f.groupBy, c.f, { invoices: 0, creditNotes: 0, htMinor: 0, vatMinor: 0, ttcMinor: 0 });
      return { rows, totals: { period: 'Total', invoices: sum(rows, 'invoices'), creditNotes: sum(rows, 'creditNotes'), htMinor: sum(rows, 'htMinor'), vatMinor: sum(rows, 'vatMinor'), ttcMinor: sum(rows, 'ttcMinor') },
        chart: { type: 'bar', valueType: 'money', series: [{ label: 'CA HT', points: rows.map((r) => ({ label: String(r['period']), value: Number(r['htMinor']) })) }] } };
    } },
  { key: 'sales-by-customer', group: 'commercial', title: 'Ventes par client', description: 'Chiffre d’affaires, encaissé et reste dû par client (factures validées nettes des avoirs).',
    perms: ['invoices:view'], filters: ['period', 'customerId'],
    columns: [{ key: 'customer', label: 'Client' }, { key: 'invoices', label: 'Factures', type: 'int' }, { key: 'creditNotes', label: 'Avoirs', type: 'int' }, money('htMinor', 'CA HT'), money('ttcMinor', 'CA TTC'), money('paidMinor', 'Encaissé'), money('dueMinor', 'Reste dû')],
    async run(c) {
      const g = await Invoice.aggregate<Record<string, number>>([{ $match: salesMatch(c) }, { $group: { _id: '$customerId', invoices: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } }, creditNotes: { $sum: { $cond: [{ $eq: ['$type', 'credit_note'] }, 1, 0] } },
        htMinor: sumField('totals.totalHtMinor', true), ttcMinor: sumField('totals.totalTtcMinor', true),
        paidMinor: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, { $ifNull: ['$paidMinor', 0] }, 0] } },
        dueMinor: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, { $max: [0, { $subtract: [{ $subtract: ['$totals.totalPayableMinor', { $ifNull: ['$paidMinor', 0] }] }, { $ifNull: ['$creditedMinor', 0] }] }] }, 0] } } } }, { $sort: { htMinor: -1 } }]);
      const names = await nameMap(Customer, g.map((x) => x['_id'] as unknown as string));
      const rows: Row[] = g.map(({ _id, ...r }) => ({ customer: names.get(String(_id)) ?? '—', customerId: String(_id), ...r }));
      return { rows, totals: { customer: 'Total', invoices: sum(rows, 'invoices'), creditNotes: sum(rows, 'creditNotes'), htMinor: sum(rows, 'htMinor'), ttcMinor: sum(rows, 'ttcMinor'), paidMinor: sum(rows, 'paidMinor'), dueMinor: sum(rows, 'dueMinor') },
        chart: barChart('money', 'CA HT', rows, 'customer', 'htMinor', 10) };
    } },
  { key: 'sales-by-product', group: 'commercial', title: 'Ventes par produit', description: 'Quantités et CA HT par article ; marge estimée au coût de revient actuel (CMP) — indicative, le coût historique n’est pas rattaché aux lignes.',
    perms: ['invoices:view'], filters: ['period', 'customerId', 'productId', 'categoryId'],
    columns: [{ key: 'reference', label: 'Référence' }, { key: 'name', label: 'Article' }, { key: 'qty', label: 'Quantité', type: 'qty' }, money('htMinor', 'CA HT'), money('costMinor', 'Coût estimé'), money('marginMinor', 'Marge estimée'), { key: 'marginPct', label: 'Marge %', type: 'pct' }],
    async run(c) {
      const rows: Row[] = (await productSales(c)).map((r) => ({ ...r, marginPct: r.marginMinor === null ? null : pct(r.marginMinor, r.htMinor) }));
      return { rows: rows.slice(0, MAX_ROWS), totals: { reference: 'Total', qty: sum(rows, 'qty'), htMinor: sum(rows, 'htMinor'), costMinor: sum(rows, 'costMinor'), marginMinor: sum(rows, 'marginMinor') },
        chart: barChart('money', 'CA HT', rows, 'name', 'htMinor', 10), note: 'Marge estimée = CA HT − quantité × coût de revient actuel de l’article. Les lignes libres et services sans coût n’ont pas de marge.' };
    } },
  { key: 'sales-by-category', group: 'commercial', title: 'Ventes par catégorie', description: 'CA HT et marge estimée regroupés par famille d’articles.',
    perms: ['invoices:view'], filters: ['period', 'customerId', 'categoryId'],
    columns: [{ key: 'category', label: 'Catégorie' }, { key: 'qty', label: 'Quantité', type: 'qty' }, money('htMinor', 'CA HT'), { key: 'sharePct', label: 'Part du CA', type: 'pct' }, money('marginMinor', 'Marge estimée')],
    async run(c) {
      const ps = await productSales({ ...c, f: { ...c.f, productId: undefined } });
      const cats = await nameMap(Category, ps.map((p) => p.categoryId)); const by = new Map<string, { category: string; qty: number; htMinor: number; marginMinor: number }>();
      for (const p of ps) { const k = p.categoryId ? cats.get(p.categoryId) ?? 'Catégorie supprimée' : p.productId ? 'Sans catégorie' : 'Lignes libres / services'; const e = by.get(k) ?? { category: k, qty: 0, htMinor: 0, marginMinor: 0 };
        e.qty += p.qty; e.htMinor += p.htMinor; e.marginMinor += p.marginMinor ?? 0; by.set(k, e); }
      const total = [...by.values()].reduce((s, e) => s + e.htMinor, 0); const rows: Row[] = [...by.values()].sort((a, b) => b.htMinor - a.htMinor).map((e) => ({ ...e, sharePct: pct(e.htMinor, total) }));
      return { rows, totals: { category: 'Total', qty: sum(rows, 'qty'), htMinor: total, marginMinor: sum(rows, 'marginMinor') }, chart: barChart('money', 'CA HT', rows, 'category', 'htMinor', 10) };
    } },
  { key: 'sales-by-user', group: 'commercial', title: 'Ventes par utilisateur', description: 'CA HT par utilisateur ayant créé la facture (le modèle ne comporte pas de « commercial » distinct : le créateur du document fait foi).',
    perms: ['invoices:view', 'users:view'], filters: ['period', 'customerId', 'userId'],
    columns: [{ key: 'user', label: 'Utilisateur' }, { key: 'invoices', label: 'Factures', type: 'int' }, { key: 'creditNotes', label: 'Avoirs', type: 'int' }, money('htMinor', 'CA HT'), money('ttcMinor', 'CA TTC')],
    async run(c) {
      const g = await Invoice.aggregate<Record<string, number>>([{ $match: salesMatch(c) }, { $group: { _id: '$createdBy', invoices: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } }, creditNotes: { $sum: { $cond: [{ $eq: ['$type', 'credit_note'] }, 1, 0] } },
        htMinor: sumField('totals.totalHtMinor', true), ttcMinor: sumField('totals.totalTtcMinor', true) } }, { $sort: { htMinor: -1 } }]);
      const names = await nameMap(User, g.map((x) => x['_id'] as unknown as string)); const rows: Row[] = g.map(({ _id, ...r }) => ({ user: names.get(String(_id)) ?? 'Inconnu', userId: _id ? String(_id) : null, ...r }));
      return { rows, totals: { user: 'Total', invoices: sum(rows, 'invoices'), creditNotes: sum(rows, 'creditNotes'), htMinor: sum(rows, 'htMinor'), ttcMinor: sum(rows, 'ttcMinor') }, chart: barChart('money', 'CA HT', rows, 'user', 'htMinor', 10) };
    } },
  { key: 'quotations', group: 'commercial', title: 'Devis : acceptés, refusés, conversion', description: 'Répartition des devis par statut, montants et taux de conversion.',
    perms: ['quotations:view'], filters: ['period', 'customerId', 'status'], statusOptions: [{ value: 'pending', label: 'En attente' }, { value: 'sent', label: 'Envoyé' }, { value: 'accepted', label: 'Accepté' }, { value: 'refused', label: 'Refusé' }, { value: 'expired', label: 'Expiré' }],
    columns: [{ key: 'status', label: 'Statut' }, { key: 'count', label: 'Devis', type: 'int' }, money('htMinor', 'Total HT'), money('ttcMinor', 'Total TTC'), { key: 'sharePct', label: 'Part', type: 'pct' }],
    async run(c) {
      await expireQuotations(c.companyId); // statuts à jour avant le calcul
      const r = range(c.f); const match = { companyId: c.companyId, ...(r && { issueDate: r }), ...(c.f.customerId && { customerId: oid(c.f.customerId) }), ...(c.f.status && { status: c.f.status }) };
      const g = await Quotation.aggregate<{ _id: string; count: number; htMinor: number; ttcMinor: number; converted: number }>([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, htMinor: { $sum: '$totals.totalHtMinor' }, ttcMinor: { $sum: '$totals.totalTtcMinor' },
        converted: { $sum: { $cond: [{ $or: [{ $ne: [{ $ifNull: ['$invoiceId', null] }, null] }, { $ne: [{ $ifNull: ['$proformaId', null] }, null] }] }, 1, 0] } } } }]);
      const L: Record<string, string> = { pending: 'En attente', sent: 'Envoyé', accepted: 'Accepté', refused: 'Refusé', expired: 'Expiré' }; const total = g.reduce((s, x) => s + x.count, 0);
      const rows: Row[] = ['pending', 'sent', 'accepted', 'refused', 'expired'].map((s) => { const x = g.find((y) => y._id === s); return { status: L[s], statusKey: s, count: x?.count ?? 0, htMinor: x?.htMinor ?? 0, ttcMinor: x?.ttcMinor ?? 0, sharePct: pct(x?.count ?? 0, total) }; });
      const n = (s: string) => g.find((y) => y._id === s)?.count ?? 0; const decided = n('accepted') + n('refused') + n('expired'); const converted = g.reduce((s, x) => s + x.converted, 0);
      return { rows, totals: { status: 'Total', count: total, htMinor: sum(rows, 'htMinor'), ttcMinor: sum(rows, 'ttcMinor') },
        kpis: [{ label: 'Taux d’acceptation', value: pct(n('accepted'), decided), type: 'pct' }, { label: 'Devis transformés (proforma ou facture)', value: converted, type: 'int' }, { label: 'Taux de transformation', value: pct(converted, total), type: 'pct' }],
        chart: barChart('int', 'Devis', rows, 'status', 'count'), note: 'Taux d’acceptation = acceptés ÷ (acceptés + refusés + expirés). Taux de transformation = devis ayant donné une proforma ou une facture ÷ tous les devis.' };
    } },
  { key: 'invoices-status', group: 'commercial', title: 'Factures payées, partielles, impayées', description: 'Factures validées par état de règlement, avec le montant déjà échu.',
    perms: ['invoices:view'], filters: ['period', 'customerId', 'status'], statusOptions: [{ value: 'unpaid', label: 'Non payées' }, { value: 'partial', label: 'Partiellement payées' }, { value: 'paid', label: 'Payées' }],
    columns: [{ key: 'status', label: 'État' }, { key: 'count', label: 'Factures', type: 'int' }, money('payableMinor', 'Net à payer'), money('paidMinor', 'Encaissé'), money('creditedMinor', 'Avoirs imputés'), money('dueMinor', 'Reste dû'), money('overdueMinor', 'Dont échu')],
    async run(c) {
      const now = startOfToday(); const m = { ...salesMatch(c), type: 'invoice', ...(c.f.status && { paymentStatus: c.f.status }) };
      const g = await Invoice.aggregate<Record<string, number | string>>([{ $match: m }, { $group: { _id: '$paymentStatus', count: { $sum: 1 }, payableMinor: { $sum: '$totals.totalPayableMinor' }, paidMinor: { $sum: { $ifNull: ['$paidMinor', 0] } }, creditedMinor: { $sum: { $ifNull: ['$creditedMinor', 0] } },
        dueMinor: { $sum: { $max: [0, { $subtract: [{ $subtract: ['$totals.totalPayableMinor', { $ifNull: ['$paidMinor', 0] }] }, { $ifNull: ['$creditedMinor', 0] }] }] } },
        overdueMinor: { $sum: { $reduce: { input: '$schedule', initialValue: 0, in: { $add: ['$$value', { $cond: [{ $lt: ['$$this.dueDate', now] }, { $max: [0, { $subtract: [{ $subtract: ['$$this.amountMinor', { $ifNull: ['$$this.paidMinor', 0] }] }, { $ifNull: ['$$this.creditedMinor', 0] }] }] }, 0] }] } } } } } }]);
      const rows: Row[] = ['unpaid', 'partial', 'paid'].filter((s) => !c.f.status || s === c.f.status).map((s) => { const x = g.find((y) => y['_id'] === s); return { status: PAY_LABEL[s], statusKey: s, count: x?.['count'] ?? 0, payableMinor: x?.['payableMinor'] ?? 0, paidMinor: x?.['paidMinor'] ?? 0, creditedMinor: x?.['creditedMinor'] ?? 0, dueMinor: x?.['dueMinor'] ?? 0, overdueMinor: x?.['overdueMinor'] ?? 0 }; });
      return { rows, totals: { status: 'Total', count: sum(rows, 'count'), payableMinor: sum(rows, 'payableMinor'), paidMinor: sum(rows, 'paidMinor'), creditedMinor: sum(rows, 'creditedMinor'), dueMinor: sum(rows, 'dueMinor'), overdueMinor: sum(rows, 'overdueMinor') }, chart: barChart('int', 'Factures', rows, 'status', 'count') };
    } },
  { key: 'credit-notes', group: 'commercial', title: 'Avoirs', description: 'Liste des avoirs validés avec la facture d’origine et le motif.',
    perms: ['invoices:view'], filters: ['period', 'customerId'],
    columns: [{ key: 'number', label: 'N° avoir' }, { key: 'issueDate', label: 'Date', type: 'date' }, { key: 'customer', label: 'Client' }, { key: 'invoiceNumber', label: 'Facture d’origine' }, money('htMinor', 'HT'), money('vatMinor', 'TVA'), money('ttcMinor', 'TTC'), { key: 'reason', label: 'Motif' }],
    async run(c) {
      const docs = await Invoice.find({ ...salesMatch(c), type: 'credit_note' }).sort({ issueDate: -1, _id: -1 }).limit(MAX_ROWS + 1).select('number issueDate customerSnapshot creditedInvoiceId totals creditReason').lean();
      const orig = await nameMap(Invoice, docs.map((d) => d.creditedInvoiceId), 'number');
      const rows: Row[] = docs.slice(0, MAX_ROWS).map((d) => ({ number: d.number, issueDate: d.issueDate, customer: d.customerSnapshot?.name ?? '—', invoiceNumber: d.creditedInvoiceId ? orig.get(String(d.creditedInvoiceId)) ?? '—' : '—',
        htMinor: d.totals.totalHtMinor ?? 0, vatMinor: d.totals.totalVatMinor ?? 0, ttcMinor: d.totals.totalTtcMinor ?? 0, reason: d.creditReason ?? '' }));
      return { rows, truncated: docs.length > MAX_ROWS, totals: { number: 'Total', htMinor: sum(rows, 'htMinor'), vatMinor: sum(rows, 'vatMinor'), ttcMinor: sum(rows, 'ttcMinor') } };
    } },
];
void lineChart;
