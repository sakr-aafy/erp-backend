import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, binaryParser, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { J, line, logisticsCompany, plusDays, quoteBody, stockIn, stockOut, today, type LCtx, acceptQuote, refuseQuote } from './sales.helpers.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Product } from '../src/models/product.model.js';
import { periods } from '../src/modules/reports/reports.dashboard.js';
import { bucketLabel, fillPeriods } from '../src/modules/reports/report.helpers.js';
import { REPORTS } from '../src/modules/reports/reports.registry.js';

let A: LCtx, B: LCtx; let cust2: string; let inv1: string, inv2: string, cn: string; let bank: string; let catId: string;
const RANGE = `from=${today()}&to=${today()}`;
const rep = async (c: LCtx, key: string, qs = '') => { const r = await c.j.get(`/reports/${key}?limit=200${qs ? '&' + qs : ''}`); expect(r.status, `${key}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200); return r.body; };
const mkInvoice = async (c: LCtx, lines: object[], customerId = c.customerId) => { const d = (await c.j.post('/invoices', { customerId, lines })).body; const v = await c.j.post(`/invoices/${d.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); return v.body as { id: string; number: string; totals: { totalHtMinor: number; totalTtcMinor: number; totalPayableMinor: number } }; };

beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test');
  cust2 = (await A.j.post('/customers', { name: 'Client Deux', taxId: 'C2-1' })).body.id;
  catId = (await A.j.post('/product-categories', { name: 'Machines' })).body.id;
  await Product.updateOne({ _id: A.products.b13 }, { costPriceMinor: 30_000 }); await Product.updateOne({ _id: A.products.a19 }, { categoryId: catId });
  // Ventes : inv1 = 1 × A19 (HT 100 000, TVA 19 000) ; inv2 = 2 × A19 + 2 × B13 (HT 300 000 ; TVA 38 000 + 13 000) ; avoir total de inv1 ; encaissement partiel de inv2
  bank = (await A.j.post('/treasury/accounts', { code: 'BNK', name: 'Banque', type: 'bank', openingBalanceMinor: 1_000_000 })).body.id;
  const i1 = await mkInvoice(A, [line(A.products.a19, 1)]); inv1 = i1.id; const i2 = await mkInvoice(A, [line(A.products.a19, 2), line(A.products.b13, 2)], cust2); inv2 = i2.id;
  const c = await A.j.post(`/invoices/${inv1}/credit-note`, { reason: 'Retour' }); cn = c.body.id; expect((await A.j.post(`/invoices/${cn}/validate`)).status).toBe(200);
  expect((await A.j.post(`/invoices/${inv2}/payments`, { amountMinor: 40_000, method: 'transfer', treasuryAccountId: bank })).status).toBe(201);
  // Devis : accepté + converti en facture, refusé, en attente
  const q1 = (await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1)]))).body; await acceptQuote(A.j, q1.id); const pro = (await A.j.post(`/quotations/${q1.id}/convert-proforma`)).body; expect((await A.j.post(`/proformas/${pro.proformaId}/convert-invoice`)).status).toBe(201);
  const q2 = (await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1)]))).body; await refuseQuote(A.j, q2.id); await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1)]));
  // Stock : +10 à 1 000, −4 ; réception partielle d'une commande (6 sur 10 à 10 000) ; seuil minimum ; transfert
  await stockIn(A, A.products.a19, 10, 1_000); await stockOut(A, A.products.a19, 4);
  const po = (await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId: A.products.a19, quantity: 10, unitPriceMinor: 10_000 }] })).body; await A.j.post(`/purchase-orders/${po.id}/confirm`);
  const rc = await A.j.post('/goods-receipts', { purchaseOrderId: po.id, warehouseId: A.w1, lines: [{ orderLineId: po.lines[0].id, quantity: 6 }] }); await A.j.post(`/goods-receipts/${rc.body.id}/validate`);
  const pi = (await A.j.post('/purchase-invoices', { supplierId: A.supplierId, purchaseOrderId: po.id, supplierInvoiceNumber: 'FRN-1', lines: [{ orderLineId: po.lines[0].id, productId: A.products.a19, quantity: 6, unitPriceMinor: 10_500 }] })).body; expect((await A.j.post(`/purchase-invoices/${pi.id}/validate`)).status).toBe(200);
  expect((await A.j.post('/supplier-payments', { supplierId: A.supplierId, treasuryAccountId: bank, method: 'transfer', allocations: [{ purchaseInvoiceId: pi.id, amountMinor: 20_000 }] })).status).toBe(201);
  const t = (await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: A.products.a19, quantity: 2 }] })).body; expect((await A.j.post(`/stock-transfers/${t.id}/validate`)).status).toBe(200);
  const inv = (await A.j.post('/inventories', { warehouseId: A.w2 })).body; await A.j.put(`/inventories/${inv.id}`, { reason: 'Casse', lines: inv.lines.map((l: { productId: string }) => ({ productId: l.productId, countedQty: l.productId === A.products.a19 ? 1 : 0 })) });
  await A.j.post(`/inventories/${inv.id}/validate`);
  // Dépenses (validation par le créateur autorisée pour ce test) ; importation
  await A.j.put('/accounting/settings', { allowExpenseSelfValidation: true }); const ec = (await A.j.post('/expense-categories', { name: 'Loyer' })).body.id;
  const e = (await A.j.post('/expenses', { categoryId: ec, amountMinor: 25_000, date: today(), beneficiary: 'Bailleur', method: 'transfer', treasuryAccountId: bank })).body; await A.j.post(`/expenses/${e.id}/submit`); expect((await A.j.post(`/expenses/${e.id}/validate`)).status).toBe(200);
  await A.j.post('/exchange-rates', { currency: 'EUR', date: '2020-01-01', rate: 3.4 });
  const imp = (await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', lines: [{ productId: A.products.b13, quantity: 10, unitPriceMinor: 10_000 }] })).body;
  await A.j.post(`/imports/${imp.id}/charges`, { type: 'freight', amountMinor: 5_000, currency: 'EUR' }); await A.j.post(`/imports/${imp.id}/charges`, { type: 'insurance', amountMinor: 1_000, currency: 'EUR' });
  await A.j.post(`/imports/${imp.id}/status`, { status: 'ordered' }); expect((await A.j.post(`/imports/${imp.id}/close`)).status).toBe(200);
  // Société B : une facture, pour vérifier l'isolation
  await mkInvoice(B, [line(B.products.a19, 3)]);
});
afterAll(teardownDb);

describe('registre et catalogue', () => {
  it('toutes les clés sont uniques et chaque rapport déclare ses colonnes, filtres et permissions', () => {
    expect(new Set(REPORTS.map((r) => r.key)).size).toBe(REPORTS.length); expect(REPORTS.length).toBeGreaterThanOrEqual(30);
    for (const r of REPORTS) { expect(r.columns.length, r.key).toBeGreaterThan(0); expect(r.perms.length, r.key).toBeGreaterThan(0); expect(r.perms.every((p) => /^[a-zA-Z]+:(view|create|update|validate|delete)$/.test(p)), r.key).toBe(true); }
  });
  it('catalogue complet pour l’administrateur, groupé par domaine', async () => {
    const c = (await A.j.get('/reports/catalog')).body as { group: string; reports: { key: string }[] }[]; expect(c.map((g) => g.group)).toEqual(['commercial', 'financial', 'stock', 'purchases', 'imports']);
    expect(c.flatMap((g) => g.reports).length).toBe(REPORTS.length);
  });
  it('tous les rapports s’exécutent sans erreur (avec et sans filtre) et renvoient une structure cohérente', async () => {
    for (const r of REPORTS) for (const qs of ['', RANGE]) {
      const b = await rep(A, r.key, qs); expect(b.columns.map((c: { key: string }) => c.key), r.key).toEqual(r.columns.map((c) => c.key)); expect(Array.isArray(b.rows), r.key).toBe(true); expect(b.total, r.key).toBe(b.rows.length === 0 ? 0 : b.total);
      if (b.chart) for (const s of b.chart.series) expect(s.points.every((p: { label: string; value: number }) => Number.isFinite(p.value)), r.key).toBe(true);
    }
  });
});

describe('rapports commerciaux — chiffres exacts', () => {
  it('ventes par période : factures − avoirs, HT/TVA/TTC ; égal à /invoices/summary', async () => {
    const b = await rep(A, 'sales-by-period', `${RANGE}&groupBy=month`); expect(b.totals).toMatchObject({ invoices: 2, creditNotes: 1 });
    const s = (await A.j.get('/invoices/summary')).body; expect(b.totals.htMinor).toBe(s.revenueHtMinor); expect(b.totals.ttcMinor).toBe(s.revenueTtcMinor); expect(b.totals.vatMinor).toBe(s.vatCollectedMinor);
  });
  it('seuls les documents VALIDÉS comptent : le brouillon issu du devis converti est exclu', async () => {
    const b = await rep(A, 'sales-by-period', `${RANGE}&groupBy=month`); expect(b.totals.invoices).toBe(2); expect(b.totals.htMinor).toBe(100_000 + 300_000 - 100_000);
  });
  it('périodes : jour / semaine / trimestre / année — libellés cohérents et comblement des périodes vides', async () => {
    const d = await rep(A, 'sales-by-period', `from=${plusDays(-3)}&to=${today()}&groupBy=day`); expect(d.rows).toHaveLength(4); expect(d.rows[0].htMinor).toBe(0); expect(d.rows[3].htMinor).toBe(300_000);
    for (const g of ['week', 'quarter', 'year']) { const b = await rep(A, 'sales-by-period', `${RANGE}&groupBy=${g}`); expect(b.rows).toHaveLength(1); expect(b.rows[0].period).toBe(bucketLabel(new Date(`${today()}T00:00:00Z`), g as never)); expect(b.rows[0].htMinor).toBe(300_000); }
  });
  it('un filtre de dates hors période ne renvoie rien ; to < from refusé (422) ; paramètre inconnu refusé', async () => {
    expect((await rep(A, 'sales-by-period', `from=${plusDays(-20)}&to=${plusDays(-10)}`)).totals.htMinor).toBe(0);
    expect((await A.j.get(`/reports/sales-by-period?from=${today()}&to=${plusDays(-1)}`)).status).toBe(422); expect((await A.j.get('/reports/sales-by-period?foo=1')).status).toBe(422); expect((await A.j.get('/reports/sales-by-period?customerId=xyz')).status).toBe(422);
  });
  it('ventes par client : filtre client, encaissé et reste dû', async () => {
    const b = await rep(A, 'sales-by-customer', RANGE); const c1 = b.rows.find((r: { customer: string }) => r.customer === 'Client Test'); const c2 = b.rows.find((r: { customer: string }) => r.customer === 'Client Deux');
    expect(c1).toMatchObject({ invoices: 1, creditNotes: 1, htMinor: 0 }); expect(c2).toMatchObject({ invoices: 1, htMinor: 300_000, paidMinor: 40_000, dueMinor: 311_000 });
    const f = await rep(A, 'sales-by-customer', `${RANGE}&customerId=${cust2}`); expect(f.rows).toHaveLength(1); expect(f.totals.htMinor).toBe(300_000);
  });
  it('ventes par produit : quantités, HT net de remise, marge estimée au CMP ; somme = ventes par période', async () => {
    const b = await rep(A, 'sales-by-product', RANGE); const a = b.rows.find((r: { reference: string }) => r.reference === 'A19'); const x = b.rows.find((r: { reference: string }) => r.reference === 'B13');
    const cost = (await Product.findById(A.products.a19))!.costPriceMinor!; expect(cost).toBeGreaterThan(0); expect(a).toMatchObject({ qty: 2, htMinor: 200_000, costMinor: 2 * cost, marginMinor: 200_000 - 2 * cost }); expect(x).toMatchObject({ qty: 2, htMinor: 100_000, costMinor: 60_000, marginMinor: 40_000 });
    expect(b.totals.htMinor).toBe(300_000); expect((await rep(A, 'sales-by-product', `${RANGE}&productId=${A.products.b13}`)).rows).toHaveLength(1);
  });
  it('ventes par catégorie : regroupement, part du CA et filtre catégorie', async () => {
    const b = await rep(A, 'sales-by-category', RANGE); expect(b.rows.find((r: { category: string }) => r.category === 'Machines')).toMatchObject({ htMinor: 200_000, sharePct: 66.7 }); expect(b.rows.find((r: { category: string }) => r.category === 'Sans catégorie').htMinor).toBe(100_000);
    expect((await rep(A, 'sales-by-category', `${RANGE}&categoryId=${catId}`)).rows).toHaveLength(1);
  });
  it('ventes par utilisateur : créateur des documents', async () => {
    const b = await rep(A, 'sales-by-user', RANGE); expect(b.rows).toHaveLength(1); expect(b.rows[0]).toMatchObject({ invoices: 2, creditNotes: 1, htMinor: 300_000 });
  });
  it('devis : statuts, taux d’acceptation et de transformation', async () => {
    const b = await rep(A, 'quotations', RANGE); expect(b.totals.count).toBe(3); const n = (s: string) => b.rows.find((r: { statusKey: string }) => r.statusKey === s).count; expect([n('draft'), n('sent'), n('accepted'), n('refused'), n('expired'), n('cancelled')]).toEqual([1, 0, 1, 1, 0, 0]);
    const k = Object.fromEntries(b.kpis.map((x: { label: string; value: number }) => [x.label, x.value])); expect(k['Taux d’acceptation']).toBe(50); expect(k['Devis transformés (proforma ou facture)']).toBe(1); expect(k['Taux de transformation']).toBeCloseTo(33.3, 1);
    expect((await rep(A, 'quotations', `${RANGE}&status=refused`)).totals.count).toBe(1);
  });
  it('état des règlements : payée (avoir), partielle ; reste dû = encours', async () => {
    const b = await rep(A, 'invoices-status', RANGE); const s = (k: string) => b.rows.find((r: { statusKey: string }) => r.statusKey === k);
    expect(s('paid')).toMatchObject({ count: 1 }); expect(s('partial')).toMatchObject({ count: 1, payableMinor: 351_000, paidMinor: 40_000, dueMinor: 311_000, overdueMinor: 0 }); expect(s('unpaid').count).toBe(0);
    expect((await rep(A, 'invoices-status', `${RANGE}&status=partial`)).rows).toHaveLength(1);
  });
  it('avoirs : liste avec facture d’origine', async () => {
    const b = await rep(A, 'credit-notes', RANGE); expect(b.rows).toHaveLength(1); expect(b.rows[0]).toMatchObject({ htMinor: 100_000, ttcMinor: 119_000, reason: 'Retour' }); expect(b.rows[0].invoiceNumber).toMatch(/^FAC-/);
  });
});

describe('rapports financiers', () => {
  it('créances : total = solde client = tableau de bord ; ancienneté par échéance', async () => {
    const b = await rep(A, 'receivables-aging', ''); expect(b.totals.totalMinor).toBe(311_000); expect(b.totals.notDue).toBe(311_000); expect(b.rows).toHaveLength(1);
    const late = await rep(A, 'receivables-aging', `asOf=${plusDays(80)}`); expect(late.totals.d31_60 + late.totals.d61_90 + late.totals.d1_30).toBe(311_000);
    expect((await rep(A, 'receivables-aging', `customerId=${A.customerId}`)).rows).toHaveLength(0);
  });
  it('dettes fournisseurs : facture d’achat 6 × 10 500 TTC − règlement', async () => {
    const b = await rep(A, 'payables-aging', ''); const ttc = (await A.j.get('/purchase-invoices?limit=5')).body.items[0].totals.totalTtcMinor; expect(b.totals.totalMinor).toBe(ttc - 20_000);
  });
  it('encaissements : période et modes de règlement', async () => {
    const b = await rep(A, 'receipts', RANGE); expect(b.totals).toMatchObject({ count: 1, amountMinor: 40_000 }); expect(b.kpis).toEqual([{ label: 'Virement', value: 40_000, type: 'money' }]); expect((await rep(A, 'receipts', `${RANGE}&status=cancelled`)).totals.count).toBe(0);
  });
  it('décaissements : règlements fournisseurs + dépenses validées', async () => {
    const b = await rep(A, 'disbursements', RANGE); expect(b.totals).toMatchObject({ supplierMinor: 20_000, expensesMinor: 25_000, totalMinor: 45_000 });
  });
  it('dépenses par catégorie : montant et part', async () => {
    const b = await rep(A, 'expenses-by-category', RANGE); expect(b.rows).toEqual([expect.objectContaining({ category: 'Loyer', count: 1, totalMinor: 25_000, sharePct: 100 })]);
  });
  it('trésorerie par compte : ouverture + entrées − sorties = solde du compte', async () => {
    const b = await rep(A, 'treasury-by-account', RANGE); const acc = (await A.j.get('/treasury/accounts')).body[0]; expect(b.rows[0]).toMatchObject({ openingMinor: 1_000_000, inMinor: 40_000, outMinor: 45_000, closingMinor: acc.balanceMinor }); expect(acc.balanceMinor).toBe(995_000);
    const later = await rep(A, 'treasury-by-account', `from=${plusDays(1)}`); expect(later.rows[0]).toMatchObject({ openingMinor: 995_000, inMinor: 0, outMinor: 0 });
  });
  it('flux : entrées, sorties, net cumulé', async () => {
    const b = await rep(A, 'cashflow', `${RANGE}&groupBy=day`); expect(b.rows[0]).toMatchObject({ inMinor: 40_000, outMinor: 45_000, netMinor: -5_000, cumulMinor: -5_000 }); expect(b.chart.series.map((s: { label: string }) => s.label)).toEqual(['Entrées', 'Sorties']);
  });
});

describe('rapports stock', () => {
  it('stock par magasin : quantité, valeur et CMP ; somme = valorisation du module Stock', async () => {
    const b = await rep(A, 'stock-by-warehouse', `productId=${A.products.a19}`); const v = (await A.j.get('/stock/valuation')).body; const all = await rep(A, 'stock-by-warehouse');
    expect(all.totals.valueMinor).toBe(v.totalValueMinor); const w1 = b.rows.find((r: { warehouse: string }) => r.warehouse.startsWith('WH1')); expect(w1.qty).toBe(6 + 6 - 2); expect(w1.valueMinor).toBe(6_000 + 60_000 - Math.round((66_000 / 12) * 2));
    expect((await rep(A, 'stock-by-warehouse', `warehouseId=${A.w2}`)).rows.every((r: { warehouse: string }) => r.warehouse.startsWith('WH2'))).toBe(true);
  });
  it('valeur par catégorie et mouvements entrées / sorties', async () => {
    const b = await rep(A, 'stock-valuation', ''); expect(b.rows.find((r: { category: string }) => r.category === 'Machines')).toBeTruthy(); const m = await rep(A, 'stock-movements', `${RANGE}&groupBy=day&productId=${A.products.a19}`);
    expect(m.totals.inQty).toBeGreaterThanOrEqual(16); expect(m.totals.outQty).toBeGreaterThanOrEqual(6); expect(m.totals.inValueMinor - m.totals.outValueMinor).toBe(m.totals.netValueMinor);
  });
  it('sous le seuil et ruptures', async () => {
    await Product.updateOne({ _id: A.products.a19 }, { minStock: 100 }); const low = await rep(A, 'stock-low', ''); expect(low.rows.find((r: { reference: string }) => r.reference === 'A19')).toMatchObject({ minStock: 100, missing: 100 - 11 });
    const out = await rep(A, 'stock-out', ''); expect(out.rows.some((r: { reference: string }) => r.reference === 'B13')).toBe(true); expect(out.rows.some((r: { reference: string }) => r.reference === 'A19')).toBe(false);
  });
  it('transferts et inventaires validés', async () => {
    const t = await rep(A, 'transfers', RANGE); expect(t.rows[0]).toMatchObject({ from: 'WH1', to: 'WH2', qty: 2 }); expect(t.rows[0].valueMinor).toBeGreaterThan(0);
    const i = await rep(A, 'inventories', RANGE); expect(i.rows).toHaveLength(1); expect(i.rows[0]).toMatchObject({ warehouse: 'WH2', reason: 'Casse' });
  });
  it('historique de valorisation : changements de coût liés aux réceptions', async () => {
    const b = await rep(A, 'valuation-history', `productId=${A.products.a19}`); expect(b.rows.length).toBeGreaterThan(0); expect(b.rows.every((r: { deltaMinor: number; newCostMinor: number; previousCostMinor: number }) => r.deltaMinor === r.newCostMinor - r.previousCostMinor)).toBe(true); expect(b.chart).toBeTruthy();
  });
});

describe('rapports achats et importations', () => {
  it('achats par fournisseur / période / factures', async () => {
    const s = await rep(A, 'purchases-by-supplier', RANGE); expect(s.rows).toHaveLength(1); expect(s.rows[0]).toMatchObject({ invoices: 1, htMinor: 63_000, paidMinor: 20_000 }); expect(s.rows[0].dueMinor).toBe(s.rows[0].ttcMinor - 20_000);
    const p = await rep(A, 'purchases-by-period', `${RANGE}&groupBy=month`); expect(p.totals.htMinor).toBe(63_000); const l = await rep(A, 'purchase-invoices', RANGE); expect(l.rows[0]).toMatchObject({ supplierInvoiceNumber: 'FRN-1', state: 'Partiellement réglée' });
    expect((await rep(A, 'purchases-by-supplier', `${RANGE}&status=paid`)).rows).toHaveLength(0); expect((await rep(A, 'purchases-by-supplier', `${RANGE}&supplierId=${A.foreignSupplierId}`)).rows).toHaveLength(0);
  });
  it('commandes en attente, réceptions partielles, écarts', async () => {
    const o = await rep(A, 'orders-pending', ''); expect(o.rows[0]).toMatchObject({ ordered: 10, received: 6, remaining: 4, state: 'Partiellement reçue' });
    const r = await rep(A, 'partial-receipts', ''); expect(r.rows[0]).toMatchObject({ ordered: 10, received: 6, remaining: 4, progressPct: 60 });
    const g = await rep(A, 'purchase-gaps', ''); expect(g.rows[0]).toMatchObject({ gapReceived: -4, gapInvoiced: 0 });
    const v = await rep(A, 'purchase-price-variances', ''); expect(v.rows[0]).toMatchObject({ orderPriceMinor: 10_000, invoicePriceMinor: 10_500, deltaMinor: 500 });
  });
  it('importations : coût rendu, frais annexes, répartition, taux de change', async () => {
    const imp = (await A.j.get('/imports?limit=1')).body.items[0]; const d = (await A.j.get(`/imports/${imp.id}`)).body;
    const b = await rep(A, 'import-costs', ''); expect(b.rows[0]).toMatchObject({ currency: 'EUR', fobMinor: d.totals.fobBaseMinor, chargesMinor: d.totals.chargesBaseMinor, landedMinor: d.totals.landedMinor }); expect(d.totals.landedMinor).toBe(d.totals.fobBaseMinor + d.totals.chargesBaseMinor);
    const c = await rep(A, 'import-charges', ''); expect(c.rows.map((r: { type: string }) => r.type).sort()).toEqual(['Assurance', 'Fret']); expect(c.totals.amountMinor).toBe(d.totals.chargesBaseMinor); expect(c.rows.reduce((s: number, r: { sharePct: number }) => s + r.sharePct, 0)).toBeCloseTo(100, 0);
    const p = await rep(A, 'imports-by-period', `${RANGE}&groupBy=month`); expect(p.totals).toMatchObject({ files: 1, landedMinor: d.totals.landedMinor }); expect((await rep(A, 'imports-by-period', `${RANGE}&currency=USD`)).totals.files).toBe(0);
    const x = await rep(A, 'exchange-rates', 'currency=EUR'); expect(x.rows[0]).toMatchObject({ currency: 'EUR', rate: 3.4 });
  });
});

describe('tableau de bord', () => {
  it('KPI du mois cohérents avec les rapports ; comparaison avec la période précédente', async () => {
    const d = (await A.j.get('/reports/dashboard')).body; expect(d.sales.revenueHt).toMatchObject({ current: 300_000, previous: 0, deltaPct: null }); expect(d.sales.invoices.current).toBe(2); expect(d.sales.receivablesMinor).toBe(311_000);
    expect(d.sales.unpaid).toMatchObject({ count: 1, dueMinor: 311_000, overdueMinor: 0 }); expect(d.sales.series.current.reduce((s: number, p: { value: number }) => s + p.value, 0)).toBe(300_000); expect(d.sales.series.previous.length).toBe(d.sales.series.current.length);
    expect(d.sales.topCustomers[0]).toMatchObject({ name: 'Client Deux', htMinor: 300_000 }); const ca = (await Product.findById(A.products.a19))!.costPriceMinor!; expect(d.margin.amount.current).toBe(300_000 - 2 * ca - 60_000); expect(d.expenses.total.current).toBe(25_000); expect(d.treasury.totalMinor).toBe(995_000);
    expect(d.purchases.purchasesHt.current).toBe(63_000); expect(d.purchases.pendingOrders).toBe(1); expect(d.stock.valueMinor).toBeGreaterThan(0); expect(d.stock.outCount).toBeGreaterThanOrEqual(1); expect(d.activity.length).toBeGreaterThan(0);
  });
  it('période personnalisée : la période précédente a la même durée et la variation est calculée', async () => {
    const p = periods(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-31T00:00:00Z')); expect(p.days).toBe(31); expect(p.prevFrom.toISOString().slice(0, 10)).toBe('2026-01-29'); expect(p.prevTo.toISOString().slice(0, 10)).toBe('2026-02-28'); expect(p.granularity).toBe('day');
    expect(periods(new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z')).granularity).toBe('month');
    const d = (await A.j.get(`/reports/dashboard?from=${plusDays(-9)}&to=${plusDays(-1)}`)).body; expect(d.sales.revenueHt.current).toBe(0); expect(d.sales.series.current).toHaveLength(9);
    expect((await A.j.get(`/reports/dashboard?from=${today()}&to=${plusDays(-3)}`)).status).toBe(422);
  });
  it('comblement des périodes vides : mois sans donnée à zéro, ordre chronologique', () => {
    const rows = fillPeriods([{ period: '2026-03', v: 5 }], 'month', { from: new Date('2026-01-15T00:00:00Z'), to: new Date('2026-04-02T00:00:00Z') }, { v: 0 }); expect(rows.map((r) => r['period'])).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']); expect(rows[2]!['v']).toBe(5);
    expect(bucketLabel(new Date('2026-01-01T00:00:00Z'), 'week')).toBe('2026-S01'); expect(bucketLabel(new Date('2025-12-29T00:00:00Z'), 'week')).toBe('2026-S01'); expect(bucketLabel(new Date('2026-05-10T00:00:00Z'), 'quarter')).toBe('2026-T2');
  });
});

describe('permissions, isolation et exports', () => {
  it('chaque rapport exige reports:view ET les permissions de ses modules ; le catalogue est filtré côté serveur', async () => {
    await makeUser(A.companyId, 'sales@a.test', ['reports:view', 'invoices:view']); const s = J((await login('sales@a.test')).token);
    const cat = (await s.get('/reports/catalog')).body as { group: string; reports: { key: string }[] }[]; expect(cat.map((g) => g.group)).toEqual(['commercial', 'financial']); const keys = cat.flatMap((g) => g.reports.map((r) => r.key)); expect(cat[1]!.reports.map((r) => r.key)).toEqual(['receipts']); // encaissements = règlements de factures (invoices:view)
    expect(keys).toContain('sales-by-period'); expect(keys).not.toContain('sales-by-user'); expect(keys).not.toContain('quotations'); expect(keys).not.toContain('receivables-aging');
    expect((await s.get('/reports/sales-by-period')).status).toBe(200); for (const k of ['receivables-aging', 'stock-by-warehouse', 'purchases-by-supplier', 'import-costs', 'treasury-by-account', 'quotations', 'sales-by-user']) expect((await s.get(`/reports/${k}`)).status, k).toBe(403);
    expect((await request(app).get('/api/v1/reports/stock-by-warehouse/export?format=csv').set(authed((await login('sales@a.test')).token))).status).toBe(403);
    await makeUser(A.companyId, 'norep@a.test', ['invoices:view', 'inventory:view']); const n = J((await login('norep@a.test')).token); expect((await n.get('/reports/catalog')).status).toBe(403); expect((await n.get('/reports/sales-by-period')).status).toBe(403);
    expect((await J('x').get('/reports/catalog')).status).toBe(401); expect((await A.j.get('/reports/inconnu')).status).toBe(404);
  });
  it('tableau de bord : seuls les blocs autorisés sont calculés et renvoyés (jamais « à zéro »)', async () => {
    const s = J((await login('sales@a.test')).token); const d = (await s.get('/reports/dashboard')).body; expect(Object.keys(d).sort()).toEqual(['generatedAt', 'period', 'sales']); expect(d.margin).toBeUndefined();
    await makeUser(A.companyId, 'fin@a.test', ['treasury:view', 'expenses:view', 'audit:view']); const f = (await J((await login('fin@a.test')).token).get('/reports/dashboard')).body; expect(Object.keys(f).sort()).toEqual(['activity', 'expenses', 'generatedAt', 'period', 'treasury']);
    await makeUser(A.companyId, 'none@a.test', ['customers:view']); expect(Object.keys((await J((await login('none@a.test')).token).get('/reports/dashboard')).body).sort()).toEqual(['generatedAt', 'period']);
    await makeUser(A.companyId, 'margin@a.test', ['invoices:view', 'costCalculation:view']); expect((await J((await login('margin@a.test')).token).get('/reports/dashboard')).body.margin).toBeTruthy();
  });
  it('isolation multi-société : B ne voit jamais les données de A, dans aucun rapport ni le tableau de bord', async () => {
    const b = await rep(B, 'sales-by-period', RANGE); expect(b.totals.htMinor).toBe(300_000); expect(b.totals.invoices).toBe(1);
    for (const k of ['sales-by-customer', 'sales-by-product', 'receivables-aging', 'expenses-by-category', 'treasury-by-account', 'stock-by-warehouse', 'purchases-by-supplier', 'import-costs', 'orders-pending', 'credit-notes', 'exchange-rates']) { const r = await rep(B, k); expect(JSON.stringify(r.rows), k).not.toMatch(/Client Deux|Loyer|FRN-1|Banque|Machines/); }
    const dB = (await B.j.get('/reports/dashboard')).body; expect(dB.sales.revenueHt.current).toBe(300_000); expect(dB.expenses.total.current).toBe(0); expect(dB.treasury.accounts).toEqual([]);
    expect((await B.j.get(`/reports/sales-by-customer?customerId=${cust2}`)).body.rows).toEqual([]); // identifiant d'une autre société : aucun résultat, aucune fuite
  });
  it('export xlsx : colonnes, montants en unités principales, ligne de total, filtres respectés ; audit', async () => {
    const x = await request(app).get(`/api/v1/reports/sales-by-customer/export?format=xlsx&${RANGE}&customerId=${cust2}`).set(authed(A.token)).buffer().parse(binaryParser); expect(x.status).toBe(200); expect(x.headers['content-disposition']).toMatch(/sales-by-customer/);
    const rows = await parseXlsx(x.body as Buffer); expect(rows[0]).toEqual(['Client', 'Factures', 'Avoirs', 'CA HT', 'CA TTC', 'Encaissé', 'Reste dû']); expect(rows[1]![0]).toBe('Client Deux'); expect(rows[1]![3]).toBe('300'); expect(rows.at(-1)![0]).toBe('Total'); expect(rows).toHaveLength(3);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'report', action: 'export' })).toBeGreaterThanOrEqual(1);
  });
  it('export csv et pdf ; CSV protégé contre l’injection de formules', async () => {
    const c = await request(app).get(`/api/v1/reports/credit-notes/export?format=csv&${RANGE}`).set(authed(A.token)).buffer().parse(binaryParser); expect(c.status).toBe(200); expect(c.headers['content-type']).toMatch(/text\/csv/); expect((c.body as Buffer).toString()).toMatch(/N° avoir/);
    const p = await request(app).get('/api/v1/reports/sales-by-period/export?format=pdf').set(authed(A.token)).buffer().parse(binaryParser); expect(p.status).toBe(200); expect((p.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await A.j.get('/reports/sales-by-period/export?format=docx')).status).toBe(422);
  });
  it('pagination côté serveur : page, limite et total', async () => {
    const all = await A.j.get('/reports/stock-valuation?limit=1&page=1'); expect(all.body.rows).toHaveLength(1); expect(all.body.total).toBeGreaterThanOrEqual(1); expect((await A.j.get('/reports/sales-by-period?limit=500')).status).toBe(422); expect((await A.j.get('/reports/sales-by-period?page=0')).status).toBe(422);
  });
  it('les filtres non déclarés par un rapport sont ignorés (pas de résultat faussé silencieux)', async () => {
    const withF = await rep(A, 'sales-by-period', `${RANGE}&warehouseId=${A.w1}&reason=receipt`); const without = await rep(A, 'sales-by-period', RANGE); expect(withF.totals).toEqual(without.totals);
  });
});
