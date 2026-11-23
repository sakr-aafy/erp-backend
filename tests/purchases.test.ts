import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeUser, setupDb, teardownDb } from './helpers.js';
import { J, logisticsCompany, levelOf, costOf, line, plusDays, type LCtx } from './sales.helpers.js';
import { CostHistory, GoodsReceipt, PurchaseOrder } from '../src/models/logistics.model.js';
import { Supplier } from '../src/models/supplier.model.js';
import { Counter } from '../src/models/counter.model.js';
import { ProductSerial } from '../src/models/product.model.js';

let A: LCtx, B: LCtx; let P: string;
const Y = new Date().getUTCFullYear();
beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); P = A.products.a19; });
afterAll(teardownDb);

const order = async (c: LCtx, lines: object[], extra: object = {}) => (await c.j.post('/purchase-orders', { supplierId: c.supplierId, lines, ...extra })).body;
const confirmed = async (c: LCtx, lines: object[]) => { const o = await order(c, lines); const r = await c.j.post(`/purchase-orders/${o.id}/confirm`); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
const receipt = (c: LCtx, o: { id: string; lines: { id: string }[] }, qtys: number[], extra: object = {}) =>
  c.j.post('/goods-receipts', { purchaseOrderId: o.id, warehouseId: c.w1, lines: qtys.map((q, i) => ({ orderLineId: o.lines[i]!.id, quantity: q })).filter((l) => l.quantity > 0), ...extra });

describe('commandes d’achat', () => {
  it('création : numéro BC-AAAA-000001, prix d’achat et TVA de l’article par défaut, totaux calculés par le serveur', async () => {
    const o = await order(A, [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }, { productId: A.products.b13, quantity: 2 }]);
    expect(o).toMatchObject({ number: `BC-${Y}-000001`, status: 'draft', editable: true });
    expect(o.lines[1]).toMatchObject({ unitPriceMinor: 1_000, vat: { code: 'T13', ratePct: 13 } }); // prix d'achat de la fiche article, TVA de l'article
    expect(o.totals).toMatchObject({ totalHtMinor: 102_000, totalVatMinor: 19_000 + 260, totalTtcMinor: 121_260 });
    expect((await order(B, [{ productId: B.products.a19, quantity: 1 }])).number).toBe(`BC-${Y}-000001`); // série propre à chaque société
  });
  it('refuse : fournisseur étranger (→ importation), ligne sans TVA, article/fournisseur d’une autre société, quantité nulle', async () => {
    const bad = async (b: object, st: number) => expect((await A.j.post('/purchase-orders', b as never)).status, JSON.stringify(b)).toBe(st);
    await bad({ supplierId: A.foreignSupplierId, lines: [{ productId: P, quantity: 1 }] }, 400);
    await bad({ supplierId: A.supplierId, lines: [{ designation: 'Libre', quantity: 1, unitPriceMinor: 100 }] }, 400);
    await bad({ supplierId: B.supplierId, lines: [{ productId: P, quantity: 1 }] }, 400);
    await bad({ supplierId: A.supplierId, lines: [{ productId: B.products.a19, quantity: 1 }] }, 400);
    await bad({ supplierId: A.supplierId, lines: [{ productId: P, quantity: 0 }] }, 422);
    await bad({ supplierId: A.supplierId, lines: [{ productId: P, quantity: 1 }], number: 'BC-X' }, 422);
  });
  it('modification et suppression : brouillon seulement ; confirmation contrôle le blocage fournisseur', async () => {
    const o = await order(A, [{ productId: P, quantity: 1, unitPriceMinor: 1_000 }]);
    expect((await A.j.put(`/purchase-orders/${o.id}`, { supplierId: A.supplierId, lines: [{ productId: P, quantity: 3, unitPriceMinor: 1_000 }] })).body.totals.totalHtMinor).toBe(3_000);
    await Supplier.updateOne({ _id: A.supplierId }, { balanceMinor: 5_000, blockThresholdMinor: 1_000 });
    const blocked = await A.j.post(`/purchase-orders/${o.id}/confirm`); expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('SUPPLIER_BLOCKED');
    await Supplier.updateOne({ _id: A.supplierId }, { balanceMinor: 0, $unset: { blockThresholdMinor: 1 } });
    expect((await A.j.post(`/purchase-orders/${o.id}/confirm`)).body.status).toBe('confirmed');
    expect((await A.j.put(`/purchase-orders/${o.id}`, { supplierId: A.supplierId, lines: [{ productId: P, quantity: 1 }] })).status).toBe(409); expect((await A.j.del(`/purchase-orders/${o.id}`)).status).toBe(409);
    expect((await A.j.post(`/purchase-orders/${o.id}/confirm`)).status).toBe(409);
    expect((await A.j.post(`/purchase-orders/${o.id}/cancel`, { reason: 'Commande erronée' })).body.status).toBe('cancelled');
    expect((await A.j.post(`/purchase-orders/${o.id}/cancel`, { reason: 'Encore' })).status).toBe(409);
  });
});

describe('réceptions partielles et complètes → stock', () => {
  it('réception partielle puis complète : stock au coût de la commande, statuts, coût de revient et historique', async () => {
    const o = await confirmed(A, [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }]); // net 100 000
    const r1 = (await receipt(A, o, [6])).body; expect(r1.number).toMatch(new RegExp(`^REC-${Y}-`)); expect(await levelOf(A, P)).toEqual({ qty: 0, value: 0 }); // brouillon : pas de stock
    const v1 = await A.j.post(`/goods-receipts/${r1.id}/validate`); expect(v1.status, JSON.stringify(v1.body)).toBe(200);
    expect(await levelOf(A, P)).toEqual({ qty: 6, value: 60_000 }); expect((await A.j.get(`/purchase-orders/${o.id}`)).body).toMatchObject({ status: 'partially_received' });
    expect((await A.j.get(`/purchase-orders/${o.id}`)).body.lines[0]).toMatchObject({ receivedQty: 6, remainingQty: 4 }); expect(await costOf(P)).toBe(10_000);
    expect((await receipt(A, o, [5])).status).toBe(409); // > reste à recevoir
    const r2 = (await receipt(A, o, [4])).body; await A.j.post(`/goods-receipts/${r2.id}/validate`);
    expect((await A.j.get(`/purchase-orders/${o.id}`)).body.status).toBe('received'); expect(await levelOf(A, P)).toEqual({ qty: 10, value: 100_000 });
    expect((await receipt(A, o, [1])).status).toBe(409); // commande soldée
    const h = await CostHistory.find({ productId: P, reason: 'goods_receipt' }).sort({ at: -1 }); expect(h[0]).toMatchObject({ newCostMinor: 10_000, purchaseUnitCostMinor: 10_000, extraUnitCostMinor: 0 }); expect(h[0]!.source!.number).toBe(r1.number);
    expect((await A.j.post(`/goods-receipts/${r1.id}/validate`)).status).toBe(409); expect((await A.j.put(`/goods-receipts/${r1.id}`, { purchaseOrderId: o.id, warehouseId: A.w1, lines: [] })).status).toBe(422);
    expect((await A.j.del(`/goods-receipts/${r1.id}`)).status).toBe(409);
  });
  it('valeur reçue : la somme des réceptions égale exactement le net de la commande (pas de dérive d’arrondi)', async () => {
    await A.j.post('/stock/reconcile'); const before = await levelOf(A, A.products.c7);
    const o = await confirmed(A, [{ productId: A.products.c7, quantity: 7, unitPriceMinor: 14_286 }]); // net 100 002
    for (const q of [2, 2, 3]) { const r = (await receipt(A, o, [q])).body; expect((await A.j.post(`/goods-receipts/${r.id}/validate`)).status).toBe(200); }
    const l = await levelOf(A, A.products.c7); expect(l.qty - before.qty).toBe(7); expect(l.value - before.value).toBe(100_002);
    expect((await PurchaseOrder.findById(o.id))!.lines[0]!.receivedValueMinor).toBe(100_002);
  });
  it('CMP : une seconde entrée à un autre prix recalcule le coût de revient', async () => {
    const o = await confirmed(A, [{ productId: A.products.b13, quantity: 10, unitPriceMinor: 2_000 }]); const r = (await receipt(A, o, [10])).body; await A.j.post(`/goods-receipts/${r.id}/validate`);
    const o2 = await confirmed(A, [{ productId: A.products.b13, quantity: 10, unitPriceMinor: 4_000 }]); const r2 = (await receipt(A, o2, [10])).body; await A.j.post(`/goods-receipts/${r2.id}/validate`);
    expect(await costOf(A.products.b13)).toBe(3_000); expect(await levelOf(A, A.products.b13)).toEqual({ qty: 20, value: 60_000 });
  });
  it('échec d’une ligne (séries manquantes) : validation annulée EN ENTIER (commande, stock, historique inchangés)', async () => {
    const o = await confirmed(A, [{ productId: A.serialProduct, quantity: 2, unitPriceMinor: 50_000 }]);
    const r = (await receipt(A, o, [2])).body; const f = await A.j.post(`/goods-receipts/${r.id}/validate`); expect(f.status).toBe(400); expect(f.body.error.message).toMatch(/numéro\(s\) de série/);
    expect((await PurchaseOrder.findById(o.id))!.lines[0]!.receivedQty).toBe(0); expect((await GoodsReceipt.findById(r.id))!.status).toBe('draft'); expect(await levelOf(A, A.serialProduct)).toEqual({ qty: 0, value: 0 });
    const ok = (await receipt(A, o, [2], { lines: [{ orderLineId: o.lines[0].id, quantity: 2, serials: ['R-1', 'R-2'] }] })).body; expect((await A.j.post(`/goods-receipts/${ok.id}/validate`)).status).toBe(200);
    expect((await ProductSerial.find({ productId: A.serialProduct, status: 'available' })).map((s) => s.serialNumber).sort()).toEqual(['R-1', 'R-2']);
  });
  it('deux réceptions brouillons validées en même temps : jamais plus que la quantité commandée', async () => {
    const o = await confirmed(A, [{ productId: P, quantity: 10, unitPriceMinor: 1_000 }]); const a = (await receipt(A, o, [6])).body; const b = (await receipt(A, o, [6])).body;
    const rs = await Promise.all([A.j.post(`/goods-receipts/${a.id}/validate`), A.j.post(`/goods-receipts/${b.id}/validate`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]); expect((await PurchaseOrder.findById(o.id))!.lines[0]!.receivedQty).toBe(6);
  });
  it('annulation d’une commande : refusée après réception validée ; brouillons de réception supprimés sinon', async () => {
    const o = await confirmed(A, [{ productId: P, quantity: 4, unitPriceMinor: 1_000 }]); const r = (await receipt(A, o, [2])).body;
    expect((await A.j.post(`/purchase-orders/${o.id}/cancel`, { reason: 'Plus nécessaire' })).status).toBe(200); expect(await GoodsReceipt.exists({ _id: r.id })).toBeNull();
    const o2 = await confirmed(A, [{ productId: P, quantity: 4, unitPriceMinor: 1_000 }]); const r2 = (await receipt(A, o2, [2])).body; await A.j.post(`/goods-receipts/${r2.id}/validate`);
    expect((await A.j.post(`/purchase-orders/${o2.id}/cancel`, { reason: 'Trop tard' })).status).toBe(409);
  });
});

describe('factures d’achat et rapprochement', () => {
  it('on ne facture pas plus que reçu ; écart de prix consigné ; solde fournisseur ; numéro FA- ; doublon refusé', async () => {
    const o = await confirmed(A, [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }]); const r = (await receipt(A, o, [6])).body; await A.j.post(`/goods-receipts/${r.id}/validate`);
    const draft = (await A.j.get(`/purchase-invoices/from-order/${o.id}`)).body; expect(draft.lines[0]).toMatchObject({ quantity: 6, unitPriceMinor: 10_000 });
    const over = (await A.j.post('/purchase-invoices', { ...draft, supplierInvoiceNumber: 'F-OVER', lines: [{ ...draft.lines[0], quantity: 7 }] })).body;
    const rOver = await A.j.post(`/purchase-invoices/${over.id}/validate`); expect(rOver.status).toBe(409); expect(rOver.body.error.message).toMatch(/reçu/);
    const inv = (await A.j.post('/purchase-invoices', { ...draft, supplierInvoiceNumber: 'F-001', lines: [{ ...draft.lines[0], unitPriceMinor: 10_500 }] })).body; // prix facturé ≠ prix commandé
    expect(inv.totals.totalHtMinor).toBe(63_000); const bal0 = (await Supplier.findById(A.supplierId))!.balanceMinor ?? 0;
    const v = await A.j.post(`/purchase-invoices/${inv.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.number).toMatch(new RegExp(`^FA-${Y}-`)); expect(v.body.variances).toEqual([expect.objectContaining({ type: 'price', orderPriceMinor: 10_000, invoicePriceMinor: 10_500 })]);
    expect((await Supplier.findById(A.supplierId))!.balanceMinor).toBe(bal0 + v.body.totals.totalTtcMinor);
    expect((await A.j.post('/purchase-invoices', { ...draft, supplierInvoiceNumber: 'F-001' })).status).toBe(409); // même n° fournisseur
    expect((await A.j.put(`/purchase-invoices/${inv.id}`, { ...draft, supplierInvoiceNumber: 'F-002' })).status).toBe(409); expect((await A.j.del(`/purchase-invoices/${inv.id}`)).status).toBe(409);
    const rec = (await A.j.get(`/purchase-orders/${o.id}/reconciliation`)).body; expect(rec.lines[0]).toMatchObject({ ordered: 10, received: 6, invoiced: 6, missing: 4, receivedNotInvoiced: 0 }); expect(rec.lines[0].flags).toEqual(expect.arrayContaining(['Reçu < commandé', 'Écart de prix']));
    expect(rec.lines[0].priceDiffMinor).toBe(3_000);
    // le reste (4) n'est pas encore reçu : impossible de le facturer
    expect((await A.j.get(`/purchase-invoices/from-order/${o.id}`)).body.lines).toEqual([]);
  });
  it('facturation partielle cumulée ≤ reçu ; réception supplémentaire ouvre de nouveau le droit à facturer', async () => {
    const o = await confirmed(A, [{ productId: P, quantity: 5, unitPriceMinor: 2_000 }]); const r = (await receipt(A, o, [5])).body; await A.j.post(`/goods-receipts/${r.id}/validate`);
    for (const [n, q, st] of [['G-1', 3, 200], ['G-2', 3, 409], ['G-3', 2, 200]] as [string, number, number][]) {
      const d = (await A.j.post('/purchase-invoices', { supplierId: A.supplierId, purchaseOrderId: o.id, supplierInvoiceNumber: n, lines: [{ orderLineId: o.lines[0].id, productId: P, quantity: q, unitPriceMinor: 2_000 }] })).body;
      expect((await A.j.post(`/purchase-invoices/${d.id}/validate`)).status, n).toBe(st);
    }
    expect((await A.j.get(`/purchase-orders/${o.id}/reconciliation`)).body.lines[0]).toMatchObject({ invoiced: 5, receivedNotInvoiced: 0 });
    expect((await A.j.post('/purchase-invoices', { supplierId: A.supplierId, purchaseOrderId: o.id, supplierInvoiceNumber: 'G-4', lines: [{ productId: P, quantity: 1, unitPriceMinor: 2_000 }] })).status).toBe(400); // ligne sans orderLineId
  });
  it('facture sans commande : possible ; le compteur FA ne saute pas de numéro sur échec', async () => {
    const d = (await A.j.post('/purchase-invoices', { supplierId: A.supplierId, supplierInvoiceNumber: 'LIBRE-1', lines: [{ designation: 'Prestation', quantity: 1, unitPriceMinor: 5_000, vatCode: 'T19' }] })).body;
    const seq = (await Counter.findOne({ companyId: A.companyId, key: `purchaseInvoice:${Y}` }))!.seq; expect((await A.j.post(`/purchase-invoices/${d.id}/validate`)).status).toBe(200);
    expect((await Counter.findOne({ companyId: A.companyId, key: `purchaseInvoice:${Y}` }))!.seq).toBe(seq + 1);
  });
});

describe('permissions et isolation', () => {
  it('consulter / créer / modifier / valider / supprimer séparés ; autre société sans accès', async () => {
    const mk = async (e: string, p: string[]) => { await makeUser(A.companyId, e, p); return J((await login(e)).token); };
    const view = await mk('pv@a.test', ['purchases:view']); const create = await mk('pc@a.test', ['purchases:create']); const val = await mk('pval@a.test', ['purchases:validate']);
    const body = { supplierId: A.supplierId, lines: [{ productId: P, quantity: 1, unitPriceMinor: 1_000 }] };
    expect((await view.get('/purchase-orders')).status).toBe(200); expect((await view.post('/purchase-orders', body)).status).toBe(403);
    const o = (await create.post('/purchase-orders', body)).body; expect(o.id).toBeTruthy(); expect((await create.get('/purchase-orders')).status).toBe(403);
    expect((await create.post(`/purchase-orders/${o.id}/confirm`)).status).toBe(403); expect((await val.post(`/purchase-orders/${o.id}/confirm`)).status).toBe(200);
    expect((await view.del(`/purchase-orders/${o.id}`)).status).toBe(403);
    for (const url of [`/purchase-orders/${o.id}`, `/purchase-orders/${o.id}/reconciliation`]) expect((await B.j.get(url)).status).toBe(404);
    expect((await B.j.post('/goods-receipts', { purchaseOrderId: o.id, warehouseId: B.w1, lines: [{ orderLineId: o.lines[0].id, quantity: 1 }] })).status).toBe(400);
    expect((await A.j.del(`/suppliers/${A.supplierId}`)).status).toBe(409); void line; void plusDays;
  });
});
