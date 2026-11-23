import { ExchangeRate, ImportFile, PurchaseInvoice, PurchaseOrder } from '../../models/logistics.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { barChart, bucketExpr, fillPeriods, nameMap, oid, pct, range, sum } from './report.helpers.js';
import { MAX_ROWS, type ReportDef, type Row } from './report.types.js';

const money = (key: string, label: string) => ({ key, label, type: 'money' as const });
const qty = (key: string, label: string) => ({ key, label, type: 'qty' as const });
const PAY_LABEL: Record<string, string> = { unpaid: 'Non réglée', partial: 'Partiellement réglée', paid: 'Réglée' };
const ORDER_LABEL: Record<string, string> = { draft: 'Brouillon', confirmed: 'Confirmée', partially_received: 'Partiellement reçue', received: 'Reçue', cancelled: 'Annulée' };
const CHARGE_LABEL: Record<string, string> = { freight: 'Fret', customs_duty: 'Droits de douane', customs_fees: 'Frais de douane', transit: 'Transit', insurance: 'Assurance', other: 'Autres' };
const IMPORT_LABEL: Record<string, string> = { draft: 'Brouillon', ordered: 'Commandé', shipped: 'Expédié', customs: 'En douane', arrived: 'Arrivé', closed: 'Clôturé', integrated: 'Intégré', cancelled: 'Annulé' };

const piMatch = (c: { companyId: import('mongoose').Types.ObjectId; f: import('./report.types.js').Filters }) => {
  const r = range(c.f); return { companyId: c.companyId, status: 'validated' as const, ...(r && { invoiceDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }), ...(c.f.status && { paymentStatus: c.f.status as 'unpaid' | 'partial' | 'paid' }) };
};
const payStatuses = [{ value: 'unpaid', label: 'Non réglées' }, { value: 'partial', label: 'Partiellement réglées' }, { value: 'paid', label: 'Réglées' }];

export const purchaseReports: ReportDef[] = [
  { key: 'purchases-by-supplier', group: 'purchases', title: 'Achats par fournisseur', description: 'Factures d’achat validées : HT, TVA, TTC, réglé et reste dû par fournisseur.',
    perms: ['purchases:view'], filters: ['period', 'supplierId', 'status'], statusOptions: payStatuses,
    columns: [{ key: 'supplier', label: 'Fournisseur' }, { key: 'invoices', label: 'Factures', type: 'int' }, money('htMinor', 'HT'), money('vatMinor', 'TVA déductible'), money('ttcMinor', 'TTC'), money('paidMinor', 'Réglé'), money('dueMinor', 'Reste dû')],
    async run(c) {
      const g = await PurchaseInvoice.aggregate<Record<string, number>>([{ $match: piMatch(c) }, { $group: { _id: '$supplierId', invoices: { $sum: 1 }, htMinor: { $sum: '$totals.totalHtMinor' }, vatMinor: { $sum: '$totals.totalVatMinor' }, ttcMinor: { $sum: '$totals.totalTtcMinor' }, paidMinor: { $sum: { $ifNull: ['$paidMinor', 0] } } } }, { $sort: { htMinor: -1 } }]);
      const names = await nameMap(Supplier, g.map((x) => x['_id'] as unknown as string)); const rows: Row[] = g.map(({ _id, ...x }) => ({ supplier: names.get(String(_id)) ?? '—', supplierId: String(_id), ...x, dueMinor: (x['ttcMinor'] ?? 0) - (x['paidMinor'] ?? 0) }));
      return { rows, totals: { supplier: 'Total', invoices: sum(rows, 'invoices'), htMinor: sum(rows, 'htMinor'), vatMinor: sum(rows, 'vatMinor'), ttcMinor: sum(rows, 'ttcMinor'), paidMinor: sum(rows, 'paidMinor'), dueMinor: sum(rows, 'dueMinor') }, chart: barChart('money', 'Achats HT', rows, 'supplier', 'htMinor', 10) };
    } },
  { key: 'purchases-by-period', group: 'purchases', title: 'Achats par période', description: 'Factures d’achat validées par jour, semaine, mois, trimestre ou année.',
    perms: ['purchases:view'], filters: ['period', 'groupBy', 'supplierId', 'status'], statusOptions: payStatuses,
    columns: [{ key: 'period', label: 'Période' }, { key: 'invoices', label: 'Factures', type: 'int' }, money('htMinor', 'HT'), money('vatMinor', 'TVA'), money('ttcMinor', 'TTC')],
    async run(c) {
      const g = await PurchaseInvoice.aggregate<Record<string, number | string>>([{ $match: piMatch(c) }, { $group: { _id: bucketExpr(c.f.groupBy, 'invoiceDate'), invoices: { $sum: 1 }, htMinor: { $sum: '$totals.totalHtMinor' }, vatMinor: { $sum: '$totals.totalVatMinor' }, ttcMinor: { $sum: '$totals.totalTtcMinor' } } }]);
      const rows = fillPeriods(g.map(({ _id, ...x }) => ({ period: _id, ...x })), c.f.groupBy, c.f, { invoices: 0, htMinor: 0, vatMinor: 0, ttcMinor: 0 });
      return { rows, totals: { period: 'Total', invoices: sum(rows, 'invoices'), htMinor: sum(rows, 'htMinor'), vatMinor: sum(rows, 'vatMinor'), ttcMinor: sum(rows, 'ttcMinor') }, chart: { type: 'bar', valueType: 'money', series: [{ label: 'Achats HT', points: rows.map((x) => ({ label: String(x['period']), value: Number(x['htMinor']) })) }] } };
    } },
  { key: 'purchase-invoices', group: 'purchases', title: 'Factures d’achat', description: 'Liste des factures d’achat validées avec état de règlement et échéance.',
    perms: ['purchases:view'], filters: ['period', 'supplierId', 'status'], statusOptions: payStatuses,
    columns: [{ key: 'number', label: 'N° interne' }, { key: 'supplierInvoiceNumber', label: 'N° fournisseur' }, { key: 'invoiceDate', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'dueDate', label: 'Échéance', type: 'date' }, money('ttcMinor', 'TTC'), money('paidMinor', 'Réglé'), money('dueMinor', 'Reste dû'), { key: 'state', label: 'État' }],
    async run(c) {
      const docs = await PurchaseInvoice.find(piMatch(c)).sort({ invoiceDate: -1, _id: -1 }).limit(MAX_ROWS + 1).select('number supplierInvoiceNumber invoiceDate supplier dueDate totals paidMinor paymentStatus').lean();
      const rows: Row[] = docs.slice(0, MAX_ROWS).map((d) => ({ number: d.number, supplierInvoiceNumber: d.supplierInvoiceNumber, invoiceDate: d.invoiceDate, supplier: d.supplier?.name ?? '—', dueDate: d.dueDate ?? null, ttcMinor: d.totals.totalTtcMinor ?? 0, paidMinor: d.paidMinor ?? 0, dueMinor: (d.totals.totalTtcMinor ?? 0) - (d.paidMinor ?? 0), state: PAY_LABEL[d.paymentStatus ?? 'unpaid'] }));
      return { rows, truncated: docs.length > MAX_ROWS, totals: { number: 'Total', ttcMinor: sum(rows, 'ttcMinor'), paidMinor: sum(rows, 'paidMinor'), dueMinor: sum(rows, 'dueMinor') } };
    } },
  { key: 'orders-pending', group: 'purchases', title: 'Commandes d’achat en attente', description: 'Commandes confirmées ou partiellement reçues, avec quantités restant à recevoir.',
    perms: ['purchases:view'], filters: ['period', 'supplierId', 'status'], statusOptions: [{ value: 'confirmed', label: 'Confirmées' }, { value: 'partially_received', label: 'Partiellement reçues' }],
    columns: [{ key: 'number', label: 'N°' }, { key: 'orderDate', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'expectedDate', label: 'Livraison prévue', type: 'date' }, { key: 'state', label: 'Statut' }, qty('ordered', 'Commandé'), qty('received', 'Reçu'), qty('remaining', 'Reste à recevoir'), money('ttcMinor', 'TTC')],
    async run(c) {
      const r = range(c.f); const st: ('confirmed' | 'partially_received')[] = c.f.status === 'confirmed' || c.f.status === 'partially_received' ? [c.f.status] : ['confirmed', 'partially_received'];
      const docs = await PurchaseOrder.find({ companyId: c.companyId, status: { $in: st }, ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }) }).sort({ orderDate: 1 }).limit(MAX_ROWS).lean();
      const rows: Row[] = docs.map((d) => { const ordered = d.lines.reduce((s, l) => s + l.quantity, 0); const received = d.lines.reduce((s, l) => s + (l.receivedQty ?? 0), 0);
        return { number: d.number, orderDate: d.orderDate, supplier: d.supplier?.name ?? '—', expectedDate: d.expectedDate ?? null, state: ORDER_LABEL[d.status], ordered, received, remaining: Math.max(0, ordered - received), ttcMinor: d.totals.totalTtcMinor ?? 0 }; });
      return { rows, totals: { number: 'Total', ordered: sum(rows, 'ordered'), received: sum(rows, 'received'), remaining: sum(rows, 'remaining'), ttcMinor: sum(rows, 'ttcMinor') }, kpis: [{ label: 'Commandes en attente', value: rows.length, type: 'int' }] };
    } },
  { key: 'partial-receipts', group: 'purchases', title: 'Réceptions partielles', description: 'Lignes de commande partiellement reçues : quantité commandée, reçue et restante.',
    perms: ['purchases:view'], filters: ['period', 'supplierId', 'productId'],
    columns: [{ key: 'number', label: 'Commande' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'designation', label: 'Article' }, qty('ordered', 'Commandé'), qty('received', 'Reçu'), qty('remaining', 'Reste'), { key: 'progressPct', label: 'Avancement', type: 'pct' }],
    async run(c) {
      const r = range(c.f); const docs = await PurchaseOrder.find({ companyId: c.companyId, status: { $in: ['confirmed', 'partially_received'] }, ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }) }).sort({ orderDate: 1 }).limit(MAX_ROWS).lean();
      const rows: Row[] = [];
      for (const d of docs) for (const l of d.lines) { const rec = l.receivedQty ?? 0; if (rec > 0 && rec < l.quantity && (!c.f.productId || String(l.productId) === c.f.productId)) rows.push({ number: d.number, supplier: d.supplier?.name ?? '—', designation: l.designation, ordered: l.quantity, received: rec, remaining: l.quantity - rec, progressPct: pct(rec, l.quantity) }); }
      return { rows, totals: { number: 'Total', ordered: sum(rows, 'ordered'), received: sum(rows, 'received'), remaining: sum(rows, 'remaining') } };
    } },
  { key: 'purchase-gaps', group: 'purchases', title: 'Écarts commande / réception / facture', description: 'Lignes de commande dont les quantités reçues ou facturées diffèrent de la commande ou de la réception.',
    perms: ['purchases:view'], filters: ['period', 'supplierId', 'productId'],
    columns: [{ key: 'number', label: 'Commande' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'designation', label: 'Article' }, qty('ordered', 'Commandé'), qty('received', 'Reçu'), qty('invoiced', 'Facturé'), qty('gapReceived', 'Écart reçu − commandé'), qty('gapInvoiced', 'Écart facturé − reçu')],
    async run(c) {
      const r = range(c.f); const docs = await PurchaseOrder.find({ companyId: c.companyId, status: { $in: ['confirmed', 'partially_received', 'received'] }, ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }) }).sort({ orderDate: -1 }).limit(MAX_ROWS).lean();
      const rows: Row[] = [];
      for (const d of docs) for (const l of d.lines) { const rec = l.receivedQty ?? 0; const inv = l.invoicedQty ?? 0; const e1 = rec - l.quantity; const e2 = inv - rec;
        if ((Math.abs(e1) > 1e-9 || Math.abs(e2) > 1e-9) && (!c.f.productId || String(l.productId) === c.f.productId)) rows.push({ number: d.number, supplier: d.supplier?.name ?? '—', designation: l.designation, ordered: l.quantity, received: rec, invoiced: inv, gapReceived: e1, gapInvoiced: e2 }); }
      return { rows, note: 'Un écart « reçu − commandé » négatif = reste à recevoir ; « facturé − reçu » négatif = reste à facturer.' };
    } },
  { key: 'purchase-price-variances', group: 'purchases', title: 'Écarts de prix (commande / facture)', description: 'Écarts de prix constatés à la validation des factures d’achat par rapport à la commande.',
    perms: ['purchases:view'], filters: ['period', 'supplierId'],
    columns: [{ key: 'number', label: 'Facture' }, { key: 'invoiceDate', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'message', label: 'Constat' }, money('orderPriceMinor', 'Prix commandé'), money('invoicePriceMinor', 'Prix facturé'), money('deltaMinor', 'Écart unitaire'), qty('invoiced', 'Qté facturée')],
    async run(c) {
      const docs = await PurchaseInvoice.find({ ...piMatch(c), 'variances.0': { $exists: true } }).sort({ invoiceDate: -1 }).limit(MAX_ROWS).lean(); const rows: Row[] = [];
      for (const d of docs) for (const v of d.variances ?? []) if (v.type === 'price') rows.push({ number: d.number, invoiceDate: d.invoiceDate, supplier: d.supplier?.name ?? '—', message: v.message ?? '', orderPriceMinor: v.orderPriceMinor ?? 0, invoicePriceMinor: v.invoicePriceMinor ?? 0, deltaMinor: (v.invoicePriceMinor ?? 0) - (v.orderPriceMinor ?? 0), invoiced: v.invoiced ?? 0 });
      return { rows, totals: { number: 'Total', deltaMinor: rows.reduce((s, x) => s + Number(x['deltaMinor']) * Number(x['invoiced']), 0) }, note: 'Le total valorise l’écart unitaire × quantité facturée.' };
    } },

  // ---- Importations ----
  { key: 'imports-by-period', group: 'imports', title: 'Importations par période', description: 'Dossiers d’importation (hors annulés) : valeur FOB, frais annexes et coût rendu en devise de base.',
    perms: ['imports:view'], filters: ['period', 'groupBy', 'supplierId', 'currency', 'status'], statusOptions: Object.entries(IMPORT_LABEL).filter(([k]) => k !== 'cancelled').map(([value, label]) => ({ value, label })),
    columns: [{ key: 'period', label: 'Période' }, { key: 'files', label: 'Dossiers', type: 'int' }, money('fobMinor', 'Valeur FOB'), money('chargesMinor', 'Frais annexes'), money('landedMinor', 'Coût rendu'), { key: 'coef', label: 'Coefficient', type: 'pct' }],
    async run(c) {
      const r = range(c.f); const m = { companyId: c.companyId, status: c.f.status ?? { $ne: 'cancelled' }, ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }), ...(c.f.currency && { currency: c.f.currency.toUpperCase() }) };
      const g = await ImportFile.aggregate<Record<string, number | string>>([{ $match: m }, { $group: { _id: bucketExpr(c.f.groupBy, 'orderDate'), files: { $sum: 1 }, fobMinor: { $sum: '$totals.fobBaseMinor' }, chargesMinor: { $sum: '$totals.chargesBaseMinor' }, landedMinor: { $sum: '$totals.landedMinor' } } }]);
      const rows: Row[] = fillPeriods(g.map(({ _id, ...x }) => ({ period: _id, ...x })), c.f.groupBy, c.f, { files: 0, fobMinor: 0, chargesMinor: 0, landedMinor: 0 }).map((x) => ({ ...x, coef: Number(x['fobMinor']) ? Math.round(Number(x['landedMinor']) / Number(x['fobMinor']) * 1000) / 10 : 0 }));
      return { rows, totals: { period: 'Total', files: sum(rows, 'files'), fobMinor: sum(rows, 'fobMinor'), chargesMinor: sum(rows, 'chargesMinor'), landedMinor: sum(rows, 'landedMinor') }, chart: { type: 'bar', valueType: 'money', series: [{ label: 'Coût rendu', points: rows.map((x) => ({ label: String(x['period']), value: Number(x['landedMinor']) })) }] },
        note: 'Coefficient = coût rendu ÷ valeur FOB (en %).' };
    } },
  { key: 'import-costs', group: 'imports', title: 'Coût des importations', description: 'Détail par dossier : valeur FOB, frais annexes, coût rendu et coefficient de revient.',
    perms: ['imports:view'], filters: ['period', 'supplierId', 'currency', 'status'], statusOptions: Object.entries(IMPORT_LABEL).map(([value, label]) => ({ value, label })),
    columns: [{ key: 'number', label: 'Dossier' }, { key: 'orderDate', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Fournisseur' }, { key: 'currency', label: 'Devise' }, { key: 'status', label: 'Statut' }, money('fobMinor', 'FOB'), money('chargesMinor', 'Frais'), money('landedMinor', 'Coût rendu'), { key: 'coef', label: 'Coefficient', type: 'pct' }],
    async run(c) {
      const r = range(c.f); const docs = await ImportFile.find({ companyId: c.companyId, ...(c.f.status && { status: c.f.status as 'draft' }), ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }), ...(c.f.currency && { currency: c.f.currency.toUpperCase() }) }).select('-lines -documents').sort({ orderDate: -1 }).limit(MAX_ROWS).lean();
      const rows: Row[] = docs.map((d) => ({ number: d.number, orderDate: d.orderDate, supplier: d.supplier?.name ?? '—', currency: d.currency, status: IMPORT_LABEL[d.status], fobMinor: d.totals?.fobBaseMinor ?? 0, chargesMinor: d.totals?.chargesBaseMinor ?? 0, landedMinor: d.totals?.landedMinor ?? 0,
        coef: d.totals?.fobBaseMinor ? Math.round((d.totals.landedMinor ?? 0) / d.totals.fobBaseMinor * 1000) / 10 : 0 }));
      return { rows, totals: { number: 'Total', fobMinor: sum(rows, 'fobMinor'), chargesMinor: sum(rows, 'chargesMinor'), landedMinor: sum(rows, 'landedMinor') } };
    } },
  { key: 'import-charges', group: 'imports', title: 'Répartition des frais d’importation', description: 'Frais annexes par nature (fret, douane, transit, assurance…) en devise de base.',
    perms: ['imports:view'], filters: ['period', 'supplierId', 'currency', 'status'], statusOptions: Object.entries(IMPORT_LABEL).filter(([k]) => k !== 'cancelled').map(([value, label]) => ({ value, label })),
    columns: [{ key: 'type', label: 'Nature' }, { key: 'count', label: 'Frais', type: 'int' }, money('amountMinor', 'Montant (devise de base)'), { key: 'sharePct', label: 'Part', type: 'pct' }],
    async run(c) {
      const r = range(c.f); const g = await ImportFile.aggregate<{ _id: string; count: number; amountMinor: number }>([{ $match: { companyId: c.companyId, status: c.f.status ?? { $ne: 'cancelled' }, ...(r && { orderDate: r }), ...(c.f.supplierId && { supplierId: oid(c.f.supplierId) }), ...(c.f.currency && { currency: c.f.currency.toUpperCase() }) } },
        { $unwind: '$charges' }, { $group: { _id: '$charges.type', count: { $sum: 1 }, amountMinor: { $sum: '$charges.amountBaseMinor' } } }, { $sort: { amountMinor: -1 } }]);
      const total = g.reduce((s, x) => s + x.amountMinor, 0); const rows: Row[] = g.map((x) => ({ type: CHARGE_LABEL[x._id] ?? x._id, count: x.count, amountMinor: x.amountMinor, sharePct: pct(x.amountMinor, total) }));
      return { rows, totals: { type: 'Total', count: sum(rows, 'count'), amountMinor: total }, chart: barChart('money', 'Frais', rows, 'type', 'amountMinor') };
    } },
  { key: 'exchange-rates', group: 'imports', title: 'Historique des taux de change', description: 'Taux de change enregistrés vers la devise de base.',
    perms: ['imports:view'], filters: ['period', 'currency'],
    columns: [{ key: 'currency', label: 'Devise' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'rate', label: 'Taux' }, { key: 'source', label: 'Source' }],
    async run(c) {
      const r = range(c.f); const docs = await ExchangeRate.find({ companyId: c.companyId, ...(r && { date: r }), ...(c.f.currency && { currency: c.f.currency.toUpperCase() }) }).sort({ currency: 1, date: -1 }).limit(MAX_ROWS).lean();
      const rows: Row[] = docs.map((d) => ({ currency: d.currency, date: d.date, rate: d.rate, source: d.source ?? '' })); const cur = [...new Set(docs.map((d) => d.currency))].slice(0, 4);
      return { rows, chart: { type: 'line', valueType: 'int', series: cur.map((k) => ({ label: k, points: docs.filter((d) => d.currency === k).reverse().map((d) => ({ label: d.date.toISOString().slice(0, 10), value: d.rate })) })) } };
    } },
];
