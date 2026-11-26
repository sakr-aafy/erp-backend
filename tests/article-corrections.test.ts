/**
 * Corrections de la fiche article : recherche d'articles, sélecteur de fournisseurs, catégories à deux niveaux,
 * champs supprimés, dimensions et poids, taux de change estimatif (séparé des taux réels), migration.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, authed, binaryParser, login, makeUser, parseXlsx, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, costOf, levelOf, logisticsCompany, stockIn, stockOut, type LCtx } from './sales.helpers.js';
import { Category, Product } from '../src/models/product.model.js';
import { Supplier } from '../src/models/supplier.model.js';
import { Setting } from '../src/models/setting.model.js';
import { ExchangeRate } from '../src/models/logistics.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { migrateArticles } from '../src/modules/products/article.migration.js';

let A: LCtx, B: LCtx;
beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); });
afterAll(async () => { await teardownDb(); });

const col = (name: string) => mongoose.connection.db!.collection(name);
let seq = 0;
const body = (c: LCtx, extra: object = {}) => ({ reference: `ART-${++seq}`, name: `Article ${seq}`, unitId: c.unitId, vatRateCode: 'T19', salePriceMinor: 1_000_000, ...extra });
const mk = async (extra: object = {}, c: LCtx = A) => { const r = await c.j.post('/products', body(c, extra)); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const eur = (foreign: number, extra: object = {}) => ({ purchaseCurrency: 'EUR', purchasePriceForeignMinor: foreign, ...extra });
const cat = async (name: string, parentId?: string, c: LCtx = A) => { const r = await c.j.post('/product-categories', { name, ...(parentId && { parentId }) }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; };
const refs = (r: { body: { items: { reference: string }[] } }) => r.body.items.map((x) => x.reference);
const text = async (url: string, c: LCtx = A) => { const r = await request(app).get(`/api/v1${url}`).set(authed(c.token)).buffer().parse(binaryParser); expect(r.status).toBe(200); return r.body as Buffer; };

describe('recherche d’article (suggestions)', () => {
  let family = ''; let sub = '';
  beforeAll(async () => {
    family = await cat('Optimum'); sub = await cat('Perceuse', family);
    await mk({ reference: 'SUG-PERC', name: 'Machine à percer', categoryId: family, subCategoryId: sub });
    await mk({ reference: 'SUG-TOUR', name: 'Tour à métaux', categoryId: family });
    for (let i = 0; i < 20; i++) await mk({ reference: `PAG-${String(i).padStart(2, '0')}`, name: `Pièce ${i}` });
    await mk({ reference: 'SECRET-B', name: 'Article de Beta' }, B);
  });
  it('sans saisie : première page paginée, jamais toute la collection', async () => {
    const r = await A.j.get('/products/suggest');
    expect(r.status).toBe(200); expect(r.body.items).toHaveLength(15); expect(r.body.total).toBeGreaterThan(15);
    expect(r.body.items[0]).toEqual(expect.objectContaining({ id: expect.any(String), reference: expect.any(String), name: expect.any(String) }));
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['familyId', 'familyName', 'id', 'kind', 'mainPhotoId', 'name', 'reference', 'subId', 'subName']);
    const p2 = await A.j.get('/products/suggest?page=2'); expect(p2.body.items.length).toBeGreaterThan(0);
    expect(refs(p2).some((x) => refs(r).includes(x))).toBe(false);
    expect((await A.j.get('/products/suggest?limit=500')).status).toBe(422);
  });
  it('recherche par code, désignation, catégorie et sous-catégorie ; absence de résultat', async () => {
    expect(refs(await A.j.get('/products/suggest?q=sug-perc'))).toEqual(['SUG-PERC']);
    expect(refs(await A.j.get('/products/suggest?q=m%C3%A9taux'))).toEqual(['SUG-TOUR']);
    expect(refs(await A.j.get('/products/suggest?q=optimum'))).toEqual(['SUG-PERC', 'SUG-TOUR']);
    const bySub = await A.j.get('/products/suggest?q=perceuse'); expect(refs(bySub)).toEqual(['SUG-PERC']);
    expect(bySub.body.items[0]).toMatchObject({ familyName: 'Optimum', subName: 'Perceuse' });
    expect((await A.j.get('/products/suggest?q=introuvable')).body).toMatchObject({ items: [], total: 0 });
    expect((await A.j.get('/products/suggest?q=.*')).body.items).toEqual([]); // texte jamais interprété
  });
  it('filtres de la liste respectés ; sélection : le tableau est filtré sur l’article', async () => {
    expect(refs(await A.j.get(`/products/suggest?subCategoryId=${sub}`))).toEqual(['SUG-PERC']);
    const id = (await A.j.get('/products/suggest?q=SUG-TOUR')).body.items[0].id as string;
    expect(refs(await A.j.get(`/products?productId=${id}`))).toEqual(['SUG-TOUR']);
    expect((await A.j.get('/products?q=m%C3%A9taux')).body.total).toBe(1); // recherche textuelle sans sélection
    expect(refs(await A.j.get('/products?q=perceuse'))).toEqual(['SUG-PERC']); // par sous-catégorie
  });
  it('isolation multi-société et permissions', async () => {
    expect(refs(await A.j.get('/products/suggest?q=Beta'))).toEqual([]);
    expect(refs(await B.j.get('/products/suggest'))).not.toContain('SUG-PERC');
    const otherId = (await B.j.get('/products/suggest?q=SECRET')).body.items[0].id as string;
    expect((await A.j.get(`/products?productId=${otherId}`)).body.items).toEqual([]);
    expect((await request(app).get('/api/v1/products/suggest')).status).toBe(401);
    await makeUser(A.companyId, 'sansart@a.test', ['customers:view']);
    expect((await J((await login('sansart@a.test')).token).get('/products/suggest')).status).toBe(403);
  });
});

describe('fournisseurs : sélecteur et fournisseur habituel', () => {
  let target = ''; let archived = ''; let other = '';
  beforeAll(async () => {
    for (let i = 0; i < 125; i++) await A.j.post('/suppliers', { name: `Fourn ${String(i).padStart(3, '0')}`, taxId: `TAX-${i}` });
    target = (await A.j.post('/suppliers', { name: 'Zénith Outillage', tradeName: 'ZénithPro', taxId: '7654321/Z' })).body.id;
    archived = (await A.j.post('/suppliers', { name: 'Ancien Partenaire', taxId: 'OLD-9' })).body.id;
    other = (await B.j.post('/suppliers', { name: 'Fournisseur de Beta', taxId: 'BETA-1' })).body.id;
  });
  it('code attribué automatiquement ; liste initiale paginée sans plafond à 100', async () => {
    const t = (await A.j.get(`/suppliers/${target}`)).body; expect(t.code).toMatch(/^FR-\d{5}$/); expect(t.tradeName).toBe('ZénithPro');
    const first = (await A.j.get('/suppliers?limit=20&status=active')).body; expect(first.items).toHaveLength(20); expect(first.total).toBeGreaterThan(125);
    const last = (await A.j.get(`/suppliers?limit=20&status=active&page=${Math.ceil(first.total / 20)}`)).body; expect(last.items.length).toBeGreaterThan(0);
    expect(last.items.map((s: { name: string }) => s.name)).toContain('Zénith Outillage'); // au-delà des 100 premiers
    const codes = new Set((await Supplier.find({ companyId: A.companyId }).lean()).map((s) => s.code)); expect(codes.size).toBe(first.total);
  });
  it('recherche par code, raison sociale, nom commercial et matricule fiscal', async () => {
    const code = (await A.j.get(`/suppliers/${target}`)).body.code as string;
    for (const q of [code, 'zénith outil', 'ZénithPro', '7654321']) expect((await A.j.get(`/suppliers?q=${encodeURIComponent(q)}`)).body.items.map((s: { id: string }) => s.id), q).toContain(target);
    expect((await A.j.get('/suppliers?q=Beta')).body.items).toEqual([]);
  });
  it('association, persistance, filtre des articles, retrait', async () => {
    const p = await mk({ mainSupplierId: target });
    expect((await A.j.get(`/products/${p.id}`)).body).toMatchObject({ mainSupplierId: target, mainSupplierName: 'Zénith Outillage', mainSupplierArchived: false });
    expect((await A.j.get(`/products?supplierId=${target}`)).body.items.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect(refs(await A.j.get('/products?q=Z%C3%A9nithPro'))).toEqual([p.reference]);
    expect((await A.j.put(`/products/${p.id}/prices`, { mainSupplierId: null })).body.mainSupplierId).toBeNull();
  });
  it('fournisseur d’une autre société refusé ; archivé non associable mais conservé sur les articles existants', async () => {
    expect((await A.j.post('/products', body(A, { mainSupplierId: other }))).status).toBe(400);
    const p = await mk({ mainSupplierId: archived });
    await A.j.post(`/suppliers/${archived}/archive`);
    expect((await A.j.get('/suppliers?status=active&q=Ancien')).body.items).toEqual([]);
    expect((await A.j.get(`/products/${p.id}`)).body).toMatchObject({ mainSupplierId: archived, mainSupplierArchived: true });
    expect((await A.j.put(`/products/${p.id}`, { name: 'Renommé', mainSupplierId: archived })).status).toBe(200); // ancienne association conservée
    const q = await mk(); const r = await A.j.put(`/products/${q.id}/prices`, { mainSupplierId: archived }); expect(r.status).toBe(400); expect(r.body.error.message).toMatch(/archivé/);
    expect((await A.j.post('/products', body(A, { mainSupplierId: archived }))).status).toBe(400);
    expect((await A.j.post(`/products/${p.id}/duplicate`, { reference: 'DUP-ARCH' })).body.mainSupplierId).toBeNull();
  });
});

describe('catégories et sous-catégories', () => {
  let optimum = ''; let metal = ''; let perceuse = ''; let tour = '';
  beforeAll(async () => { await Category.deleteMany({ companyId: A.companyId }); });
  it('création à deux niveaux ; doublons refusés au même niveau, même nom autorisé sous deux parents ; pas de 3e niveau', async () => {
    optimum = await cat('Optimum'); metal = await cat('Metallkraft');
    perceuse = await cat('Perceuse', optimum); tour = await cat('Tour', optimum); await cat('Presse', metal);
    for (const dup of [{ name: 'optimum' }, { name: 'PERCEUSE', parentId: optimum }]) expect((await A.j.post('/product-categories', dup)).status, dup.name).toBe(409);
    expect((await A.j.post('/product-categories', { name: 'Perceuse', parentId: metal })).status).toBe(201);
    const third = await A.j.post('/product-categories', { name: 'Niveau 3', parentId: perceuse }); expect(third.status).toBe(400); expect(third.body.error.message).toMatch(/deux niveaux/i);
    expect((await B.j.post('/product-categories', { name: 'Intrus', parentId: optimum })).status).toBe(400);
    expect((await B.j.post('/product-categories', { name: 'Optimum' })).status).toBe(201); // autre société
    expect((await A.j.put(`/product-categories/${tour}`, { name: 'Perceuse' })).status).toBe(409);
    expect((await A.j.put(`/product-categories/${tour}`, { name: 'Tour à métaux' })).body).toMatchObject({ name: 'Tour à métaux', parentId: optimum });
    expect((await A.j.put(`/product-categories/${tour}`, { name: 'Tour', parentId: metal })).status).toBe(422); // pas de déplacement : aucune boucle possible
    expect((await B.j.put(`/product-categories/${tour}`, { name: 'x' })).status).toBe(404);
  });
  it('article : catégorie + sous-catégorie cohérentes, vérifiées par le serveur', async () => {
    const p = await mk({ categoryId: optimum, subCategoryId: perceuse });
    expect(p).toMatchObject({ familyId: optimum, familyName: 'Optimum', subId: perceuse, subName: 'Perceuse' });
    expect((await A.j.post('/products', body(A, { categoryId: metal, subCategoryId: perceuse }))).status).toBe(400);
    expect((await A.j.post('/products', body(A, { subCategoryId: perceuse }))).status).toBe(400);
    expect((await A.j.post('/products', body(A, { categoryId: optimum, subCategoryId: metal }))).status).toBe(400);
    // changement de catégorie sans sous-catégorie : l'ancienne est retirée
    expect((await A.j.put(`/products/${p.id}`, { categoryId: metal, subCategoryId: null })).body).toMatchObject({ familyId: metal, subId: null });
    expect((await A.j.put(`/products/${p.id}`, { subCategoryId: perceuse })).status).toBe(400); // incompatible avec Metallkraft
    expect((await A.j.put(`/products/${p.id}`, { categoryId: optimum, subCategoryId: tour })).body.subId).toBe(tour);
    expect((await A.j.put(`/products/${p.id}`, { subCategoryId: null })).body).toMatchObject({ familyId: optimum, subId: null }); // sans sous-catégorie : permis
    expect((await A.j.put(`/products/${p.id}`, { categoryId: optimum, subCategoryId: perceuse })).status).toBe(200);
  });
  it('filtres, recherche, compteurs réels et export de la hiérarchie', async () => {
    await mk({ categoryId: optimum });
    const list = (await A.j.get('/product-categories')).body as { id: string; productCount: number; totalProductCount: number }[];
    expect(list.find((c) => c.id === optimum)).toMatchObject({ productCount: 1, totalProductCount: 2 }); expect(list.find((c) => c.id === perceuse)).toMatchObject({ productCount: 1 });
    expect((await A.j.get(`/products?categoryId=${optimum}`)).body.total).toBe(2); expect((await A.j.get(`/products?subCategoryId=${perceuse}`)).body.total).toBe(1);
    expect((await A.j.get(`/products?categoryId=${metal}&subCategoryId=${perceuse}`)).body.total).toBe(0);
    const rows = await parseXlsx(await text('/products/export?format=xlsx'));
    const cI = rows[0]!.indexOf('Catégorie'); const sI = rows[0]!.indexOf('Sous-catégorie');
    expect(rows.map((r) => `${r[cI] ?? ''}>${r[sI] ?? ''}`)).toEqual(expect.arrayContaining(['Optimum>Perceuse', 'Optimum>']));
  });
  it('suppression protégée, archivage explicite, réactivation ; les articles ne sont jamais modifiés', async () => {
    for (const id of [optimum, perceuse]) { const r = await A.j.del(`/product-categories/${id}`); expect(r.status).toBe(409); expect(r.body.error.code).toBe('CATEGORY_IN_USE'); }
    const before = JSON.stringify(await col('products').find({ companyId: A.companyId }).sort({ _id: 1 }).toArray());
    expect((await A.j.post(`/product-categories/${optimum}/archive`)).status).toBe(200);
    const list = (await A.j.get('/product-categories')).body as { id: string; isArchived: boolean }[];
    expect(list.filter((c) => [optimum, perceuse, tour].includes(c.id)).every((c) => c.isArchived)).toBe(true);
    expect(JSON.stringify(await col('products').find({ companyId: A.companyId }).sort({ _id: 1 }).toArray())).toBe(before);
    expect((await A.j.post('/products', body(A, { categoryId: optimum }))).status).toBe(400);
    expect((await A.j.post('/product-categories', { name: 'Nouvelle', parentId: optimum })).status).toBe(409);
    const existing = (await A.j.get(`/products?subCategoryId=${perceuse}`)).body.items[0];
    expect((await A.j.put(`/products/${existing.id}`, { name: 'Toujours rattaché', categoryId: optimum, subCategoryId: perceuse })).status).toBe(200);
    expect((await A.j.post(`/product-categories/${perceuse}/restore`)).status).toBe(409); // parent d'abord
    expect((await A.j.post(`/product-categories/${optimum}/restore`)).status).toBe(200); expect((await A.j.post(`/product-categories/${perceuse}/restore`)).status).toBe(200);
    const empty = await cat('Vide'); expect((await A.j.del(`/product-categories/${empty}`)).status).toBe(204);
    await makeUser(A.companyId, 'catview@a.test', ['products:view']); const v = J((await login('catview@a.test')).token);
    expect((await v.post(`/product-categories/${metal}/archive`)).status).toBe(403); expect((await B.j.post(`/product-categories/${metal}/archive`)).status).toBe(404);
  });
  it('import : relations validées', async () => {
    const head = 'Référence;Désignation;Unité;Code TVA;Catégorie;Sous-catégorie';
    const post = (lines: string[]) => request(app).post('/api/v1/products/import?mode=create&dryRun=false').set(authed(A.token)).attach('file', Buffer.from(`${head}\n${lines.join('\n')}\n`), 'i.csv');
    const bad = await post(['IMPC-1;Article;PCE;T19;Metallkraft;Tour', 'IMPC-2;Article;PCE;T19;;Perceuse', 'IMPC-3;Article;PCE;T19;Inconnue;']);
    expect(bad.body.applied).toBe(false); expect(bad.body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`)).toEqual(['2:subFamily', '3:subFamily', '4:family']);
    const ok = await post(['IMPC-4;Article;PCE;T19;optimum;perceuse']); expect(ok.body).toMatchObject({ applied: true, created: 1 });
    expect((await A.j.get('/products?q=IMPC-4')).body.items[0]).toMatchObject({ subId: perceuse, familyId: optimum });
  });
});

describe('champs supprimés : marque, modèle, colis', () => {
  it('refusés par l’API, absents des réponses, PDF et exports ; anciennes valeurs conservées', async () => {
    for (const extra of [{ brand: 'X' }, { model: 'Y' }, { packaging: { parcelCount: 2 } }, { packaging: { dimensionsPerParcel: true } }]) expect((await A.j.post('/products', body(A, extra))).status, JSON.stringify(extra)).toBe(422);
    const p = await mk({ packaging: { lengthMm: 910, widthMm: 382, heightMm: 710 } });
    await col('products').updateOne({ _id: new mongoose.Types.ObjectId(p.id) }, { $set: { brand: 'MarqueAncienne', model: 'ModeleAncien' } });
    const u = await A.j.put(`/products/${p.id}`, { name: 'Mis à jour' }); expect(u.body).not.toHaveProperty('brand'); expect(u.body).not.toHaveProperty('model');
    expect(await col('products').findOne({ _id: new mongoose.Types.ObjectId(p.id) })).toMatchObject({ brand: 'MarqueAncienne', model: 'ModeleAncien' });
    expect((await A.j.get('/products?q=MarqueAncienne')).body.items).toEqual([]);
    const pdf = pdfText(await text(`/products/${p.id}/pdf`));
    expect(pdf).toContain('Dimensions et Poids'); expect(pdf).toContain('0,2468102'); expect(pdf).toContain('Volume total');
    for (const gone of ['Marque\n', 'Modèle\n', 'MarqueAncienne', 'colis', 'Packaging']) expect(pdf).not.toContain(gone);
    expect((await text('/products/export?format=csv')).toString('utf8')).not.toMatch(/Marque|Mod[eè]le|MarqueAncienne|colis/i);
    expect((await A.j.get('/products/brands')).status).toBe(422); // ancienne route retirée
  });
  it('service : aucune dimension exposée ni imposée', async () => {
    const s = await mk({ kind: 'service' }); expect(s.packaging).toBeNull();
  });
  it('ancienne saisie par colis : signalée, jamais convertie ; levée par confirmation ou nouvelles dimensions', async () => {
    const p = await mk({ packaging: { lengthMm: 910, widthMm: 382, heightMm: 710, netWeightKg: 107, grossWeightKg: 118 } });
    const oid = new mongoose.Types.ObjectId(p.id);
    const legacy = () => col('products').updateOne({ _id: oid }, { $set: { 'packaging.parcelCount': 3, 'packaging.dimensionsPerParcel': true, 'packaging.totalVolumeM3': 0.7404306 }, $unset: { 'packaging.reviewedAt': 1 } });
    await legacy();
    expect((await A.j.get(`/products/${p.id}`)).body.packaging).toMatchObject({ volumeM3: 0.2468102, review: { parcelCount: 3, previousTotalM3: 0.7404306 } });
    expect((await A.j.put(`/products/${p.id}/packaging`, { grossWeightKg: 120 })).body.packaging.review).not.toBeNull(); // un autre champ ne lève pas l'alerte
    const dossier = await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', exchangeRate: 3.4, lines: [{ productId: p.id, quantity: 1, unitPriceMinor: 100 }] });
    expect(dossier.body.lines[0].packaging).toMatchObject({ unitVolumeM3: 0.2468102, parcelCount: 3 });
    expect((await A.j.put(`/products/${p.id}/packaging`, { confirmDimensions: true })).body.packaging.review).toBeNull();
    const kept = await col('products').findOne({ _id: oid }); expect(kept!.packaging).toMatchObject({ parcelCount: 3, totalVolumeM3: 0.7404306 }); // historique conservé
    await legacy();
    expect((await A.j.put(`/products/${p.id}/packaging`, { heightMm: 720 })).body.packaging).toMatchObject({ review: null, volumeM3: 0.2502864 });
    const d2 = await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', exchangeRate: 3.4, lines: [{ productId: p.id, quantity: 1, unitPriceMinor: 100 }] });
    expect(d2.body.lines[0].packaging.parcelCount ?? null).toBeNull();
    expect((await A.j.get(`/imports/${dossier.body.id}`)).body.lines[0].packaging.unitVolumeM3).toBe(0.2468102); // dossier existant inchangé
  });
});

describe('taux de change estimatif', () => {
  it('prix en EUR enregistré sans aucun taux réel : 1 € = 3,5 DT, précision des devises respectée', async () => {
    expect(await ExchangeRate.countDocuments({ companyId: B.companyId })).toBe(0);
    for (const [cents, millimes] of [[10_000, 350_000], [25_000, 875_000], [100_000, 3_500_000], [250_000, 8_750_000], [12_345, 432_075], [1, 35]] as const) {
      const p = await mk(eur(cents), B);
      expect(p, `${cents}`).toMatchObject({ estimateRate: 3.5, estimatedPurchaseMinor: millimes, estimatedCostValueMinor: millimes, effectiveCostMinor: millimes, purchasePriceMinor: null, purchaseRate: null, costPriceMinor: null });
      expect((await B.j.get(`/products/${p.id}`)).body.estimatedPurchaseMinor).toBe(millimes);
    }
    expect(await ExchangeRate.countDocuments({ companyId: B.companyId })).toBe(0); // jamais inséré dans les taux réels
  });
  it('le client ne peut pas imposer de contre-valeur ; TND sans conversion ; autres devises inchangées', async () => {
    const p = await mk(eur(10_000, { purchasePriceMinor: 1 }), B);
    expect(p.estimatedPurchaseMinor).toBe(350_000); expect((await Product.findById(p.id).lean())!.purchasePriceMinor).toBe(0);
    expect((await B.j.put(`/products/${p.id}/prices`, { purchasePriceMinor: 999 })).body.purchasePriceMinor).toBeNull();
    for (const forged of [{ estimatedPurchaseMinor: 1 }, { estimateRate: 1 }, { purchaseRate: 3.5 }]) expect((await B.j.put(`/products/${p.id}/prices`, forged)).status).toBe(422);
    const tnd = await mk({ purchasePriceMinor: 100_000 }, B); expect(tnd).toMatchObject({ purchasePriceMinor: 100_000, estimateRate: null, estimatedPurchaseMinor: null, effectiveCostMinor: 100_000 });
    await B.j.put('/settings', { currencies: [{ code: 'TND', name: 'Dinar', symbol: 'DT', decimals: 3 }, { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 }, { code: 'USD', name: 'Dollar', symbol: '$', decimals: 2 }] });
    const usd = await B.j.post('/products', body(B, { purchaseCurrency: 'USD', purchasePriceForeignMinor: 100 })); expect(usd.status).toBe(400); expect(usd.body.error.message).toMatch(/taux de change USD/);
    await B.j.post('/exchange-rates', { currency: 'USD', date: '2020-01-01', rate: 3.1 });
    expect(await mk({ purchaseCurrency: 'USD', purchasePriceForeignMinor: 10_000 }, B)).toMatchObject({ purchaseRate: 3.1, purchasePriceMinor: 310_000, estimateRate: null, estimatedPurchaseMinor: null });
  });
  it('coût estimé personnalisé conservé ; marges estimées ; aperçu du serveur', async () => {
    const p = await mk(eur(10_000, { estimatedCostMinor: 420_000, salePriceMinor: 700_000 }), B);
    expect(p).toMatchObject({ estimatedPurchaseMinor: 350_000, estimatedCostMinor: 420_000, estimatedCostValueMinor: 420_000, effectiveCostMinor: 420_000, marginMinor: 280_000 });
    const u = await B.j.put(`/products/${p.id}/prices`, { purchaseCurrency: 'EUR', purchasePriceForeignMinor: 20_000 });
    expect(u.body).toMatchObject({ estimatedPurchaseMinor: 700_000, estimatedCostMinor: 420_000, estimatedCostValueMinor: 420_000 }); // jamais écrasé
    expect((await B.j.put(`/products/${p.id}/prices`, { estimatedCostMinor: null })).body).toMatchObject({ estimatedCostMinor: null, estimatedCostValueMinor: 700_000, marginMinor: 0 });
    const pv = await B.j.post('/products/pricing-preview', { salePriceMinor: 700_000, vatRateCode: 'T19', purchaseCurrency: 'EUR', purchasePriceForeignMinor: 10_000 });
    expect(pv.body).toMatchObject({ estimateRate: 3.5, estimatedPurchaseMinor: 350_000, estimatedCostMinor: 350_000 }); expect(pv.body.margins.marginHtMinor).toBe(350_000);
    expect((await B.j.post('/products/pricing-preview', { purchaseCurrency: 'EUR', purchasePriceForeignMinor: 100_000 })).body.estimatedPurchaseMinor).toBe(3_500_000); // avant le choix de la TVA
    expect((await B.j.get('/products?belowCost=true')).body.items.map((x: { id: string }) => x.id)).not.toContain(p.id);
    await B.j.put(`/products/${p.id}/prices`, { salePriceMinor: 600_000 });
    expect((await B.j.get('/products?belowCost=true')).body.items.map((x: { id: string }) => x.id)).toContain(p.id);
  });
  it('tri par prix d’achat sur la valeur en dinars ; export distinct', async () => {
    await Product.deleteMany({ companyId: B.companyId });
    const cheap = await mk({ purchasePriceMinor: 100_000 }, B); const mid = await mk(eur(10_000), B); const high = await mk({ purchasePriceMinor: 900_000 }, B);
    expect((await B.j.get('/products?sort=purchasePriceMinor')).body.items.map((x: { id: string }) => x.id)).toEqual([cheap.id, mid.id, high.id]);
    expect((await B.j.get('/products?sort=-purchasePriceMinor')).body.items.map((x: { id: string }) => x.id)).toEqual([high.id, mid.id, cheap.id]);
    const rows = await parseXlsx(await text('/products/export?format=xlsx', B)); const at = (h: string) => rows[0]!.indexOf(h);
    const line = rows.find((r) => r[0] === mid.reference)!;
    expect(line[at('Prix d\'achat HT')] ?? '').toBe(''); expect(Number(line[at('Prix d\'achat en devise')])).toBe(100); expect(Number(line[at('Contre-valeur estimée')])).toBe(350);
    const pdf = pdfText(await text(`/products/${mid.id}/pdf`, B)); expect(pdf).toContain('1 EUR = 3.5 TND'); expect(pdf).toContain('350.000');
  });
  it('modification du paramètre : réservée, auditée, appliquée à l’estimation seulement', async () => {
    const p = await mk(eur(10_000), B);
    await makeUser(B.companyId, 'commercial@b.test', ['products:view', 'products:update', 'settings:view']);
    const u = J((await login('commercial@b.test')).token);
    expect((await u.put('/settings/estimate-rates', { currency: 'EUR', rate: 4 })).status).toBe(403);
    expect((await B.j.put('/settings', { estimateRates: [{ currency: 'EUR', targetCurrency: 'TND', rate: 9 }] })).status).toBe(422);
    for (const bad of [{ currency: 'EUR', rate: 0 }, { currency: 'EUR', rate: -1 }, { currency: 'USD', rate: 3 }]) expect([400, 422]).toContain((await B.j.put('/settings/estimate-rates', bad)).status);
    const ok = await B.j.put('/settings/estimate-rates', { currency: 'EUR', rate: 3.6 }); expect(ok.status).toBe(200);
    expect((await B.j.get('/settings/reference')).body.estimateRates).toEqual([{ currency: 'EUR', targetCurrency: 'TND', rate: 3.6 }]);
    expect((await B.j.get(`/products/${p.id}`)).body).toMatchObject({ estimateRate: 3.6, estimatedPurchaseMinor: 360_000 });
    expect((await A.j.get('/settings/reference')).body.estimateRates[0].rate).toBe(3.5); // autre société inchangée
    const log = await AuditLog.findOne({ companyId: B.companyId, resource: 'estimate-rate' }).lean(); expect(log!.meta).toMatchObject({ currency: 'EUR', from: 3.5, to: 3.6 });
    await B.j.put('/settings/estimate-rates', { currency: 'EUR', rate: 3.5 });
  });
});

describe('séparation absolue : le taux estimatif n’entre dans aucune opération réelle', () => {
  let p = ''; let C: LCtx;
  const get = async () => (await C.j.get(`/products/${p}`)).body;
  const orderLine = () => ({ supplierId: C.supplierId, lines: [{ productId: p, quantity: 2 }] });
  beforeAll(async () => { C = await logisticsCompany('Gamma', 'admin@c.test'); p = (await mk(eur(10_000), C)).id; });

  it('sans taux réel : commande, importation, stock et rapports refusent ou ignorent — jamais 3,5', async () => {
    const po = await C.j.post('/purchase-orders', orderLine()); expect(po.status).toBe(400); expect(po.body.error.message).toMatch(/taux de change EUR.*saisissez le prix unitaire/);
    const imp = await C.j.post('/imports', { supplierId: C.foreignSupplierId, currency: 'EUR', lines: [{ productId: p, quantity: 1, unitPriceMinor: 10_000 }] }); expect(imp.status).toBe(400); expect(imp.body.error.message).toMatch(/taux de change/i);
    const forced = await stockOut(C, p, 1, C.w1, { allowNegativeStock: true }); expect(forced.status).toBe(400); expect(forced.body.error.message).toMatch(/taux de change/i);
    const inv = (await C.j.post('/inventories', { warehouseId: C.w2 })).body;
    await C.j.put(`/inventories/${inv.id}`, { reason: 'Comptage', lines: [{ productId: p, countedQty: 2 }] });
    const v = await C.j.post(`/inventories/${inv.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBeGreaterThanOrEqual(400); expect((await levelOf(C, p, C.w2))?.qty ?? 0).toBe(0);
    const sheet = (await C.j.get(`/costs/products/${p}`)).body; expect(sheet).toMatchObject({ costPriceMinor: null, effectiveCostMinor: null, purchasePriceMinor: null, marginMinor: null, belowCost: false });
    const rep = (await C.j.get('/costs/report?limit=100')).body; expect(rep.items.find((i: { productId: string }) => i.productId === p)).toMatchObject({ costPriceMinor: null, marginMinor: null });
    expect((await C.j.post('/costs/simulate', { productId: p, extraCostsMinor: 0 })).status).toBe(400);
    expect(await get()).toMatchObject({ estimatedPurchaseMinor: 350_000, costPriceMinor: null });
  });
  it('commande locale : prix proposé au taux réel du jour (3,42), prix saisi prioritaire', async () => {
    expect((await C.j.get(`/products/${p}/real-purchase-price`)).body).toEqual({ unitPriceMinor: null });
    await C.j.post('/exchange-rates', { currency: 'EUR', date: '2020-01-01', rate: 3.42 });
    expect((await C.j.get(`/products/${p}/real-purchase-price`)).body).toEqual({ unitPriceMinor: 342_000 });
    expect((await B.j.get(`/products/${p}/real-purchase-price`)).status).toBe(404);
    const po = await C.j.post('/purchase-orders', orderLine()); expect(po.status, JSON.stringify(po.body)).toBe(201); expect(po.body.lines[0].unitPriceMinor).toBe(342_000);
    expect((await C.j.post('/purchase-orders', { supplierId: C.supplierId, lines: [{ productId: p, quantity: 1, unitPriceMinor: 360_000 }] })).body.lines[0].unitPriceMinor).toBe(360_000);
  });
  it('importation réelle à 3,42 avec frais → CMP réel ; l’estimation reste à 350 DT', async () => {
    const d = (await C.j.post('/imports', { supplierId: C.foreignSupplierId, currency: 'EUR', lines: [{ productId: p, quantity: 10, unitPriceMinor: 10_000 }] })).body;
    expect(d.exchangeRate).toBe(3.42); expect(d.lines[0].fobBaseMinor).toBe(3_420_000); // 342 DT par unité avant frais
    await C.j.post(`/imports/${d.id}/charges`, { type: 'freight', amountMinor: 200_000, currency: 'TND' });
    for (const s of ['ordered', 'shipped', 'customs', 'arrived']) await C.j.post(`/imports/${d.id}/status`, { status: s });
    await C.j.post(`/imports/${d.id}/close`); const r = await C.j.post(`/imports/${d.id}/integrate`, { warehouseId: C.w1 }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await costOf(p)).toBe(362_000); expect(await levelOf(C, p)).toEqual({ qty: 10, value: 3_620_000 });
    expect(await get()).toMatchObject({ estimatedPurchaseMinor: 350_000, estimatedCostValueMinor: 350_000, costPriceMinor: 362_000, effectiveCostMinor: 362_000, purchasePriceForeignMinor: 10_000 });
  });
  it('le changement du taux estimatif ne touche ni le CMP, ni le stock, ni les documents', async () => {
    const before = JSON.stringify([await col('stocklevels').find({ companyId: C.companyId }).toArray(), await col('purchaseorders').find({ companyId: C.companyId }).toArray(), await col('importfiles').find({ companyId: C.companyId }).toArray()]);
    await C.j.put('/settings/estimate-rates', { currency: 'EUR', rate: 5 });
    expect(await get()).toMatchObject({ estimatedPurchaseMinor: 500_000, costPriceMinor: 362_000 });
    expect(JSON.stringify([await col('stocklevels').find({ companyId: C.companyId }).toArray(), await col('purchaseorders').find({ companyId: C.companyId }).toArray(), await col('importfiles').find({ companyId: C.companyId }).toArray()])).toBe(before);
  });
  it('réception d’une commande, facture d’achat, règlement, comptabilité et trésorerie : montants réels', async () => {
    const q = (await mk(eur(10_000), C)).id;
    const po = (await C.j.post('/purchase-orders', { supplierId: C.supplierId, lines: [{ productId: q, quantity: 4 }] })).body; expect(po.lines[0].unitPriceMinor).toBe(342_000);
    const ok = (await C.j.post(`/purchase-orders/${po.id}/confirm`)).body;
    const rec = (await C.j.post('/goods-receipts', { purchaseOrderId: po.id, warehouseId: C.w1, lines: [{ orderLineId: ok.lines[0].id, quantity: 4 }] })).body;
    expect((await C.j.post(`/goods-receipts/${rec.id}/validate`)).status).toBe(200);
    expect(await costOf(q)).toBe(342_000); expect(await levelOf(C, q)).toEqual({ qty: 4, value: 1_368_000 });
    const val = (await C.j.get('/stock/valuation')).body; const levels = (await C.j.get('/stock/levels?limit=100')).body.items as { valueMinor: number }[];
    expect(val.totalValueMinor).toBe(levels.reduce((s, l) => s + l.valueMinor, 0));
    const bank = (await C.j.post('/treasury/accounts', { code: 'BNK', name: 'Banque', type: 'bank', openingBalanceMinor: 10_000_000 })).body.id;
    const draft = (await C.j.post('/purchase-invoices', { supplierId: C.supplierId, supplierInvoiceNumber: 'F-EUR-1', purchaseOrderId: po.id, lines: [{ productId: q, orderLineId: ok.lines[0].id, quantity: 4 }] })).body;
    expect(draft.totals.totalHtMinor).toBe(1_368_000);
    const inv = await C.j.post(`/purchase-invoices/${draft.id}/validate`); expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    const pay = await C.j.post('/supplier-payments', { supplierId: C.supplierId, treasuryAccountId: bank, method: 'transfer', allocations: [{ purchaseInvoiceId: draft.id, amountMinor: inv.body.totals.totalPayableMinor }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect((await C.j.get('/treasury/position')).body.bankMinor).toBe(10_000_000 - inv.body.totals.totalPayableMinor);
    const acc = (await C.j.get('/accounting/consistency')).body; const tr = (await C.j.get('/treasury/consistency')).body; expect(acc.consistent, JSON.stringify(acc)).toBe(true); expect(tr.consistent, JSON.stringify(tr)).toBe(true);
  });
  it('stock initial : un prix saisi reste la référence ; la fiche ne modifie jamais le CMP', async () => {
    const q = (await mk(eur(10_000), C)).id; await stockIn(C, q, 2, 111_000);
    await C.j.put(`/products/${q}/prices`, { purchaseCurrency: 'EUR', purchasePriceForeignMinor: 99_000 });
    expect(await levelOf(C, q)).toEqual({ qty: 2, value: 222_000 });
  });
});

describe('migration des articles (simulation, exécution, idempotence)', () => {
  it('initialise le taux et les codes fournisseurs sans toucher aux articles', async () => {
    const company = new mongoose.Types.ObjectId();
    await col('settings').insertOne({ companyId: company, baseCurrency: 'TND', currencies: [{ code: 'TND', decimals: 3 }] });
    await col('suppliers').insertMany([{ companyId: company, name: 'Ancien 1', createdAt: new Date('2026-01-01') }, { companyId: company, name: 'Ancien 2', createdAt: new Date('2026-02-01') }]);
    await col('products').insertOne({ companyId: company, reference: 'OLD-P', name: 'Machine Optimum DP26', brand: 'Optimum', model: 'DP26', vatRateCode: 'T19', unitId: new mongoose.Types.ObjectId(), purchaseCurrency: 'EUR', purchasePriceForeignMinor: 100, purchaseRate: 3.3, purchasePriceMinor: 3300, costPriceMinor: 4000, estimatedCostMinor: 5000, packaging: { lengthMm: 910, widthMm: 382, heightMm: 710, parcelCount: 3, dimensionsPerParcel: true, totalVolumeM3: 0.7404306 } });
    const products = async () => JSON.stringify(await col('products').find().sort({ _id: 1 }).toArray());
    const state = async () => JSON.stringify([await col('settings').find().sort({ _id: 1 }).toArray(), await col('suppliers').find().sort({ _id: 1 }).toArray(), await products()]);
    const p0 = await products(); const s0 = await state();
    const dry = await migrateArticles({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, estimateRatesInitialised: 1, supplierCodes: 2, duplicateCategories: [] });
    expect(dry.dimensionsToReview.find((d) => d.reference === 'OLD-P')).toMatchObject({ parcelCount: 3, volumePerParcelM3: 0.2468102, previousTotalM3: 0.7404306 });
    expect(await state()).toBe(s0);
    const real = await migrateArticles(); expect(real).toMatchObject({ estimateRatesInitialised: 1, supplierCodes: 2 });
    expect((await Setting.findOne({ companyId: company }).lean())!.estimateRates).toEqual([expect.objectContaining({ currency: 'EUR', targetCurrency: 'TND', rate: 3.5 })]);
    expect((await col('suppliers').find({ companyId: company }).sort({ createdAt: 1 }).toArray()).map((s) => s.code)).toEqual(['FR-00001', 'FR-00002']);
    expect(await products()).toBe(p0); // aucun article modifié
    const s1 = await state(); const again = await migrateArticles(); expect(again).toMatchObject({ estimateRatesInitialised: 0, supplierCodes: 0 }); expect(await state()).toBe(s1);
    // ancien article à taux réel enregistré : conservé ; la fiche affiche en plus l'estimation
    await col('settings').updateOne({ companyId: company }, { $set: { currencies: [{ code: 'TND', decimals: 3 }, { code: 'EUR', decimals: 2 }] } });
  });
});
