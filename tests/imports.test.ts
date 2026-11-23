import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, setupDb, teardownDb } from './helpers.js';
import { J, logisticsCompany, levelOf, costOf, plusDays, api, type LCtx } from './sales.helpers.js';
import { computeImport, toBaseMinor } from '../src/modules/imports/import.calc.js';
import { CostHistory, GoodsReceipt, StockMovement } from '../src/models/logistics.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Product } from '../src/models/product.model.js';

let A: LCtx, B: LCtx; let P: string, Q: string;
beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); P = A.products.a19; Q = A.products.b13;
  await A.j.post('/exchange-rates', { currency: 'EUR', date: '2020-01-01', rate: 3.4 });
});
afterAll(async () => { fs.rmSync(path.resolve(process.cwd(), 'uploads', String(A.companyId)), { recursive: true, force: true }); await teardownDb(); });

const dossier = async (c: LCtx, lines = [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }], extra: object = {}) => {
  const r = await c.j.post('/imports', { supplierId: c.foreignSupplierId, currency: 'EUR', lines, ...extra }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body;
};

describe('conversion de devises et répartition (calcul pur)', () => {
  it('toBaseMinor : taux, décimales différentes (EUR 2 → TND 3), arrondi', () => {
    expect(toBaseMinor(10_000, 3.4, 2, 3)).toBe(340_000);       // 100,00 € × 3,4 = 340,000 DT
    expect(toBaseMinor(10_000, 3.4567, 2, 3)).toBe(345_670);
    expect(toBaseMinor(1, 3.4567, 2, 3)).toBe(35);               // 0,01 € = 0,034567 → 0,035
    expect(toBaseMinor(12_345, 1, 3, 3)).toBe(12_345);
    expect(toBaseMinor(2_500, 1.5, 3, 2)).toBe(375);              // 2,500 → 3,75 (devise de base à 2 décimales)
    expect(() => toBaseMinor(1, 0, 2, 3)).toThrow();
  });
  it('répartition des frais : par valeur ou par quantité, somme exacte, coût rendu par ligne', () => {
    const lines = [{ quantity: 10, unitPriceMinor: 10_000 }, { quantity: 30, unitPriceMinor: 10_000 }]; // FOB 3 400 000 et 10 200 000 (taux 3,4)
    const r = computeImport(lines, [{ id: 'f', amountBaseMinor: 40_001, allocation: 'value', type: 'freight' }, { id: 'a', amountBaseMinor: 1_001, allocation: 'quantity', type: 'insurance' }], 3.4, 2, 3);
    expect(r.lines.map((l) => l.fobBaseMinor)).toEqual([3_400_000, 10_200_000]);
    expect(r.lines[0]!.shares['f']! + r.lines[1]!.shares['f']!).toBe(40_001); expect(r.lines[0]!.shares['a']! + r.lines[1]!.shares['a']!).toBe(1_001);
    expect(r.lines[0]!.shares['f']).toBe(10_000); expect(r.lines[0]!.shares['a']).toBe(250); // 1/4 de la valeur, 1/4 des quantités
    expect(r.totals).toEqual({ fobBaseMinor: 13_600_000, chargesBaseMinor: 41_002, landedMinor: 13_641_002 }); expect(r.byType).toEqual({ freight: 40_001, insurance: 1_001 });
    expect(r.lines.reduce((s, l) => s + l.landedTotalMinor, 0)).toBe(13_641_002);
  });
});

describe('dossier d’importation', () => {
  it('création : fournisseur étranger obligatoire, devise configurée, taux du jour résolu automatiquement, FOB converti', async () => {
    const d = await dossier(A);
    expect(d).toMatchObject({ number: expect.stringMatching(/^IMP-\d{4}-000001$/), status: 'draft', currency: 'EUR', exchangeRate: 3.4 }); expect(d.lines[0]).toMatchObject({ fobBaseMinor: 3_400_000, landedTotalMinor: 3_400_000, unitLandedMinor: 340_000 });
    expect(d.totals).toEqual({ fobBaseMinor: 3_400_000, chargesBaseMinor: 0, landedMinor: 3_400_000 });
    const bad = async (b: object, st: number) => expect((await A.j.post('/imports', { lines: [{ productId: P, quantity: 1, unitPriceMinor: 100 }], ...b } as never)).status, JSON.stringify(b)).toBe(st);
    await bad({ supplierId: A.supplierId, currency: 'EUR' }, 400);            // fournisseur local
    await bad({ supplierId: A.foreignSupplierId, currency: 'GBP' }, 400);       // devise non configurée
    await bad({ supplierId: A.foreignSupplierId, currency: 'EUR', orderDate: '2019-01-01' }, 400); // aucun taux à cette date
    await bad({ supplierId: B.foreignSupplierId, currency: 'EUR' }, 400);       // fournisseur d'une autre société
    await bad({ supplierId: A.foreignSupplierId, currency: 'EUR', lines: [{ productId: A.products.svc, quantity: 1, unitPriceMinor: 1 }] }, 400); // service
    expect((await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', exchangeRate: 3.5, orderDate: '2019-01-01', lines: [{ productId: P, quantity: 1, unitPriceMinor: 1000 }] })).status).toBe(201); // taux saisi
  });
  it('taux de change : dernier taux ≤ date de l’opération ; mise à jour par date ; pas de taux pour la devise de base', async () => {
    await A.j.post('/exchange-rates', { currency: 'EUR', date: '2024-06-01', rate: 3.35 });
    expect((await A.j.get('/exchange-rates/resolve?currency=EUR&date=2024-05-31')).body.rate).toBe(3.4); expect((await A.j.get('/exchange-rates/resolve?currency=EUR&date=2024-06-01')).body.rate).toBe(3.35);
    expect((await A.j.post('/exchange-rates', { currency: 'TND', date: '2024-06-01', rate: 1 })).status).toBe(400); expect((await A.j.post('/exchange-rates', { currency: 'JPY', date: '2024-06-01', rate: 1 })).status).toBe(400);
    expect((await A.j.get('/exchange-rates/resolve?currency=TND')).body.rate).toBe(1); expect((await A.j.get('/exchange-rates?currency=EUR')).body.length).toBe(2);
    const d = await dossier(A, undefined, { orderDate: '2024-07-01' }); expect(d.exchangeRate).toBe(3.35); expect(d.lines[0].fobBaseMinor).toBe(3_350_000);
  });
  it('frais annexes : conversion au taux du jour du frais, répartition, RECALCUL AUTOMATIQUE à chaque ajout / modification / suppression', async () => {
    const d = await dossier(A, [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }, { productId: Q, quantity: 30, unitPriceMinor: 10_000 }]); // FOB 3 350 000 + 10 050 000 (taux du jour 3,35)
    const f = (await A.j.post(`/imports/${d.id}/charges`, { type: 'freight', label: 'Fret maritime', amountMinor: 20_000, date: '2024-07-01' })).body; // 200,00 € à 3,35
    const fr = f.charges[0]; expect(fr).toMatchObject({ currency: 'EUR', exchangeRate: 3.35, amountBaseMinor: 670_000 }); expect(f.totals).toMatchObject({ chargesBaseMinor: 670_000, landedMinor: 13_400_000 + 670_000 });
    expect(f.lines.map((l: { allocatedChargesMinor: number }) => l.allocatedChargesMinor)).toEqual([167_500, 502_500]); // par valeur
    const c = (await A.j.post(`/imports/${d.id}/charges`, { type: 'customs_duty', amountMinor: 150_000, currency: 'TND' })).body; // 150,000 DT, taux 1
    expect(c.charges[1]).toMatchObject({ exchangeRate: 1, amountBaseMinor: 150_000 }); expect(c.totals.chargesBaseMinor).toBe(820_000);
    const ins = (await A.j.post(`/imports/${d.id}/charges`, { type: 'insurance', amountMinor: 1_000, allocation: 'quantity', exchangeRate: 3.5, date: plusDays(0) })).body; // taux saisi 3,5
    expect(ins.charges[2].amountBaseMinor).toBe(35_000); expect(ins.lines[0].allocatedChargesMinor).toBe(167_500 + 37_500 + 8_750); // frais fixes + parts de douane/assurance
    expect(ins.lines.reduce((s: number, l: { landedTotalMinor: number }) => s + l.landedTotalMinor, 0)).toBe(ins.totals.landedMinor); expect(ins.totals.landedMinor).toBe(13_400_000 + 670_000 + 150_000 + 35_000);
    const upd = (await A.j.put(`/imports/${d.id}/charges/${fr.id}`, { type: 'freight', amountMinor: 10_000, date: '2024-07-01' })).body; expect(upd.totals.chargesBaseMinor).toBe(335_000 + 150_000 + 35_000); // recalcul après modification
    const del = (await A.j.del(`/imports/${d.id}/charges/${c.charges[1].id}`)).body; expect(del.totals.chargesBaseMinor).toBe(335_000 + 35_000); expect(del.charges).toHaveLength(2); // recalcul après suppression
    const sheet = (await A.j.get(`/imports/${d.id}/cost-sheet`)).body; expect(sheet.byType).toEqual({ freight: 335_000, insurance: 35_000 }); expect(sheet.totals.landedMinor).toBe(del.totals.landedMinor);
    expect(sheet.lines[0].coefficient).toBeGreaterThan(1); expect((await A.j.post(`/imports/${d.id}/charges`, { type: 'other', amountMinor: 1, currency: 'GBP' })).status).toBe(400);
    expect(await AuditLog.countDocuments({ resource: 'import-file', action: 'add-charge' })).toBeGreaterThanOrEqual(3);
  });
  it('cycle de vie : transitions ordonnées, lignes figées après commande, clôture = frais figés ; annulation limitée', async () => {
    const d = await dossier(A); const st = (s: string) => A.j.post(`/imports/${d.id}/status`, { status: s });
    expect((await st('shipped')).status).toBe(409); // saut d'étape
    for (const s of ['ordered', 'shipped', 'customs', 'arrived']) expect((await st(s)).body.status).toBe(s);
    expect((await A.j.put(`/imports/${d.id}`, { supplierId: A.foreignSupplierId, currency: 'EUR', lines: [{ productId: P, quantity: 99, unitPriceMinor: 1 }] })).status).toBe(409);
    expect((await A.j.post(`/imports/${d.id}/charges`, { type: 'transit', amountMinor: 5_000 })).status).toBe(201);
    const closed = await A.j.post(`/imports/${d.id}/close`); expect(closed.status).toBe(200); expect(closed.body).toMatchObject({ status: 'closed', chargesOpen: false });
    expect((await A.j.post(`/imports/${d.id}/charges`, { type: 'other', amountMinor: 1 })).status).toBe(409); expect((await A.j.put(`/imports/${d.id}/charges/${closed.body.charges[0].id}`, { type: 'transit', amountMinor: 1 })).status).toBe(409);
    expect((await A.j.del(`/imports/${d.id}/charges/${closed.body.charges[0].id}`)).status).toBe(409); expect((await st('cancelled')).status).toBe(409); expect((await A.j.post(`/imports/${d.id}/close`)).status).toBe(409);
    const d2 = await dossier(A); expect((await A.j.post(`/imports/${d2.id}/close`)).status).toBe(409); // brouillon : pas de clôture
    expect((await A.j.post(`/imports/${d2.id}/status`, { status: 'cancelled', reason: 'Fournisseur défaillant' })).body.status).toBe('cancelled');
    const d3 = await dossier(A); expect((await A.j.del(`/imports/${d3.id}`)).status).toBe(204);
  });
  it('intégration au stock : exige la clôture ; entrée au COÛT RENDU ; coût de revient (CMP) et historique ; non rejouable', async () => {
    const d = await dossier(A, [{ productId: P, quantity: 10, unitPriceMinor: 10_000 }]); // FOB 3 350 000
    await A.j.post(`/imports/${d.id}/charges`, { type: 'freight', amountMinor: 10_000, date: '2024-07-01' });  // 335 000
    await A.j.post(`/imports/${d.id}/charges`, { type: 'customs_duty', amountMinor: 125_000, currency: 'TND' }); // 125 000
    for (const s of ['ordered', 'shipped', 'customs', 'arrived']) await A.j.post(`/imports/${d.id}/status`, { status: s });
    expect((await A.j.post(`/imports/${d.id}/integrate`, { warehouseId: A.w1 })).status).toBe(409); // pas clôturé
    const closed = (await A.j.post(`/imports/${d.id}/close`)).body; expect(closed.totals.landedMinor).toBe(3_350_000 + 335_000 + 125_000); expect(closed.lines[0].unitLandedMinor).toBe(381_000);
    const before = await levelOf(A, P); const ok = await A.j.post(`/imports/${d.id}/integrate`, { warehouseId: A.w1 }); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'integrated', warehouseId: A.w1 }); const l = await levelOf(A, P); expect(l.qty - before.qty).toBe(10); expect(l.value - before.value).toBe(3_810_000);
    const m = (await StockMovement.findOne({ 'source.type': 'goodsReceipt', reason: 'import' }).sort({ createdAt: -1 }))!; expect(m).toMatchObject({ direction: 'in', quantity: 10, valueMinor: 3_810_000 });
    const rc = (await GoodsReceipt.findById(ok.body.receiptId))!; expect(rc).toMatchObject({ status: 'validated' }); expect(String(rc.importFileId)).toBe(d.id);
    const h = (await CostHistory.findOne({ productId: P, reason: 'import_integration' }).sort({ at: -1 }))!; expect(h).toMatchObject({ purchaseUnitCostMinor: 335_000, extraUnitCostMinor: 46_000 }); expect(h.source!.number).toBe(rc.number);
    const stockNow = await levelOf(A, P); expect(await costOf(P)).toBe(Math.round(stockNow.value / stockNow.qty));
    expect((await A.j.post(`/imports/${d.id}/integrate`, { warehouseId: A.w1 })).status).toBe(409); expect(await StockMovement.countDocuments({ 'source.id': ok.body.receiptId })).toBe(1);
    expect((await A.j.post(`/imports/${d.id}/charges`, { type: 'other', amountMinor: 1 })).status).toBe(409); expect((await A.j.del(`/imports/${d.id}`)).status).toBe(409);
  });
  it('articles à numéro de série : séries obligatoires à l’intégration (échec = dossier inchangé)', async () => {
    const d = await dossier(A, [{ productId: A.serialProduct, quantity: 2, unitPriceMinor: 20_000 }]); for (const s of ['ordered', 'arrived'].slice(0, 1)) await A.j.post(`/imports/${d.id}/status`, { status: s });
    await A.j.post(`/imports/${d.id}/close`); const lineId = d.lines[0].id;
    const bad = await A.j.post(`/imports/${d.id}/integrate`, { warehouseId: A.w1 }); expect(bad.status).toBe(400); expect((await A.j.get(`/imports/${d.id}`)).body.status).toBe('closed');
    expect((await A.j.post(`/imports/${d.id}/integrate`, { warehouseId: A.w1, serials: { [lineId]: ['IMP-S1', 'IMP-S2'] } })).status).toBe(200); expect(await levelOf(A, A.serialProduct)).toMatchObject({ qty: 2 });
  });
});

describe('documents d’importation', () => {
  it('suivi documentaire + fichiers : types contrôlés, contenu vérifié, stockage sécurisé, téléchargement protégé', async () => {
    const d = await dossier(A); const doc = (await A.j.post(`/imports/${d.id}/documents`, { name: 'Connaissement', kind: 'bill_of_lading' })).body.documents[0]; expect(doc).toMatchObject({ status: 'pending', hasFile: false });
    const up = (name: string, buf: Buffer) => api().post(`/api/v1/imports/${d.id}/documents/${doc.id}/file`).set('Authorization', `Bearer ${A.token}`).attach('file', buf, name);
    expect((await up('virus.exe', Buffer.from('MZ....'))).status).toBe(400); expect((await up('faux.pdf', Buffer.from('pas un pdf'))).status).toBe(400); expect((await up('gros.pdf', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(11 * 1024 * 1024)]))).status).toBe(413);
    const ok = await up('../../etc/Connaissement BL.pdf', Buffer.from('%PDF-1.4 contenu')); expect(ok.status).toBe(201);
    expect(ok.body.documents[0]).toMatchObject({ status: 'received', hasFile: true, fileName: 'Connaissement BL.pdf' }); // chemin neutralisé
    const stored = fs.readdirSync(path.resolve(process.cwd(), 'uploads', String(A.companyId))); expect(stored).toHaveLength(1); expect(stored[0]).toMatch(/^[0-9a-f]{32}\.pdf$/); // nom aléatoire
    const dl = await api().get(`/api/v1/imports/${d.id}/documents/${doc.id}/file`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    expect(dl.status).toBe(200); expect((dl.body as Buffer).toString()).toBe('%PDF-1.4 contenu'); expect(dl.headers['content-disposition']).toMatch(/attachment/); expect(dl.headers['x-content-type-options']).toBe('nosniff');
    await makeUser(A.companyId, 'nodl@a.test', ['imports:create']); expect((await J((await login('nodl@a.test')).token).get(`/imports/${d.id}/documents/${doc.id}/file`)).status).toBe(403);
    expect((await B.j.get(`/imports/${d.id}/documents/${doc.id}/file`)).status).toBe(404);
    expect((await api().get(`/api/v1/imports/${d.id}/documents/${doc.id}/file`)).status).toBe(401);
  });
});

describe('coût de revient', () => {
  it('fiche : coût actuel (CMP), marge, stock valorisé, historique ; simulation de marge sans écriture', async () => {
    const s = (await A.j.get(`/costs/products/${P}`)).body; const cmp = Math.round(s.stock.valueMinor / s.stock.qty);
    expect(s).toMatchObject({ reference: 'A19', costPriceMinor: cmp, effectiveCostMinor: cmp, salePriceMinor: 100_000 }); expect(s.marginMinor).toBe(100_000 - cmp); expect(s.history.length).toBeGreaterThan(0); expect(s.stock.cmpMinor).toBe(cmp);
    const sim = await A.j.post('/costs/simulate', { purchasePriceMinor: 10_000, extraCostsMinor: 2_000, salePriceMinor: 15_000, targetMarginPct: 30 });
    expect(sim.body).toEqual({ costMinor: 12_000, saleMinor: 15_000, marginMinor: 3_000, marginRatePct: 25, markPct: 20, belowCost: false, minSalePriceForTargetMinor: 15_600 });
    expect((await A.j.post('/costs/simulate', { purchasePriceMinor: 10_000, salePriceMinor: 9_000 })).body.belowCost).toBe(true);
    expect((await A.j.post('/costs/simulate', { productId: P, extraCostsMinor: 5_000 })).body.costMinor).toBe(cmp + 5_000); expect((await A.j.post('/costs/simulate', {})).status).toBe(400);
  });
  it('recalcul justifié : CMP recalculé depuis le stock, historisé avec sa justification et son auteur', async () => {
    const before = await costOf(P);
    await Product.updateOne({ _id: P }, { costPriceMinor: 1 }); // dérive volontaire
    expect((await A.j.post(`/costs/products/${P}/recalculate`, { justification: 'court' })).status).toBe(422);
    const r = await A.j.post(`/costs/products/${P}/recalculate`, { justification: 'Correction après contrôle de la valorisation' }); expect(r.status).toBe(200); expect(r.body).toMatchObject({ changed: true, previousCostMinor: 1, costPriceMinor: before });
    const h = (await A.j.get(`/costs/products/${P}/history`)).body; expect(h.items[0]).toMatchObject({ reason: 'manual_recalculation', previousCostMinor: 1, newCostMinor: before, justification: 'Correction après contrôle de la valorisation' });
    expect((await A.j.post(`/costs/products/${P}/recalculate`, { justification: 'Nouveau contrôle sans écart' })).body.changed).toBe(false); // rien à historiser
    expect((await A.j.post(`/costs/products/${A.products.c7}/recalculate`, { justification: 'Article sans stock valorisé' })).status).toBe(409);
    expect(await AuditLog.countDocuments({ action: 'recalculate-cost' })).toBeGreaterThan(0);
  });
  it('rapport par article et par catégorie ; l’alerte « vente sous le coût » utilise le coût de revient du stock', async () => {
    const cat = (await A.j.post('/product-categories', { name: 'Machines' })).body.id; await A.j.put(`/products/${P}`, { reference: 'A19', name: 'Article A19', unitId: A.unitId, vatRateCode: 'T19', purchasePriceMinor: 1_000, salePriceMinor: 100_000, categoryId: cat });
    const r = (await A.j.get(`/costs/report?categoryId=${cat}`)).body; expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ reference: 'A19', category: 'Machines' }); expect(r.byCategory[0]).toMatchObject({ category: 'Machines', count: 1 });
    const all = (await A.j.get('/costs/report')).body; expect(all.total).toBeGreaterThan(1); expect(all.byCategory.map((c: { category: string }) => c.category)).toContain('Sans catégorie');
    const up = await A.j.put(`/products/${P}`, { salePriceMinor: 50_000 }); expect(up.body.belowCost).toBe(true); expect(up.body.effectiveCostMinor).toBe(await costOf(P));
    expect((await A.j.get('/costs/report?belowCost=true')).body.items.map((i: { reference: string }) => i.reference)).toContain('A19');
    expect((await B.j.get(`/costs/products/${P}`)).status).toBe(404); expect((await B.j.post(`/costs/products/${B.products.a19}/recalculate`, { justification: 'Sans stock valorisé ici' })).status).toBe(409);
  });
  it('permissions : consultation / recalcul séparés', async () => {
    await makeUser(A.companyId, 'cv@a.test', ['costCalculation:view']); const u = J((await login('cv@a.test')).token);
    expect((await u.get(`/costs/products/${P}`)).status).toBe(200); expect((await u.post(`/costs/products/${P}/recalculate`, { justification: 'Tentative non autorisée' })).status).toBe(403);
  });
});
