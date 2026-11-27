import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app, authed, binaryParser, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { J, line, logisticsCompany, plusDays, stockIn, type LCtx } from './sales.helpers.js';
import { ExchangeRate } from '../src/models/logistics.model.js';
import { Product, ProductActivity, ProductDocument, ProductStockSetting } from '../src/models/product.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { migrateProducts } from '../src/modules/products/product.migration.js';
import { margins, packagingProblems, ttcOf, volumeM3 } from '../src/modules/products/product.pricing.js';

let A: LCtx, B: LCtx;
const api = () => request(app);
const patch = (token: string, url: string, body: object) => api().patch(`/api/v1${url}`).set(authed(token)).send(body);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 2)]);
const upload = (token: string, id: string, file: Buffer, name: string, type = 'datasheet') => api().post(`/api/v1/products/${id}/documents`).set(authed(token)).field('type', type).attach('file', file, name);
const prod = (extra: object = {}) => ({ reference: `X-${Math.random().toString(36).slice(2, 8)}`, name: 'Machine de test', unitId: A.unitId, vatRateCode: 'T19', salePriceMinor: 100_000, purchasePriceMinor: 60_000, ...extra });
let id = ''; let ref = '';

beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); await ExchangeRate.create({ companyId: A.companyId, currency: 'EUR', date: new Date('2026-01-01T00:00:00Z'), rate: 3.4, source: 'test' }); });
afterAll(async () => { await teardownDb(); });

describe('formules de calcul (fonctions pures)', () => {
  it('volume = L × l × h / 1 000 000 000, sans nombre de colis ; précision conservée', () => {
    expect(volumeM3({ lengthMm: 1200, widthMm: 800, heightMm: 900 })).toBe(0.864);
    expect(volumeM3({ lengthMm: 910, widthMm: 382, heightMm: 710, parcelCount: 3 })).toBe(0.2468102); // exemple du document : jamais multiplié
    expect(volumeM3({ lengthMm: 1, widthMm: 1, heightMm: 1 })).toBe(0.000000001);
    expect(volumeM3({ lengthMm: 100, widthMm: 200 })).toBeNull(); expect(volumeM3(null)).toBeNull();
    expect(volumeM3({ lengthMm: 1250.5, widthMm: 800, heightMm: 900.25 })).toBe(0.9006101); // dimensions décimales
    expect(volumeM3({ lengthMm: 0.1, widthMm: 0.1, heightMm: 0.1 })).toBe(0.000000000001); // pas d’arrondi prématuré
  });
  it('règles des dimensions et poids : valeurs négatives, brut < net', () => {
    expect(packagingProblems({ lengthMm: -1 })).toHaveLength(1); expect(packagingProblems({ netWeightKg: 10, grossWeightKg: 9 })[0]).toMatch(/poids brut/i);
    expect(packagingProblems({ netWeightKg: 10, grossWeightKg: 10 })).toEqual([]); expect(packagingProblems({ netWeightKg: 10 })).toEqual([]);
  });
  it('marges HT et TTC indicatives ; divisions par zéro gérées', () => {
    const m = margins(100_000, 60_000, 119_000, 19);
    expect(m).toMatchObject({ marginHtMinor: 40_000, marginRatePct: 66.67, markPct: 40, costTtcMinor: 71_400, marginTtcMinor: 47_600, marginTtcRatePct: 66.67 });
    expect(margins(100_000, 0, 119_000, 19)).toMatchObject({ marginRatePct: null, marginHtMinor: 100_000 }); expect(margins(0, 50_000, 0, 19)).toMatchObject({ markPct: null, marginHtMinor: -50_000 });
    expect(margins(100_000, 60_000, 100_000, 0).marginTtcMinor).toBe(40_000); // TVA à 0 : marge TTC = marge HT
  });
  it('prix TTC par le moteur fiscal : taxable, zéro, exonéré, suspendu', () => {
    expect(ttcOf(100_000, { code: 'T19', regime: 'taxable', ratePct: 19 })).toBe(119_000); expect(ttcOf(100_000, { code: 'T0', regime: 'zero', ratePct: 0 })).toBe(100_000);
    expect(ttcOf(100_000, { code: 'EXO', regime: 'exempt', ratePct: 0 })).toBe(100_000); expect(ttcOf(99_999, { code: 'T7', regime: 'taxable', ratePct: 7 })).toBe(106_999);
  });
});

describe('fiche article — création et groupes', () => {
  it('crée un article avec les 5 groupes : valeurs calculées par le serveur (volumes, TTC, marges)', async () => {
    ref = 'MACH-0001';
    const r = await A.j.post('/products', prod({ reference: ref, name: 'Machine industrielle', description: 'Tour conventionnel', minSalePriceMinor: 90_000, maxDiscountPct: 5, minStock: 2,
      estimatedCostMinor: 65_000, mainSupplierId: A.supplierId, packaging: { lengthMm: 1200, widthMm: 800, heightMm: 900, netWeightKg: 850.5, grossWeightKg: 920, type: 'wooden_crate' },
      customs: { supplierHsCode: '0845.20.10', tnHsCode: '0084520', ddPct: 10, fodecPct: 1, rpdPct: 0, originCountry: 'Allemagne', provenanceCountry: 'France', specialRegulation: 'Licence requise' } }));
    expect(r.status, JSON.stringify(r.body)).toBe(201); id = r.body.id;
    expect(r.body).toMatchObject({ reference: ref, status: 'active', statusLabel: 'Actif', vatRateCode: 'T19', vatRatePct: 19, vatRegime: 'taxable', salePriceMinor: 100_000, saleTtcMinor: 119_000, minSalePriceMinor: 90_000, maxDiscountPct: 5,
      purchasePriceMinor: 60_000, estimatedCostMinor: 65_000, costPriceMinor: null, effectiveCostMinor: 65_000, mainSupplierName: 'Fournisseur Local' });
    expect(r.body.packaging).toMatchObject({ lengthMm: 1200, volumeM3: 0.864, type: 'wooden_crate', review: null });
    for (const k of ['brand', 'model']) expect(r.body).not.toHaveProperty(k);
    for (const k of ['parcelCount', 'dimensionsPerParcel', 'totalVolumeM3']) expect(r.body.packaging).not.toHaveProperty(k);
    expect(r.body.customs).toMatchObject({ supplierHsCode: '0845.20.10', tnHsCode: '0084520', ddPct: 10, fodecPct: 1, rpdPct: 0, originCountry: 'Allemagne', provenanceCountry: 'France', specialRegulation: 'Licence requise' });
    expect(r.body.marginMinor).toBe(35_000); expect(r.body.marginRatePct).toBe(53.85); expect(r.body.markPct).toBe(35); expect(r.body.marginTtcMinor).toBe(119_000 - (65_000 + 12_350)); // coût estimé 65 000 ; TVA sur coût 12 350
    expect(r.body.warnings).toEqual([]);
  });
  it('le volume envoyé par le client est ignoré : le serveur recalcule (et à chaque modification)', async () => {
    expect((await A.j.post('/products', prod({ packaging: { lengthMm: 100, widthMm: 100, heightMm: 100, volumeM3: 999 } }))).status).toBe(422); // champ inconnu refusé
    const u = await A.j.put(`/products/${id}/packaging`, { lengthMm: 1000, widthMm: 1000, heightMm: 1000 });
    expect(u.body.packaging).toMatchObject({ volumeM3: 1, heightMm: 1000, netWeightKg: 850.5, type: 'wooden_crate' }); // les autres champs du groupe sont conservés
    expect((await A.j.put(`/products/${id}/packaging`, { heightMm: null })).body.packaging.volumeM3).toBeNull(); // dimensions incomplètes : non calculé
    await A.j.put(`/products/${id}/packaging`, { lengthMm: 1200, widthMm: 800, heightMm: 900 });
    expect((await Product.findById(id).lean())!.packaging).toMatchObject({ volumeM3: 0.864 });
  });
  it('règles côté serveur : négatifs, brut < net, anciens champs de colis refusés', async () => {
    for (const bad of [{ lengthMm: -5 }, { widthMm: -1 }, { netWeightKg: -1 }, { grossWeightKg: -2 }, { parcelCount: 2 }, { dimensionsPerParcel: true }, { type: 'bois' }]) expect((await A.j.put(`/products/${id}/packaging`, bad)).status, JSON.stringify(bad)).toBe(422);
    const g = await A.j.put(`/products/${id}/packaging`, { netWeightKg: 900, grossWeightKg: 800 }); expect(g.status).toBe(400); expect(g.body.error.message).toMatch(/poids brut/i);
    expect((await A.j.put(`/products/${id}/packaging`, { netWeightKg: 800.25, grossWeightKg: 800.25 })).status).toBe(200); // égalité autorisée, décimales acceptées
    await A.j.put(`/products/${id}/packaging`, { netWeightKg: 850.5, grossWeightKg: 920 });
  });
  it('un service n’exige ni packaging ni douane ; son packaging n’est pas exposé', async () => {
    const s = await A.j.post('/products', prod({ kind: 'service', name: 'Installation', purchasePriceMinor: 0 })); expect(s.status).toBe(201); expect(s.body.packaging).toBeNull(); expect(s.body.stockQty).toBe(0);
  });
  it('code article unique par société, insensible à la casse ; réutilisable dans une autre société ; références existantes conservées', async () => {
    expect((await A.j.post('/products', prod({ reference: 'mach-0001' }))).status).toBe(409); expect((await A.j.post('/products', prod({ reference: ' MACH-0001 ' }))).status).toBe(409);
    expect((await B.j.post('/products', { reference: 'MACH-0001', name: 'Autre société', unitId: B.unitId, vatRateCode: 'T19', salePriceMinor: 1000 })).status).toBe(201);
    expect((await A.j.get(`/products?q=${ref}`)).body.items[0].id).toBe(id);
  });
  it('validations : catégorie, unité, fournisseur, TVA inconnus ; prix minimum ≤ prix de vente ; remise 0–100 ; NGP texte', async () => {
    const bad = (extra: object) => A.j.post('/products', prod(extra));
    expect((await bad({ categoryId: new mongoose.Types.ObjectId().toString() })).status).toBe(400); expect((await bad({ unitId: new mongoose.Types.ObjectId().toString() })).status).toBe(400);
    expect((await bad({ mainSupplierId: new mongoose.Types.ObjectId().toString() })).status).toBe(400); expect((await bad({ vatRateCode: 'ZZZ' })).status).toBe(400);
    expect((await bad({ minSalePriceMinor: 120_000 })).status).toBe(400); expect((await bad({ maxDiscountPct: 120 })).status).toBe(422); expect((await bad({ maxDiscountPct: -1 })).status).toBe(422);
    expect((await bad({ customs: { ddPct: -3 } })).status).toBe(422); expect((await bad({ customs: { tnHsCode: 'abc$%' } })).status).toBe(422); expect((await bad({ customs: { vatRatePct: 19 } })).status).toBe(422); // pas de seconde TVA
    expect((await bad({ status: 'blocked' })).status).toBe(422); expect((await bad({ mainPhotoId: id })).status).toBe(422); expect((await bad({ companyId: B.companyId.toString() })).status).toBe(422);
    const zero = await bad({ customs: { tnHsCode: '0012345' } }); expect(zero.body.customs.tnHsCode).toBe('0012345'); // zéros initiaux préservés
  });
  it('TVA : source unique — la fiche Douane et la fiche Prix lisent le même code ; sa modification est visible partout', async () => {
    const p = (await A.j.get(`/products/${id}`)).body; expect(p.vatRateCode).toBe('T19'); expect(p.customs).not.toHaveProperty('vatRateCode'); expect(p.customs).not.toHaveProperty('vatRatePct');
    const u = await A.j.put(`/products/${id}/prices`, { vatRateCode: 'T13' });
    expect(u.body).toMatchObject({ vatRateCode: 'T13', vatRatePct: 13, saleTtcMinor: 113_000 }); expect((await A.j.get(`/products/${id}`)).body.vatRatePct).toBe(13);
    await A.j.put(`/products/${id}/prices`, { vatRateCode: 'T19' });
  });
  it('le stock n’est pas modifiable depuis la fiche : aucun champ de quantité accepté', async () => {
    for (const body of [{ stockQty: 50 }, { stock: 10 }, { qty: 5 }, { costPriceMinor: 1 }, { cmp: 5 }]) expect((await A.j.put(`/products/${id}`, body)).status, JSON.stringify(body)).toBe(422);
  });
});

describe('fiche article — prix, devises, règles commerciales', () => {
  it('prix d’achat en EUR : taux estimatif 3,5 (le taux réel enregistré n’est pas utilisé) ; autres devises : taux réel ; retour en TND', async () => {
    const e = await A.j.put(`/products/${id}/prices`, { purchaseCurrency: 'EUR', purchasePriceForeignMinor: 10_000 }); // 100,00 € × 3,5 = 350,000 TND
    expect(e.status, JSON.stringify(e.body)).toBe(200); expect(e.body).toMatchObject({ purchaseCurrency: 'EUR', purchasePriceForeignMinor: 10_000, estimateRate: 3.5, estimatedPurchaseMinor: 350_000, purchaseRate: null, purchasePriceMinor: null });
    expect((await A.j.put(`/products/${id}/prices`, { purchaseCurrency: 'XYZ', purchasePriceForeignMinor: 1 })).status).toBe(400);
    const back = await A.j.put(`/products/${id}/prices`, { purchaseCurrency: null, purchasePriceForeignMinor: null, purchasePriceMinor: 60_000 }); expect(back.body).toMatchObject({ purchaseCurrency: null, purchasePriceForeignMinor: null, purchasePriceMinor: 60_000, estimateRate: null });
  });
  it('coût de revient réel prioritaire sur le coût estimé ; marge ; alerte vente sous le coût et sous le minimum', async () => {
    await Product.updateOne({ _id: id }, { costPriceMinor: 80_000 }); // alimenté par les réceptions / importations (module Coût de revient)
    const p = (await A.j.get(`/products/${id}`)).body; expect(p).toMatchObject({ costPriceMinor: 80_000, effectiveCostMinor: 80_000, marginMinor: 20_000, marginRatePct: 25, markPct: 20, belowCost: false });
    const low = await A.j.put(`/products/${id}/prices`, { salePriceMinor: 70_000, minSalePriceMinor: 65_000 }); expect(low.body.belowCost).toBe(true); expect(low.body.warnings.join(' ')).toMatch(/inférieur au coût/);
    expect((await A.j.put(`/products/${id}/prices`, { minSalePriceMinor: 80_000 })).status).toBe(400); // minimum > prix de vente
    await A.j.put(`/products/${id}/prices`, { salePriceMinor: 100_000, minSalePriceMinor: 90_000 }); await Product.updateOne({ _id: id }, { $unset: { costPriceMinor: 1 } });
    expect((await A.j.get(`/products?belowCost=true`)).body.items.map((x: { id: string }) => x.id)).not.toContain(id);
  });
  it('aperçu des prix : moteur fiscal et formules uniques', async () => {
    const r = await A.j.post('/products/pricing-preview', { salePriceMinor: 100_000, costMinor: 60_000, vatRateCode: 'T19' });
    expect(r.body).toMatchObject({ vatRatePct: 19, saleTtcMinor: 119_000, belowCost: false }); expect(r.body.margins).toMatchObject({ marginHtMinor: 40_000, marginTtcMinor: 47_600 });
    expect((await A.j.post('/products/pricing-preview', { salePriceMinor: 100_000, vatRateCode: 'EXO' })).body).toMatchObject({ saleTtcMinor: 100_000, vatRegime: 'exempt' });
    expect((await A.j.post('/products/pricing-preview', { salePriceMinor: 1, vatRateCode: 'NOPE' })).status).toBe(400);
  });
  it('règles commerciales côté serveur : prix minimum et remise maximale ; dérogation motivée, autorisée (products:validate) et auditée', async () => {
    const quote = (lines: object[], extra: object = {}) => A.j.post('/quotations', { customerId: A.customerId, validUntil: plusDays(30), lines, ...extra });
    const okq = await quote([{ productId: id, quantity: 1, unitPriceMinor: 95_000, discountPct: 3 }]); expect(okq.status, JSON.stringify(okq.body)).toBe(201); // 95 000 × 0,97 = 92 150 ≥ 90 000 ; remise 3 ≤ 5
    const lowp = await quote([{ productId: id, quantity: 1, unitPriceMinor: 80_000 }]); expect(lowp.status).toBe(409); expect(lowp.body.error.code).toBe('PRICE_RULE_VIOLATION'); expect(lowp.body.error.details.violations[0].rule).toBe('min_price');
    const disc = await quote([{ productId: id, quantity: 1, discountPct: 10 }]); expect(disc.status).toBe(409); expect(disc.body.error.details.violations.map((x: { rule: string }) => x.rule)).toContain('max_discount');
    const draft = await A.j.post('/invoices', { customerId: A.customerId, lines: [{ productId: id, quantity: 1, unitPriceMinor: 50_000 }] }); expect(draft.status).toBe(409); // même règle sur les factures
    expect((await A.j.post('/proformas', { customerId: A.customerId, validUntil: plusDays(30), lines: [{ productId: id, quantity: 1, unitPriceMinor: 50_000 }] })).status).toBe(409);
    // sans permission products:validate : refusé même avec un motif
    await makeUser(A.companyId, 'vendeur@a.test', ['quotations:create', 'quotations:view', 'products:view', 'customers:view']); const V = J((await login('vendeur@a.test')).token);
    const forbidden = await V.post('/quotations', { customerId: A.customerId, validUntil: plusDays(30), lines: [{ productId: id, quantity: 1, unitPriceMinor: 80_000 }], priceOverrideReason: 'Geste commercial' }); expect(forbidden.status).toBe(403); expect(forbidden.body.error.code).toBe('PRICE_OVERRIDE_FORBIDDEN');
    expect((await quote([{ productId: id, quantity: 1, unitPriceMinor: 80_000 }], { priceOverrideReason: 'x' })).status).toBe(422); // motif trop court
    const okOverride = await quote([{ productId: id, quantity: 1, unitPriceMinor: 80_000 }], { priceOverrideReason: 'Client stratégique, accord direction' }); expect(okOverride.status, JSON.stringify(okOverride.body)).toBe(201);
    const a = await AuditLog.findOne({ companyId: A.companyId, action: 'price-override' }).lean(); expect(a).toBeTruthy(); expect((a!.meta as { reason: string }).reason).toMatch(/direction/);
    expect(okOverride.body.lines[0].unitPriceMinor).toBe(80_000); // le document garde le prix dérogé ; l'article n'est pas modifié
    expect((await A.j.get(`/products/${id}`)).body.salePriceMinor).toBe(100_000);
  });
  it('un document validé ne change jamais quand le prix de l’article change', async () => {
    const d = await A.j.post('/invoices', { customerId: A.customerId, lines: [{ productId: A.products.a19, quantity: 1 }] }); const v = await A.j.post(`/invoices/${d.body.id}/validate`); expect(v.status).toBe(200);
    await A.j.put(`/products/${A.products.a19}/prices`, { salePriceMinor: 555_000 });
    expect((await A.j.get(`/invoices/${d.body.id}`)).body.lines[0].unitPriceMinor).toBe(100_000); await A.j.put(`/products/${A.products.a19}/prices`, { salePriceMinor: 100_000 });
  });
  it('fournisseur habituel : filtre et recherche par nom de fournisseur', async () => {
    expect((await A.j.get(`/products?supplierId=${A.supplierId}`)).body.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await A.j.get('/products?q=Fournisseur Local')).body.items.map((x: { id: string }) => x.id)).toContain(id);
  });
});

describe('fiche article — statuts et conséquences', () => {
  let sid = '';
  it('quatre statuts, transitions, archivé → actif seulement, trace dans la chronologie', async () => {
    sid = (await A.j.post('/products', prod({ reference: 'ST-1', name: 'Statuts' }))).body.id;
    const s = (status: string, reason?: string) => A.j.post(`/products/${sid}/status`, { status, ...(reason && { reason }) });
    expect((await s('active')).status).toBe(409); expect((await s('blocked', 'Défaut de série')).body).toMatchObject({ status: 'blocked', statusReason: 'Défaut de série', isActive: false, canUse: false });
    expect((await s('inactive')).body.status).toBe('inactive'); expect((await s('archived')).body).toMatchObject({ status: 'archived', isActive: false });
    expect((await s('blocked')).status).toBe(409); expect((await s('inactive')).status).toBe(409); expect((await s('active')).body).toMatchObject({ status: 'active', isActive: true, statusReason: null });
    expect((await s('inconnu')).status).toBe(422);
    const acts = (await A.j.get(`/products/${sid}/activities?kind=status_changed&limit=50`)).body.items; expect(acts).toHaveLength(4); expect(acts.every((a: { auto: boolean; editable: boolean }) => a.auto && !a.editable)).toBe(true);
  });
  it('vente : devis / proforma / facture / BL refusés pour un article inactif, bloqué ou archivé ; consultation et historique intacts', async () => {
    const q = () => A.j.post('/quotations', { customerId: A.customerId, validUntil: plusDays(30), lines: [{ productId: sid, quantity: 1 }] });
    await A.j.post(`/products/${sid}/status`, { status: 'active' }); const good = await q(); expect(good.status).toBe(201);
    for (const st of ['inactive', 'blocked', 'archived']) {
      await A.j.post(`/products/${sid}/status`, { status: st }); const r = await q(); expect(r.status, st).toBe(409); expect(r.body.error.code).toBe(`PRODUCT_${st.toUpperCase()}`);
      expect((await A.j.get(`/quotations/${good.body.id}`)).status).toBe(200); // le document passé reste accessible
      if (st !== 'archived') await A.j.post(`/products/${sid}/status`, { status: 'active' });
    }
    await A.j.post(`/products/${sid}/status`, { status: 'active' });
  });
  it('achat : commande refusée pour un article non actif ; la facture d’une opération passée reste enregistrable', async () => {
    const po = (productId: string) => A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId, quantity: 1, unitPriceMinor: 1000 }] });
    const c = await po(sid); expect(c.status).toBe(201); await A.j.post(`/products/${sid}/status`, { status: 'blocked' });
    const r = await po(sid); expect(r.status).toBe(409); expect(r.body.error.code).toBe('PRODUCT_BLOCKED');
    await A.j.post(`/products/${sid}/status`, { status: 'active' });
  });
  it('stock : entrée manuelle refusée si bloqué ; sortie et transfert possibles ; archivé = plus aucune opération', async () => {
    await A.j.post(`/products/${sid}/status`, { status: 'active' }); expect((await stockIn(A, sid, 10, 1000)).status).toBe(201);
    await A.j.post(`/products/${sid}/status`, { status: 'inactive' }); expect((await stockIn(A, sid, 1, 1000)).status).toBe(201); // inactif : entrées correctives autorisées
    await A.j.post(`/products/${sid}/status`, { status: 'blocked' });
    const inn = await stockIn(A, sid, 1, 1000); expect(inn.status).toBe(409); expect(inn.body.error.code).toBe('PRODUCT_BLOCKED');
    expect((await A.j.post('/stock/movements', { direction: 'out', productId: sid, warehouseId: A.w1, quantity: 1, reason: 'Casse' })).status).toBe(201);
    const t = await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: sid, quantity: 2 }] }); expect((await A.j.post(`/stock-transfers/${t.body.id}/validate`)).status).toBe(200);
    await A.j.post(`/products/${sid}/status`, { status: 'archived' });
    const out = await A.j.post('/stock/movements', { direction: 'out', productId: sid, warehouseId: A.w1, quantity: 1, reason: 'Test article archivé' }); expect(out.status).toBe(409); expect(out.body.error.code).toBe('PRODUCT_ARCHIVED');
    expect((await A.j.put(`/products/${sid}`, { name: 'Modif' })).status).toBe(409); // archivé : pas de modification
    await A.j.post(`/products/${sid}/status`, { status: 'active' });
  });
  it('la liste filtre par statut (défaut : hors archivés) et l’ancienne route active / inactive reste compatible', async () => {
    const ids = async (qs: string) => (await A.j.get(`/products?${qs}&limit=100`)).body.items.map((x: { id: string }) => x.id);
    await A.j.post(`/products/${sid}/status`, { status: 'archived' });
    expect(await ids('')).not.toContain(sid); expect(await ids('status=archived')).toContain(sid); expect(await ids('status=all')).toContain(sid); expect(await ids('status=blocked')).not.toContain(sid);
    await A.j.post(`/products/${sid}/status`, { status: 'active' });
    expect((await patch(A.token, `/products/${sid}/active`, { isActive: false })).body.status).toBe('inactive'); expect(await ids('active=false')).toContain(sid); expect(await ids('active=true')).not.toContain(sid);
    expect((await patch(A.token, `/products/${sid}/active`, { isActive: true })).body.status).toBe('active');
  });
});

describe('fiche article — onglet Stock (lecture des niveaux réels)', () => {
  let p = '';
  it('stock par entrepôt : quantités, CMP, valeur, statuts (rupture, sous le minimum, au-dessus du maximum)', async () => {
    p = (await A.j.post('/products', prod({ reference: 'STK-1', name: 'Article stocké', minStock: 5 }))).body.id;
    await stockIn(A, p, 10, 2_000, A.w1); await stockIn(A, p, 2, 3_000, A.w2);
    const set = await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { location: 'Allée B — Rack 3', minQty: 4, maxQty: 8 }); expect(set.status, JSON.stringify(set.body)).toBe(200);
    const t = (await A.j.get(`/products/${p}/stock`)).body; const w1 = t.warehouses.find((w: { code: string }) => w.code === 'WH1'); const w2 = t.warehouses.find((w: { code: string }) => w.code === 'WH2');
    expect(w1).toMatchObject({ qty: 10, valueMinor: 20_000, cmpMinor: 2_000, location: 'Allée B — Rack 3', minQty: 4, maxQty: 8, status: 'above_max', statusLabel: 'Au-dessus du maximum' });
    expect(w2).toMatchObject({ qty: 2, valueMinor: 6_000, cmpMinor: 3_000, effectiveMinQty: 5, status: 'below_min' }); // minimum global de l'article quand aucun réglage par magasin
    expect(t.total).toMatchObject({ qty: 12, valueMinor: 26_000 }); expect(t.alerts.map((a: { status: string }) => a.status).sort()).toEqual(['above_max', 'below_min']);
    await A.j.post('/stock/movements', { direction: 'out', productId: p, warehouseId: A.w2, quantity: 2, reason: 'Sortie pour test rupture' });
    expect((await A.j.get(`/products/${p}/stock`)).body.warehouses.find((w: { code: string }) => w.code === 'WH2')).toMatchObject({ qty: 0, status: 'out', statusLabel: 'Rupture' });
  });
  it('réglages : minimum ≤ maximum, effacement, aucun réglage pour un service ni pour un magasin d’une autre société ; stock jamais modifié', async () => {
    expect((await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { minQty: 9, maxQty: 3 })).status).toBe(400);
    expect((await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { minQty: -1 })).status).toBe(422);
    expect((await A.j.put(`/products/${p}/stock-settings/${B.w1}`, { minQty: 1 })).status).toBe(404);
    const svc = (await A.j.post('/products', prod({ kind: 'service', name: 'Service' }))).body.id; expect((await A.j.put(`/products/${svc}/stock-settings/${A.w1}`, { minQty: 1 })).status).toBe(400);
    const cleared = (await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { location: null, minQty: null, maxQty: null })).body; expect(cleared.warehouses.find((w: { code: string }) => w.code === 'WH1')).toMatchObject({ location: null, minQty: null, maxQty: null, qty: 10 });
    expect(await ProductStockSetting.countDocuments({ productId: p, warehouseId: A.w1 })).toBe(0); expect((await stockQty(p)).qty).toBe(10); // les réglages n'ont rien changé aux quantités
  });
  it('liste : stock disponible par article ou par magasin ; filtres rupture / sous le minimum / entrepôt', async () => {
    const row = async (qs: string) => (await A.j.get(`/products?q=STK-1&${qs}`)).body.items[0];
    expect((await row('')).stockQty).toBe(10); expect((await row(`warehouseId=${A.w2}`)).stockQty).toBe(0);
    const ids = async (qs: string) => (await A.j.get(`/products?${qs}&limit=100`)).body.items.map((x: { id: string }) => x.id);
    expect(await ids(`stockState=out&warehouseId=${A.w2}`)).toContain(p); expect(await ids('stockState=out')).not.toContain(p);
    await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { minQty: 20 }); expect(await ids(`stockState=below_min&warehouseId=${A.w1}`)).toContain(p); expect(await ids('stockState=below_min')).not.toContain(p); // minimum global 5, stock total 10
    await A.j.put(`/products/${p}/stock-settings/${A.w1}`, { minQty: null });
  });
  it('numéros de série intégrés à l’onglet : suivi, entrepôt et statut', async () => {
    const s = A.serialProduct; await A.j.post(`/products/${s}/serials`, { serials: ['SN-001', 'SN-002'] });
    const list = (await A.j.get(`/products/${s}/serials`)).body; expect(list.total).toBe(2); expect(list.items[0]).toMatchObject({ serialNumber: 'SN-001', status: 'available', warehouse: null });
    expect((await A.j.get(`/products/${s}/stock`)).body).toMatchObject({ hasSerial: true, serialCount: 2 });
  });
  it('suppression refusée si du stock existe ; autorisée sinon (documents, activités et réglages nettoyés)', async () => {
    expect((await A.j.del(`/products/${p}`)).status).toBe(409);
    const free = (await A.j.post('/products', prod({ reference: 'DEL-1', name: 'À supprimer' }))).body.id; await upload(A.token, free, PDF, 'fiche.pdf'); await A.j.put(`/products/${free}/stock-settings/${A.w1}`, { minQty: 1 });
    expect((await A.j.del(`/products/${free}`)).status).toBe(204); expect(await ProductDocument.countDocuments({ productId: free })).toBe(0); expect(await ProductActivity.countDocuments({ productId: free })).toBe(0); expect(await ProductStockSetting.countDocuments({ productId: free })).toBe(0);
  });
});
const stockQty = async (p: string) => { const t = (await J(A.token).get(`/products/${p}/stock`)).body; return { qty: t.total.qty as number }; };

describe('fiche article — transactions', () => {
  let t = ''; let supplierDoc = '';
  it('rassemble achats, ventes, stock et importations réels ; rien n’est copié dans l’article', async () => {
    t = (await A.j.post('/products', prod({ reference: 'TX-1', name: 'Article transactions', purchasePriceMinor: 10_000, salePriceMinor: 50_000 }))).body.id;
    const po = await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId: t, quantity: 10, unitPriceMinor: 10_000 }] }); await A.j.post(`/purchase-orders/${po.body.id}/confirm`);
    const conf = (await A.j.get(`/purchase-orders/${po.body.id}`)).body; const rc = await A.j.post('/goods-receipts', { purchaseOrderId: po.body.id, warehouseId: A.w1, lines: [{ orderLineId: conf.lines[0].id, quantity: 6 }] }); expect((await A.j.post(`/goods-receipts/${rc.body.id}/validate`)).status).toBe(200);
    const q = await A.j.post('/quotations', { customerId: A.customerId, validUntil: plusDays(30), lines: [line(t, 2)] }); const d = await A.j.post('/invoices', { customerId: A.customerId, lines: [line(t, 1)] }); await A.j.post(`/invoices/${d.body.id}/validate`);
    const bl = await A.j.post('/delivery-notes', { customerId: A.customerId, lines: [line(t, 1)] }); expect(bl.status).toBe(201);
    const imp = await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', exchangeRate: 3.4, lines: [{ productId: t, quantity: 5, unitPriceMinor: 2_000 }] }); expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    void q; supplierDoc = rc.body.id;
    const all = (await A.j.get(`/products/${t}/transactions?limit=100`)).body;
    expect(new Set(all.items.map((r: { kind: string }) => r.kind))).toEqual(new Set(['purchase_order', 'goods_receipt', 'quotation', 'invoice', 'delivery_note', 'stock_movement', 'import_file', 'cost_history']));
    expect(all.groups.sort()).toEqual(['imports', 'purchases', 'sales', 'stock']);
    const po1 = all.items.find((r: { kind: string }) => r.kind === 'purchase_order'); expect(po1).toMatchObject({ group: 'purchases', quantity: 10, unitPriceMinor: 10_000, supplier: 'Fournisseur Local', statusLabel: 'Partiellement reçue', phase: 'En cours' });
    const inv = all.items.find((r: { kind: string }) => r.kind === 'invoice'); expect(inv).toMatchObject({ group: 'sales', quantity: 1, customer: 'Client Test', phase: 'Terminé', pdfPath: expect.stringMatching(/^\/invoices\/.+\/pdf$/) });
    const mv = all.items.find((r: { kind: string }) => r.kind === 'stock_movement'); expect(mv).toMatchObject({ group: 'stock', quantity: 6, direction: 'in', warehouse: 'WH1 — Magasin principal' });
    const im = all.items.find((r: { kind: string }) => r.kind === 'import_file'); expect(im).toMatchObject({ group: 'imports', quantity: 5, currency: 'EUR', unitPriceMinor: 2_000 });
    expect(Object.keys((await Product.findById(t).lean())!)).not.toContain('transactions'); // aucune duplication dans la collection Products
  });
  it('filtres : groupe, type, statut, période, référence, entrepôt ; pagination et ordre chronologique', async () => {
    const g = async (qs: string) => (await A.j.get(`/products/${t}/transactions?${qs}&limit=100`)).body;
    expect((await g('group=sales')).items.every((r: { group: string }) => r.group === 'sales')).toBe(true); expect((await g('group=purchases')).total).toBe(2); // commande + réception
    expect((await g('type=quotation&status=draft')).total).toBe(1); expect((await g('type=invoice&status=paid')).total).toBe(0); expect((await g('status=pending')).items.every((r: { kind: string }) => r.kind === 'proforma')).toBe(true);
    expect((await g(`from=${plusDays(2)}`)).total).toBe(0); expect((await g('warehouseId=' + A.w2)).items.filter((r: { kind: string }) => r.kind === 'goods_receipt')).toHaveLength(0);
    const ref = (await A.j.get(`/purchase-orders/${(await g('type=purchase_order')).items[0].id ?? ''}`)); void ref;
    const dates = (await g('')).items.map((r: { date: string }) => +new Date(r.date)); expect(dates).toEqual([...dates].sort((a, b) => b - a));
    const p1 = (await A.j.get(`/products/${t}/transactions?limit=3&page=1`)).body; const p2 = (await A.j.get(`/products/${t}/transactions?limit=3&page=2`)).body; expect(p1.items).toHaveLength(3); expect(p1.items.map((r: { key: string }) => r.key)).not.toEqual(expect.arrayContaining(p2.items.map((r: { key: string }) => r.key)));
    expect((await A.j.get(`/products/${t}/transactions?group=nimporte`)).status).toBe(422);
  });
  it('chaque type exige la permission de son module : la fiche article n’ouvre aucun module protégé', async () => {
    await makeUser(A.companyId, 'achats@a.test', ['products:view', 'purchases:view']); await makeUser(A.companyId, 'ventes@a.test', ['products:view', 'quotations:view', 'invoices:view']); await makeUser(A.companyId, 'seul@a.test', ['products:view']);
    const P = J((await login('achats@a.test')).token), S = J((await login('ventes@a.test')).token), O = J((await login('seul@a.test')).token);
    const kinds = async (c: ReturnType<typeof J>) => [...new Set((await c.get(`/products/${t}/transactions?limit=100`)).body.items.map((r: { kind: string }) => r.kind))].sort();
    expect(await kinds(P)).toEqual(['goods_receipt', 'purchase_order']); expect(await kinds(S)).toEqual(['invoice', 'quotation']); expect(await kinds(O)).toEqual([]);
    expect((await S.get(`/products/${t}/transactions?group=stock`)).body.items).toEqual([]); expect((await O.get(`/products/${t}/transactions?type=invoice`)).body.total).toBe(0);
    expect((await O.get(`/products/${t}/transactions`)).body.allowedKinds).toEqual([]);
  });
  it('les documents sources liés : factures d’achat et dossiers d’importation (sans copie de fichier)', async () => {
    const pi = await A.j.post('/purchase-invoices', { supplierId: A.supplierId, supplierInvoiceNumber: 'FF-2026-9', purchaseOrderId: undefined, invoiceDate: new Date().toISOString().slice(0, 10), lines: [{ productId: t, quantity: 1, unitPriceMinor: 10_000 }] }); void pi;
    const docs = (await A.j.get(`/products/${t}/documents`)).body; expect(docs.items).toEqual([]); expect(docs.linked.map((l: { kind: string }) => l.kind)).toContain('supplier_invoice');
    const O = J((await login('seul@a.test')).token); expect((await O.get(`/products/${t}/documents`)).body.linked).toEqual([]); // sans permission d'achat : aucun lien
    void supplierDoc;
  });
});

describe('fiche article — documents et photo principale', () => {
  let d = ''; let ph1 = ''; let ph2 = '';
  it('photos et documents : première photo = principale, plusieurs photos, changement de photo principale', async () => {
    d = (await A.j.post('/products', prod({ reference: 'DOC-1', name: 'Article documents' }))).body.id;
    const a = await upload(A.token, d, PNG, 'face.png', 'photo'); expect(a.status, JSON.stringify(a.body)).toBe(201); ph1 = a.body.id; expect(a.body).toMatchObject({ type: 'photo', typeLabel: 'Photo de l’article', isImage: true, isMain: true, mime: 'image/png', size: PNG.length });
    const b = await upload(A.token, d, JPG, 'profil.jpg', 'photo'); ph2 = b.body.id; expect(b.body.isMain).toBe(false);
    expect((await A.j.get(`/products/${d}`)).body).toMatchObject({ hasPhoto: true, mainPhotoId: ph1 });
    const m = await A.j.post(`/products/${d}/documents/${ph2}/main`); expect(m.body.mainPhotoId).toBe(ph2);
    const photo = await api().get(`/api/v1/products/${d}/photo`).set(authed(A.token)).buffer().parse(binaryParser); expect(photo.status).toBe(200); expect(photo.headers['content-type']).toBe('image/jpeg'); expect(Buffer.compare(photo.body as Buffer, JPG)).toBe(0);
    expect(photo.headers['content-security-policy']).toContain('sandbox');
    for (const [name, type] of [['fiche technique.pdf', 'datasheet'], ['manuel.pdf', 'manual'], ['ce.pdf', 'ce_certificate'], ['origine.pdf', 'origin_certificate'], ['conformite.pdf', 'conformity'], ['douane.pdf', 'customs'], ['garantie.pdf', 'warranty'], ['facture.pdf', 'supplier_invoice'], ['divers.pdf', 'other']] as const) expect((await upload(A.token, d, PDF, name, type)).status, type).toBe(201);
    const list = (await A.j.get(`/products/${d}/documents`)).body; expect(list.items).toHaveLength(11); expect(list.mainPhotoId).toBe(ph2); expect(list.items.filter((x: { isMain: boolean }) => x.isMain)).toHaveLength(1);
  });
  it('photo principale supprimée : remplacée par la photo la plus récente puis par aucune ; seule une image peut être photo', async () => {
    expect((await upload(A.token, d, PDF, 'pas-une-photo.pdf', 'photo')).status).toBe(400);
    const pdfDoc = (await A.j.get(`/products/${d}/documents`)).body.items.find((x: { type: string }) => x.type === 'datasheet'); expect((await A.j.post(`/products/${d}/documents/${pdfDoc.id}/main`)).status).toBe(400); expect((await A.j.put(`/products/${d}/documents/${pdfDoc.id}`, { type: 'photo' })).status).toBe(400);
    expect((await A.j.del(`/products/${d}/documents/${ph2}`)).status).toBe(204); expect((await A.j.get(`/products/${d}`)).body.mainPhotoId).toBe(ph1);
    expect((await A.j.del(`/products/${d}/documents/${ph1}`)).status).toBe(204); expect((await A.j.get(`/products/${d}`)).body).toMatchObject({ hasPhoto: false, mainPhotoId: null }); expect((await api().get(`/api/v1/products/${d}/photo`).set(authed(A.token))).status).toBe(404);
  });
  it('téléchargement sécurisé, métadonnées, consultation en ligne ; audit', async () => {
    const doc = (await A.j.get(`/products/${d}/documents`)).body.items.find((x: { type: string }) => x.type === 'ce_certificate');
    const dl = await api().get(`/api/v1/products/${d}/documents/${doc.id}/file`).set(authed(A.token)).buffer().parse(binaryParser); expect(dl.status).toBe(200); expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/); expect(dl.headers['x-content-type-options']).toBe('nosniff'); expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect((await api().get(`/api/v1/products/${d}/documents/${doc.id}/file?disposition=inline`).set(authed(A.token))).headers['content-disposition']).toMatch(/^inline/);
    expect((await A.j.put(`/products/${d}/documents/${doc.id}`, { type: 'conformity', description: 'Marquage CE 2026' })).body).toMatchObject({ type: 'conformity', description: 'Marquage CE 2026' }); expect((await A.j.put(`/products/${d}/documents/${doc.id}`, { type: 'virus' })).status).toBe(422);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'product', action: 'document-download' })).toBeGreaterThan(0);
  });
  it('sécurité des fichiers : extensions dangereuses, faux contenus, vide, trop gros, sans jeton, sans permission', async () => {
    for (const [buf, name] of [[Buffer.from('MZ\x90\x00'), 'setup.exe'], [PDF, 'x.pdf.exe'], [Buffer.from('<?php echo 1;'), 'a.php'], [Buffer.from('<svg onload=alert(1)>'), 'a.svg'], [Buffer.from('<html></html>'), 'a.html'], [PDF, 'noext']] as [Buffer, string][]) expect((await upload(A.token, d, buf, name)).status, name).toBe(400);
    expect((await upload(A.token, d, Buffer.from('texte'), 'faux.pdf')).status).toBe(400); expect((await upload(A.token, d, PNG, 'image.pdf')).status).toBe(400); expect((await upload(A.token, d, Buffer.alloc(0), 'vide.pdf')).status).toBe(400);
    expect((await upload(A.token, d, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'gros.pdf')).status).toBe(413);
    expect((await api().post(`/api/v1/products/${d}/documents`).field('type', 'other').attach('file', PDF, 'x.pdf')).status).toBe(401);
    expect((await upload(J((await login('seul@a.test')).token) && (await login('seul@a.test')).token, d, PDF, 'x.pdf')).status).toBe(403); // products:view seul : pas d'écriture
    expect((await api().post(`/api/v1/products/${d}/documents`).set(authed(A.token)).field('type', 'nimporte').attach('file', PDF, 'x.pdf')).status).toBe(422);
  });
  it('isolation multi-société : documents, photo, métadonnées, suppression', async () => {
    const doc = (await A.j.get(`/products/${d}/documents`)).body.items[0];
    for (const r of [await B.j.get(`/products/${d}/documents`), await B.j.put(`/products/${d}/documents/${doc.id}`, { description: 'x' }), await B.j.del(`/products/${d}/documents/${doc.id}`), await api().get(`/api/v1/products/${d}/documents/${doc.id}/file`).set(authed(B.token)), await upload(B.token, d, PDF, 'x.pdf'), await api().get(`/api/v1/products/${d}/photo`).set(authed(B.token))]) expect(r.status).toBe(404);
  });
});

describe('fiche article — activités', () => {
  let a = ''; let manual = '';
  it('événements automatiques générés par les opérations réelles ; non modifiables ; sans doublon', async () => {
    a = (await A.j.post('/products', prod({ reference: 'ACT-1', name: 'Article activités', salePriceMinor: 100_000, purchasePriceMinor: 50_000 }))).body.id;
    await A.j.put(`/products/${a}/prices`, { purchasePriceMinor: 55_000 }); await A.j.put(`/products/${a}/prices`, { salePriceMinor: 120_000 }); await A.j.put(`/products/${a}`, { description: 'Nouvelle description' });
    await A.j.put(`/products/${a}/prices`, { salePriceMinor: 120_000 }); // aucun changement : aucun événement
    await upload(A.token, a, PDF, 'ce.pdf', 'ce_certificate'); await stockIn(A, a, 3, 1000, A.w1);
    const t = (await A.j.get(`/products/${a}/activities?limit=100`)).body; const kinds = t.items.map((x: { kind: string }) => x.kind);
    for (const k of ['product_created', 'purchase_price_changed', 'sale_price_changed', 'technical_changed', 'document_added', 'stock_changed']) expect(kinds, k).toContain(k);
    expect(kinds.filter((k: string) => k === 'sale_price_changed'), JSON.stringify(t.items.map((x: { kind: string; meta: unknown }) => [x.kind, x.meta]))).toHaveLength(1); expect(kinds.filter((k: string) => k === 'purchase_price_changed')).toHaveLength(1); // jamais de doublon, jamais d'événement sans changement
    const sale = t.items.find((x: { kind: string }) => x.kind === 'sale_price_changed'); expect(sale.meta).toMatchObject({ saleFrom: 100_000, saleTo: 120_000 }); expect(sale).toMatchObject({ auto: true, editable: false, kindLabel: 'Prix de vente modifié' });
    expect(t.items.find((x: { kind: string }) => x.kind === 'technical_changed').description).toMatch(/description/); const again = (await A.j.get(`/products/${a}/activities?limit=100`)).body; expect(again.items.map((x: { id: string }) => x.id)).toEqual(t.items.map((x: { id: string }) => x.id));
    const auto = t.items.find((x: { kind: string }) => x.kind === 'product_created'); expect((await A.j.put(`/products/${a}/activities/${auto.id}`, { title: 'zz' })).status).toBe(409); expect((await A.j.del(`/products/${a}/activities/${auto.id}`)).status).toBe(409);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'product-activity' })).toBe(0); // journal métier distinct de l'audit de sécurité
  });
  it('mouvements réels : réception, transfert et changement de stock lus à la volée (jamais dupliqués) ; coût de revient', async () => {
    const po = await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId: a, quantity: 4, unitPriceMinor: 1000 }] }); await A.j.post(`/purchase-orders/${po.body.id}/confirm`);
    const conf = (await A.j.get(`/purchase-orders/${po.body.id}`)).body; const rc = await A.j.post('/goods-receipts', { purchaseOrderId: po.body.id, warehouseId: A.w1, lines: [{ orderLineId: conf.lines[0].id, quantity: 4 }] }); await A.j.post(`/goods-receipts/${rc.body.id}/validate`);
    const tr = await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: a, quantity: 2 }] }); await A.j.post(`/stock-transfers/${tr.body.id}/validate`);
    const kinds = (await A.j.get(`/products/${a}/activities?limit=100`)).body.items.map((x: { kind: string }) => x.kind);
    for (const k of ['goods_received', 'stock_transfer', 'stock_changed', 'cost_changed']) expect(kinds, k).toContain(k); expect(kinds.filter((k: string) => k === 'stock_transfer')).toHaveLength(1); // un transfert = un événement (pas deux)
  });
  it('activités manuelles : appel, réunion, tâche, rappel, note ; échéance ; réalisation ; filtres', async () => {
    const mk = (b: object) => A.j.post(`/products/${a}/activities`, b);
    const call = await mk({ kind: 'call', title: 'Appel au fournisseur', description: 'Délai de livraison', occurredAt: '2026-11-15T10:00:00Z' }); expect(call.status).toBe(201); manual = call.body.id; expect(call.body).toMatchObject({ kind: 'call', kindLabel: 'Appel téléphonique', auto: false, editable: true, done: null });
    const task = await mk({ kind: 'task', title: 'Demander le certificat CE', dueDate: plusDays(-2) }); expect(task.body).toMatchObject({ done: false, overdue: true, kindLabel: 'Tâche à effectuer' });
    const rem = await mk({ kind: 'reminder', title: 'Relancer le prix', dueDate: plusDays(10) }); expect(rem.body.overdue).toBe(false);
    expect((await mk({ kind: 'meeting', title: 'Réunion technique' })).status).toBe(201); expect((await mk({ kind: 'note', title: 'Note interne' })).status).toBe(201);
    expect((await mk({ kind: 'call', title: 'Appel', dueDate: plusDays(3) })).status).toBe(400); expect((await mk({ kind: 'product_created', title: 'Faux événement' })).status).toBe(422); expect((await mk({ kind: 'call', title: 'x' })).status).toBe(422);
    const done = await A.j.put(`/products/${a}/activities/${task.body.id}`, { done: true }); expect(done.body).toMatchObject({ done: true, overdue: false }); expect((await A.j.put(`/products/${a}/activities/${call.body.id}`, { done: true })).status).toBe(400);
    expect((await A.j.put(`/products/${a}/activities/${call.body.id}`, { title: 'Appel avec le fournisseur allemand' })).body.title).toBe('Appel avec le fournisseur allemand');
    const open = (await A.j.get(`/products/${a}/activities?open=true`)).body.items; expect(open.map((x: { title: string }) => x.title)).toEqual(['Relancer le prix']); // tâches ouvertes seulement
    expect((await A.j.get(`/products/${a}/activities?kind=call`)).body.items).toHaveLength(1);
    const byDate = (await A.j.get(`/products/${a}/activities?from=2026-11-15T00:00:00Z&to=2026-11-16T00:00:00Z`)).body.items; expect(byDate.map((x: { id: string }) => x.id)).toEqual([manual]);
    expect((await A.j.del(`/products/${a}/activities/${manual}`)).status).toBe(204);
  });
  it('les montants d’achat n’apparaissent dans la chronologie qu’avec la permission correspondante', async () => {
    await makeUser(A.companyId, 'lect@a.test', ['products:view']); const L = J((await login('lect@a.test')).token);
    const kinds = (await L.get(`/products/${a}/activities?limit=100`)).body.items.map((x: { kind: string }) => x.kind); expect(kinds).not.toContain('purchase_price_changed'); expect(kinds).not.toContain('cost_changed'); expect(kinds).not.toContain('stock_changed'); expect(kinds).toContain('sale_price_changed');
    expect((await L.post(`/products/${a}/activities`, { kind: 'note', title: 'Note interdite' })).status).toBe(403);
  });
});

describe('fiche article — permissions par donnée sensible', () => {
  it('« consulter les articles » ne donne ni prix d’achat, ni coût, ni marges, ni douane ; le prix de vente reste visible', async () => {
    const id2 = (await A.j.get('/products?q=MACH-0001')).body.items[0].id; await Product.updateOne({ _id: id2 }, { costPriceMinor: 80_000 });
    const L = J((await login('lect@a.test')).token); const g = (await L.get(`/products/${id2}`)).body;
    expect(g).toMatchObject({ salePriceMinor: 100_000, saleTtcMinor: 119_000, customs: null, purchasePriceMinor: null, estimatedCostMinor: null, costPriceMinor: null, effectiveCostMinor: null, marginMinor: null, marginRatePct: null, marginTtcMinor: null, belowCost: null, purchaseCurrency: null });
    expect(g.access).toEqual({ purchase: false, cost: false, customs: false, stock: false }); expect(g.stockQty).toBeNull(); expect((await L.get('/products?stockState=out')).status).toBe(403); expect((await L.get(`/products?warehouseId=${A.w1}`)).status).toBe(403); expect((await L.get('/products?belowCost=true')).status).toBe(403);
    const list = (await L.get('/products?q=MACH')).body.items[0]; expect(list.purchasePriceMinor).toBeNull(); expect(list.marginMinor).toBeNull(); expect(list.customs).toBeNull();
    expect((await L.get(`/products?sort=purchasePriceMinor`)).status).toBe(200); // tri sur une donnée masquée ignoré
    expect((await L.get(`/products/${id2}/stock`)).status).toBe(403); // inventory:view requis
    for (const [path, body] of [[`/products/${id2}/prices`, { salePriceMinor: 1 }], [`/products/${id2}/customs`, { ddPct: 1 }], [`/products/${id2}/packaging`, { lengthMm: 1 }], [`/products/${id2}/status`, { status: 'blocked' }]] as [string, object][]) expect((await L.put(path, body)).status === 403 || path.endsWith('status'), path).toBe(true);
    expect((await L.post(`/products/${id2}/status`, { status: 'blocked' })).status).toBe(403); expect((await L.get(`/products/${id2}/pdf`)).status).toBe(200);
  });
  it('rôles intermédiaires : achats voient les prix d’achat, coût/marge exigent costCalculation:view, douane exige imports:view ou products:update', async () => {
    const id2 = (await A.j.get('/products?q=MACH-0001')).body.items[0].id;
    await makeUser(A.companyId, 'achat2@a.test', ['products:view', 'purchases:view']); await makeUser(A.companyId, 'cout@a.test', ['products:view', 'costCalculation:view']); await makeUser(A.companyId, 'douane@a.test', ['products:view', 'imports:view']); await makeUser(A.companyId, 'edit@a.test', ['products:view', 'products:update']);
    const P = J((await login('achat2@a.test')).token), C = J((await login('cout@a.test')).token), D = J((await login('douane@a.test')).token), E = J((await login('edit@a.test')).token);
    expect((await P.get(`/products/${id2}`)).body).toMatchObject({ purchasePriceMinor: 60_000, costPriceMinor: null, marginMinor: null, customs: null });
    expect((await C.get(`/products/${id2}`)).body).toMatchObject({ purchasePriceMinor: 60_000, costPriceMinor: 80_000, effectiveCostMinor: 80_000, marginMinor: 20_000, marginRatePct: 25, markPct: 20, customs: null });
    expect((await D.get(`/products/${id2}`)).body.customs).toMatchObject({ tnHsCode: '0084520', ddPct: 10 }); expect((await D.get(`/products/${id2}`)).body.purchasePriceMinor).toBe(60_000);
    const e = (await E.get(`/products/${id2}`)).body; expect(e.customs).toMatchObject({ ddPct: 10 }); expect(e.purchasePriceMinor).toBeNull();
    // modification : un éditeur sans droit d'achat ne peut pas toucher aux prix d'achat ; ni un utilisateur sans accès douane ne l'édite
    expect((await E.put(`/products/${id2}/prices`, { purchasePriceMinor: 1 })).status).toBe(403); expect((await E.put(`/products/${id2}/prices`, { salePriceMinor: 101_000 })).status).toBe(200); await E.put(`/products/${id2}/prices`, { salePriceMinor: 100_000 });
    expect((await E.put(`/products/${id2}/customs`, { ddPct: 12 })).status).toBe(200); await E.put(`/products/${id2}/customs`, { ddPct: 10 });
    expect((await E.post('/products', prod({ purchasePriceMinor: 5 }))).status).toBe(403); expect((await E.post('/products', prod({ purchasePriceMinor: 0 }))).status).toBe(403);
    expect((await P.put(`/products/${id2}/prices`, { purchasePriceMinor: 61_000 })).status).toBe(403); // products:update manquant
  });
  it('la fiche PDF et l’export respectent les permissions', async () => {
    const id2 = (await A.j.get('/products?q=MACH-0001')).body.items[0].id; const L = J((await login('lect@a.test')).token);
    const pdf = await api().get(`/api/v1/products/${id2}/pdf`).set(authed(A.token)).buffer().parse(binaryParser); expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toMatch(/pdf/); expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF'); expect(pdf.headers['content-disposition']).toContain('fiche-article-MACH-0001');
    const x = await api().get('/api/v1/products/export?format=xlsx').set(authed((await login('lect@a.test')).token)).buffer().parse(binaryParser); const rows = await parseXlsx(x.body as Buffer);
    expect(rows[0]).not.toContain('Prix d\'achat HT'); expect(rows[0]).not.toContain('Coût de revient'); expect(rows[0]).toContain('Prix de vente HT');
    const full = await parseXlsx(((await api().get('/api/v1/products/export?format=xlsx').set(authed(A.token)).buffer().parse(binaryParser)).body) as Buffer); expect(full[0]).toContain('Prix d\'achat HT'); expect(full[0]).toEqual(expect.arrayContaining(['Code article', 'Désignation', 'Catégorie', 'Sous-catégorie', 'Devise d\'achat', 'Coût d\'achat HT en DT', 'Coût de revient estimé', 'Stock disponible', 'Statut']));
    expect(full[0]).not.toContain('Marque'); expect(full[0]).not.toContain('Modèle');
    void L;
  });
  it('isolation multi-société sur tous les onglets ; identifiants invalides ; injection NoSQL', async () => {
    const id2 = (await A.j.get('/products?q=MACH-0001')).body.items[0].id;
    for (const path of ['', '/stock', '/transactions', '/documents', '/activities', '/pdf', '/photo', '/serials']) expect((await B.j.get(`/products/${id2}${path}`)).status, path).toBe(404);
    for (const [m, path, body] of [['put', '/prices', { salePriceMinor: 1 }], ['put', '/packaging', { lengthMm: 1 }], ['put', '/customs', { ddPct: 1 }], ['post', '/status', { status: 'blocked' }], ['post', '/activities', { kind: 'note', title: 'Intrusion' }], ['put', `/stock-settings/${B.w1}`, { minQty: 1 }]] as const) {
      const r = m === 'put' ? await B.j.put(`/products/${id2}${path}`, body) : await B.j.post(`/products/${id2}${path}`, body); expect(r.status, path).toBe(404);
    }
    expect((await B.j.get('/products/pas-un-id/stock')).status).toBe(422);
    for (const qs of ['status[$ne]=active', 'subCategoryId[$ne]=1', 'q[$regex]=.*', 'sort[$gt]=1', 'categoryId[$ne]=1', 'warehouseId[$ne]=1']) { const st = (await A.j.get(`/products?${qs}`)).status; expect([400, 422], qs).toContain(st); }
    expect([400, 422]).toContain((await A.j.post('/products', { ...prod(), name: { $ne: null } })).status); expect([400, 422]).toContain((await A.j.put(`/products/${id2}/customs`, { ddPct: { $gt: 0 } })).status);
    expect((await B.j.get('/products?q=MACH-0001')).body.items.every((x: { id: string }) => x.id !== id2)).toBe(true);
  });
});

describe('fiche article — duplication, import et export', () => {
  it('duplication : identité, packaging, prix et douane copiés ; ni stock, ni séries, ni documents, ni activités, ni coût de revient', async () => {
    const src = (await A.j.get('/products?q=MACH-0001')).body.items[0].id; await upload(A.token, src, PNG, 'photo.png', 'photo');
    const dup = await A.j.post(`/products/${src}/duplicate`, { reference: 'MACH-0001-B' }); expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    expect(dup.body).toMatchObject({ reference: 'MACH-0001-B', name: 'Machine industrielle (copie)', status: 'active', salePriceMinor: 100_000, minSalePriceMinor: 90_000, maxDiscountPct: 5, estimatedCostMinor: 65_000, costPriceMinor: null, hasPhoto: false, stockQty: 0 });
    expect(dup.body.packaging).toMatchObject({ lengthMm: 1200, volumeM3: 0.864 }); expect(dup.body.customs).toMatchObject({ tnHsCode: '0084520', ddPct: 10 });
    expect((await A.j.get(`/products/${dup.body.id}/documents`)).body.items).toEqual([]); expect((await A.j.get(`/products/${dup.body.id}/activities`)).body.items.map((x: { title: string }) => x.title)).toEqual(['Article créé (duplication)']);
    expect((await A.j.post(`/products/${src}/duplicate`, { reference: 'mach-0001-b' })).status).toBe(409); // code unique, insensible à la casse
  });
  it('modèle d’import : colonnes de la fiche ; import à blanc, erreurs par ligne et colonne, application atomique', async () => {
    const tpl = await api().get('/api/v1/products/import/template').set(authed(A.token)).buffer().parse(binaryParser); const rows = await parseXlsx(tpl.body as Buffer);
    expect(rows[0]).toEqual(expect.arrayContaining(['Catégorie', 'Sous-catégorie', 'Longueur (mm)', 'Largeur (mm)', 'Hauteur (mm)', 'Poids net (kg)', 'Poids brut (kg)', 'Type d\'emballage', 'Devise d\'achat', 'Code NGP fournisseur', 'Code NGP tunisien', 'DD (%)', 'FODEC (%)', 'RPD (%)', 'Pays d\'origine', 'Statut']));
    for (const h of ['Marque', 'Modèle', 'Nombre de colis']) expect(rows[0]).not.toContain(h);
    const head = 'Code article;Désignation;Unité;Code TVA;Prix de vente;Longueur (mm);Largeur (mm);Hauteur (mm);Poids net (kg);Poids brut (kg);Code NGP tunisien;DD (%);Devise d\'achat;Prix d\'achat en devise;Prix minimum de vente;Statut';
    const csv = (lines: string[], h = head) => Buffer.from(`\uFEFF${h}\n${lines.join('\n')}\n`, 'utf8');
    const post = (buf: Buffer, dry: boolean, mode = 'create') => api().post(`/api/v1/products/import?mode=${mode}&dryRun=${dry}`).set(authed(A.token)).attach('file', buf, 'import.csv');
    const good = 'IMP-1;Tour à métaux;PCE;T19;12500,000;1200;800;900;850,5;920;0084520;10;EUR;1000,50;11000;Bloqué';
    const dry = await post(csv([good]), true); expect(dry.body).toMatchObject({ total: 1, toCreate: 1, errors: [], applied: false }); expect(await Product.countDocuments({ companyId: A.companyId, reference: 'IMP-1' })).toBe(0);
    const bad = await post(csv([good.replace('IMP-1', 'IMP-2').replace('1200;800;900;850,5;920', '1200;800;;850,5;800'), 'IMP-3;Mauvais;PCE;T19;100;;;;;;ab$c;-5;;;200;Inconnu']), true);
    const msgs = bad.body.errors.map((e: { row: number; field: string; message: string }) => `${e.row}:${e.field}`); expect(msgs, JSON.stringify(bad.body.errors)).toEqual(expect.arrayContaining(['2:lengthMm', '2:packaging', '3:hsTn', '3:dd', '3:minSale', '3:status'])); expect(bad.body.applied).toBe(false);
    const applied = await post(csv([good]), false); expect(applied.body).toMatchObject({ created: 1, applied: true, warnings: [] }); const p = (await A.j.get('/products?q=IMP-1')).body.items[0];
    expect(p, JSON.stringify(p)).toMatchObject({ status: 'blocked', salePriceMinor: 12_500_000, minSalePriceMinor: 11_000_000, purchaseCurrency: 'EUR', purchasePriceForeignMinor: 100_050, purchaseRate: null, purchasePriceMinor: null, estimatedPurchaseMinor: 3_501_750 });
    const full = (await A.j.get(`/products/${p.id}`)).body; expect(full.packaging).toMatchObject({ volumeM3: 0.864, netWeightKg: 850.5, grossWeightKg: 920 }); expect(full.customs).toMatchObject({ tnHsCode: '0084520', ddPct: 10 });
    expect((await post(csv([good]), false)).body.errors[0].message).toMatch(/existe déjà/); // mode création : doublon refusé
    // anciennes colonnes : ignorées et signalées ; colonnes absentes ou vides : rien n'est écrasé
    const up = await post(csv(['IMP-1;Tour à métaux v2;PCE;T19;Optimum;TH-1;3'], 'Code article;Désignation;Unité;Code TVA;Marque;Modèle;Nombre de colis'), false, 'upsert');
    expect(up.body.updated).toBe(1); expect(up.body.warnings.join(' ')).toMatch(/Marque, Modèle, Nombre de colis/);
    const after = (await A.j.get(`/products/${p.id}`)).body;
    expect(after).toMatchObject({ name: 'Tour à métaux v2', status: 'blocked', salePriceMinor: 12_500_000, purchasePriceForeignMinor: 100_050, estimatedPurchaseMinor: 3_501_750 });
    expect((await Product.findById(p.id).lean())!.brand).toBeUndefined();
    expect(await Product.countDocuments({ companyId: A.companyId, reference: /^IMP-/i })).toBe(1); // les erreurs n'ont rien laissé : tout ou rien
    expect((await stockQty(p.id)).qty).toBe(0); // l'import n'écrit aucun stock
  });
  it('export CSV : formules neutralisées, filtres respectés, colonnes de la fiche', async () => {
    const e = await A.j.post('/products', prod({ reference: 'EXP-F', name: '=HYPERLINK("http://evil")', description: '+cmd' })); expect(e.status).toBe(201);
    const csv = (await api().get('/api/v1/products/export?format=csv&q=EXP-F').set(authed(A.token)).buffer().parse(binaryParser)).body.toString('utf8'); expect(csv).toContain("'=HYPERLINK"); expect(csv.split('\n').filter(Boolean)).toHaveLength(2);
    expect(csv).toContain('Code article;Désignation;Type;Catégorie;Sous-catégorie');
  });
});

describe('migration des anciens articles', () => {
  it('statut dérivé de isActive ; données, identifiants et relations conservés ; idempotente ; simulation sans écriture', async () => {
    const col = mongoose.connection.db!.collection('products'); const company = new mongoose.Types.ObjectId(); const t = (d: number) => new Date(Date.UTC(2026, 0, d));
    const unit = new mongoose.Types.ObjectId(); const sup = new mongoose.Types.ObjectId();
    const old = await col.insertMany([
      { companyId: company, reference: 'OLD-1', name: 'Ancien actif', kind: 'product', unitId: unit, purchasePriceMinor: 1000, salePriceMinor: 2000, costPriceMinor: 1500, vatRateCode: 'T19', minStock: 3, mainSupplierId: sup, hasSerial: true, isActive: true, createdAt: t(1), updatedAt: t(1), __v: 0 },
      { companyId: company, reference: 'OLD-2', name: 'Ancien inactif', kind: 'product', unitId: unit, purchasePriceMinor: 0, salePriceMinor: 500, vatRateCode: 'T19', minStock: 0, isActive: false, createdAt: t(2), updatedAt: t(2), __v: 0 },
    ]); const ids = Object.values(old.insertedIds);
    const dry = await migrateProducts({ dryRun: true }); expect(dry).toMatchObject({ dryRun: true, statusSet: 2 }); expect((await col.findOne({ _id: ids[0] }))!.status).toBeUndefined();
    const r = await migrateProducts(); expect(r).toMatchObject({ statusSet: 2, activitiesCreated: 2, dryRun: false });
    expect(await col.findOne({ _id: ids[0] })).toMatchObject({ status: 'active', isActive: true, reference: 'OLD-1', name: 'Ancien actif', purchasePriceMinor: 1000, salePriceMinor: 2000, costPriceMinor: 1500, minStock: 3, hasSerial: true, vatRateCode: 'T19' });
    expect(await col.findOne({ _id: ids[1] })).toMatchObject({ status: 'inactive', isActive: false }); expect((await col.findOne({ _id: ids[0] }))!._id.toString()).toBe(ids[0]!.toString()); expect((await col.findOne({ _id: ids[0] }))!.brand).toBeUndefined(); // aucun champ inventé
    const before = JSON.stringify(await col.find({ companyId: company }).sort({ _id: 1 }).toArray()); expect(await migrateProducts()).toMatchObject({ statusSet: 0, activitiesCreated: 0 }); expect(JSON.stringify(await col.find({ companyId: company }).sort({ _id: 1 }).toArray())).toBe(before);
    expect(await ProductActivity.countDocuments({ companyId: company })).toBe(2);
    const listed = await Product.find({ companyId: company, status: 'inactive' }).lean(); expect(listed).toHaveLength(1);
  });
});

describe('fiche article — export des transactions', () => {
  it('export Excel / CSV des transactions selon les permissions, filtres respectés, audité', async () => {
    const t = (await A.j.get('/products?q=TX-1')).body.items[0].id;
    const x = await api().get(`/api/v1/products/${t}/transactions/export?format=xlsx&group=sales`).set(authed(A.token)).buffer().parse(binaryParser); expect(x.status).toBe(200); expect(x.headers['content-disposition']).toMatch(/transactions-TX-1/);
    const rows = await parseXlsx(x.body as Buffer); expect(rows[0]).toEqual(['Type', 'N° document', 'Date', 'Client', 'Fournisseur', 'Quantité', 'Prix unitaire', 'Devise', 'Total', 'Entrepôt', 'Statut']); expect(rows.length).toBeGreaterThan(1); expect(rows.slice(1).every((r) => ['Devis', 'Facture de vente', 'Bon de livraison', 'Avoir', 'Facture proforma'].includes(r[0]!))).toBe(true);
    const O = (await login('seul@a.test')).token; const none = await parseXlsx(((await api().get(`/api/v1/products/${t}/transactions/export?format=xlsx`).set(authed(O)).buffer().parse(binaryParser)).body) as Buffer); expect(none).toHaveLength(1); // aucune ligne : aucune permission de module
    expect((await api().get(`/api/v1/products/${t}/transactions/export?format=csv&bad=1`).set(authed(A.token))).status).toBeGreaterThanOrEqual(400); expect((await B.j.get(`/products/${t}/transactions/export?format=csv`)).status).toBe(404);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'product', action: 'export' })).toBeGreaterThan(0);
  });
});
