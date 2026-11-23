import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, binaryParser, companyWithAdmin, login, makeUser, parseXlsx, seedVat, setupDb, teardownDb } from './helpers.js';
import { Product, ProductSerial } from '../src/models/product.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { clearReferenceChecks, registerReferenceCheck } from '../src/services/reference-guard.js';

let A: Awaited<ReturnType<typeof companyWithAdmin>>, B: Awaited<ReturnType<typeof companyWithAdmin>>;
let unitId: string, famId: string, subId: string, supId: string;
const api = () => request(app);
const get = (t: string, url: string) => api().get(`/api/v1${url}`).set(authed(t));
const post = (t: string, url: string, body: object = {}) => api().post(`/api/v1${url}`).set(authed(t)).send(body);
const mk = (t: string, body: object) => post(t, '/products', body);
const base = () => ({ reference: 'REF-001', name: 'Article test', unitId, vatRateCode: 'T1', purchasePriceMinor: 10000, salePriceMinor: 15000 });

beforeAll(async () => {
  await setupDb(); A = await companyWithAdmin('Alpha', 'admin@a.test'); B = await companyWithAdmin('Beta', 'admin@b.test');
});
afterAll(async () => { clearReferenceChecks(); await teardownDb(); });

describe('catalogue : catégories et unités', () => {
  it('unités : CRUD, code unique, suppression refusée si utilisée', async () => {
    const u = await post(A.token, '/product-units', { code: 'pce', name: 'Pièce' }); expect(u.status).toBe(201); unitId = u.body.id;
    expect((await post(A.token, '/product-units', { code: 'pce', name: 'Autre' })).status).toBe(409);
    expect((await post(B.token, '/product-units', { code: 'pce', name: 'Pièce B' })).status).toBe(201);
    expect((await api().put(`/api/v1/product-units/${unitId}`).set(authed(A.token)).send({ name: 'Pièces' })).body.name).toBe('Pièces');
    expect((await get(A.token, '/product-units')).body).toHaveLength(1);
  });
  it('catégories : famille → sous-famille (2 niveaux max), doublons, suppression protégée', async () => {
    const f = await post(A.token, '/product-categories', { name: 'Machines' }); famId = f.body.id;
    const s = await post(A.token, '/product-categories', { name: 'Tours', parentId: famId }); subId = s.body.id; expect(s.status).toBe(201);
    expect((await post(A.token, '/product-categories', { name: 'Sous-sous', parentId: subId })).status).toBe(400);
    expect((await post(A.token, '/product-categories', { name: 'Tours', parentId: famId })).status).toBe(409);
    expect((await post(A.token, '/product-categories', { name: 'X', parentId: '0'.repeat(24) })).status).toBe(400);
    expect((await api().delete(`/api/v1/product-categories/${famId}`).set(authed(A.token))).status).toBe(409); // a une sous-famille
    expect((await post(B.token, '/product-categories', { name: 'Tours', parentId: famId })).status).toBe(400); // famille d'une autre société
  });
});

describe('articles : règles de gestion', () => {
  it('refuse la création tant qu’aucun taux de TVA n’est configuré (pas de taux inventé)', async () => {
    const r = await mk(A.token, base());
    expect(r.status).toBe(400); expect(r.body.error.message).toMatch(/TVA/);
    await seedVat(A.companyId, [{ code: 'T1', ratePct: 7 }, { code: 'T0', regime: 'zero' }]);
    const sup = await post(A.token, '/suppliers', { name: 'Fournisseur P', taxId: 'FP1' }); supId = sup.body.id;
  });
  it('crée un article ; référence unique (insensible à la casse), propre à la société', async () => {
    const r = await mk(A.token, { ...base(), categoryId: subId, mainSupplierId: supId, minStock: 5 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ reference: 'REF-001', categoryName: 'Tours', unitCode: 'pce', marginMinor: 5000, belowCost: false, mainSupplierName: 'Fournisseur P', minStock: 5, isActive: true });
    expect(r.body.marginRatePct).toBe(50); expect(r.body.markPct).toBe(33.33); expect(r.body.warnings).toEqual([]);
    const dup = await mk(A.token, { ...base(), reference: 'ref-001' });
    expect(dup.status).toBe(409); expect(dup.body.error.message).toMatch(/référence/i);
    const bUnit = (await get(B.token, '/product-units')).body[0].id;
    await seedVat(B.companyId, [{ code: 'T1', ratePct: 5 }]);
    expect((await mk(B.token, { ...base(), unitId: bUnit })).status).toBe(201);
  });
  it('alerte (non bloquante) si prix de vente < coût de revient ; filtre « sous le coût »', async () => {
    const r = await mk(A.token, { ...base(), reference: 'LOSS-1', salePriceMinor: 8000 });
    expect(r.status).toBe(201); expect(r.body.belowCost).toBe(true); expect(r.body.warnings[0]).toMatch(/inférieur au coût/);
    // le coût de revient (module 11) prime sur le prix d'achat
    await Product.updateOne({ reference: 'REF-001', companyId: A.companyId }, { costPriceMinor: 16000 });
    const l = await get(A.token, '/products?belowCost=true'); expect(l.body.items.map((p: { reference: string }) => p.reference).sort()).toEqual(['LOSS-1', 'REF-001']);
    const up = await api().put(`/api/v1/products/${(await Product.findOne({ reference: 'REF-001' }))!._id}`).set(authed(A.token)).send({ salePriceMinor: 20000 });
    expect(up.body.belowCost).toBe(false); expect(up.body.effectiveCostMinor).toBe(16000);
    await Product.updateOne({ reference: 'REF-001', companyId: A.companyId }, { $unset: { costPriceMinor: 1 } });
  });
  it('valide les données : TVA inconnue, catégorie/unité/fournisseur d’une autre société, prix négatifs, champs inconnus', async () => {
    const bUnit = (await get(B.token, '/product-units')).body[0].id;
    for (const [bad, status] of [[{ vatRateCode: 'ZZ' }, 400], [{ unitId: bUnit }, 400], [{ categoryId: '1'.repeat(24) }, 400], [{ mainSupplierId: '2'.repeat(24) }, 400],
      [{ salePriceMinor: -1 }, 422], [{ salePriceMinor: 1.5 }, 422], [{ name: 'a' }, 422], [{ costPriceMinor: 1 }, 422], [{ isActive: false }, 422]] as [object, number][]) {
      expect((await mk(A.token, { ...base(), reference: `X-${Math.random()}`, ...bad })).status, JSON.stringify(bad)).toBe(status);
    }
  });
  it('liste : recherche, tri, pagination, filtre famille (inclut les sous-familles), type, activité', async () => {
    await Product.deleteMany({ companyId: A.companyId });
    for (let i = 1; i <= 6; i++) await mk(A.token, { ...base(), reference: `P-${i}`, name: `Perceuse ${i}`, categoryId: i <= 3 ? subId : undefined, kind: i === 6 ? 'service' : 'product', salePriceMinor: 20000 + i });
    expect((await get(A.token, '/products?categoryId=' + famId)).body.total).toBe(3);
    expect((await get(A.token, '/products?categoryId=' + subId)).body.total).toBe(3);
    expect((await get(A.token, '/products?kind=service')).body.items[0].reference).toBe('P-6');
    expect((await get(A.token, '/products?q=perceuse 4')).body.total).toBe(1);
    const page = await get(A.token, '/products?page=2&limit=4&sort=-salePriceMinor'); expect(page.body.items.map((p: { reference: string }) => p.reference)).toEqual(['P-2', 'P-1']);
    const id = (await Product.findOne({ reference: 'P-1' }))!._id;
    await api().patch(`/api/v1/products/${id}/active`).set(authed(A.token)).send({ isActive: false });
    expect((await get(A.token, '/products?active=false')).body.total).toBe(1);
    expect((await get(A.token, '/products?active=true')).body.total).toBe(5);
    expect((await get(B.token, '/products?q=perceuse')).body.total).toBe(0); // isolation
  });
  it('duplique (nouvelle référence obligatoire) sans copier coût ni séries ; désactivation', async () => {
    const src = (await Product.findOne({ reference: 'P-2' }))!;
    await Product.updateOne({ _id: src._id }, { costPriceMinor: 555 });
    const d = await post(A.token, `/products/${src._id}/duplicate`, { reference: 'P-2-COPIE' });
    expect(d.status).toBe(201); expect(d.body.name).toBe('Perceuse 2 (copie)'); expect(d.body.costPriceMinor).toBeNull(); expect(d.body.salePriceMinor).toBe(src.salePriceMinor);
    expect((await post(A.token, `/products/${src._id}/duplicate`, { reference: 'p-2' })).status).toBe(409);
    expect((await post(A.token, `/products/${src._id}/duplicate`, {})).status).toBe(422);
    expect((await post(B.token, `/products/${src._id}/duplicate`, { reference: 'Z' })).status).toBe(404);
  });
  it('suppression refusée si référencé par un autre module ou muni de numéros de série', async () => {
    const p = (await mk(A.token, { ...base(), reference: 'DEL-1' })).body;
    registerReferenceCheck('product', async (_c, id) => (id.toString() === p.id ? 'présent dans un devis' : null));
    expect((await api().delete(`/api/v1/products/${p.id}`).set(authed(A.token))).status).toBe(409);
    clearReferenceChecks();
    expect((await api().delete(`/api/v1/products/${p.id}`).set(authed(A.token))).status).toBe(204);
    expect((await api().delete(`/api/v1/products/${p.id}`).set(authed(A.token))).status).toBe(404);
  });
});

describe('articles : numéros de série (machines)', () => {
  it('ajoute, refuse doublons, supprime seulement les disponibles, protège hasSerial', async () => {
    const plain = (await mk(A.token, { ...base(), reference: 'NS-0' })).body;
    expect((await post(A.token, `/products/${plain.id}/serials`, { serials: ['A1'] })).status).toBe(400);
    const m = (await mk(A.token, { ...base(), reference: 'MACH-1', hasSerial: true })).body;
    expect((await post(A.token, `/products/${m.id}/serials`, { serials: ['SN-1', 'SN-2', 'SN-2', 'SN-3'] })).body).toEqual({ added: 3 });
    const dup = await post(A.token, `/products/${m.id}/serials`, { serials: ['SN-9', 'SN-1'] }); expect(dup.status).toBe(409); expect(dup.body.error.message).toContain('SN-1');
    expect(await ProductSerial.countDocuments({ productId: m.id })).toBe(3);
    const list = await get(A.token, `/products/${m.id}/serials?q=sn-2`); expect(list.body.total).toBe(1);
    const sold = (await ProductSerial.findOne({ productId: m.id, serialNumber: 'SN-3' }))!; await ProductSerial.updateOne({ _id: sold._id }, { status: 'sold' });
    expect((await api().delete(`/api/v1/products/${m.id}/serials/${sold._id}`).set(authed(A.token))).status).toBe(409);
    const free = (await ProductSerial.findOne({ productId: m.id, serialNumber: 'SN-1' }))!;
    expect((await api().delete(`/api/v1/products/${m.id}/serials/${free._id}`).set(authed(A.token))).status).toBe(204);
    expect((await api().put(`/api/v1/products/${m.id}`).set(authed(A.token)).send({ hasSerial: false })).status).toBe(409);
    expect((await api().delete(`/api/v1/products/${m.id}`).set(authed(A.token))).status).toBe(409);
    expect((await get(B.token, `/products/${m.id}/serials`)).status).toBe(404);
    expect((await get(A.token, `/products/${m.id}`)).body.serialCount).toBe(2);
  });
});

describe('articles : import / export Excel et CSV', () => {
  const xlsx = async (rows: unknown[][]) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Articles'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const H = ['Référence', 'Désignation', 'Type', 'Famille', 'Sous-famille', 'Unité', "Prix d'achat", 'Prix de vente', 'Code TVA', 'Stock minimum', 'Fournisseur', 'Série'];
  const imp = (t: string, file: Buffer, name: string, qs = '') => api().post(`/api/v1/products/import${qs}`).set(authed(t)).attach('file', file, name);

  it('fournit un modèle xlsx exploitable', async () => {
    const r = await api().get('/api/v1/products/import/template').set(authed(A.token)).buffer().parse(binaryParser);
    expect(r.status).toBe(200); const rows = await parseXlsx(r.body as Buffer); expect(rows[0]).toContain('Référence'); expect(rows[0]).toContain('Code TVA');
  });
  it('analyse à blanc (dryRun) sans rien écrire, puis applique', async () => {
    const f = await xlsx([H, ['IMP-1', 'Importé 1', 'Produit', 'Machines', 'Tours', 'pce', '12,500', '20.000', 'T1', 3, 'FP1', 'Oui'], ['IMP-2', 'Service import', 'Service', '', '', 'pce', 0, '50', 'T0', '', '', '']]);
    const dry = await imp(A.token, f, 'a.xlsx'); // dryRun par défaut
    expect(dry.body).toMatchObject({ dryRun: true, total: 2, toCreate: 2, toUpdate: 0, applied: false, errors: [] });
    expect(await Product.countDocuments({ reference: /^IMP-/ })).toBe(0);
    const real = await imp(A.token, f, 'a.xlsx', '?dryRun=false');
    expect(real.body).toMatchObject({ applied: true, created: 2 });
    const p = await Product.findOne({ reference: 'IMP-1' }).lean();
    expect(p).toMatchObject({ purchasePriceMinor: 12500, salePriceMinor: 20000, hasSerial: true, minStock: 3, kind: 'product' });
    expect(String(p!.mainSupplierId)).toBe(supId); expect(String(p!.categoryId)).toBe(subId);
    expect(await AuditLog.countDocuments({ resource: 'product', action: 'import' })).toBe(1);
  });
  it('mode création : refuse les références existantes ; mode mise à jour : les met à jour', async () => {
    const f = await xlsx([H, ['IMP-1', 'Importé 1 modifié', 'Produit', '', '', 'pce', 1, 2, 'T1', 0, '', 'Non']]);
    const c = await imp(A.token, f, 'a.xlsx', '?dryRun=false');
    expect(c.body.applied).toBe(false); expect(c.body.errors[0]).toMatchObject({ row: 2, field: 'reference' });
    const u = await imp(A.token, f, 'a.xlsx', '?dryRun=false&mode=upsert');
    expect(u.body).toMatchObject({ applied: true, updated: 1, created: 0 });
    expect(await Product.findOne({ reference: 'IMP-1' })).toMatchObject({ name: 'Importé 1 modifié', salePriceMinor: 2000, hasSerial: false });
  });
  it('tout ou rien : une ligne invalide empêche toute écriture, avec erreurs par ligne/colonne', async () => {
    const before = await Product.countDocuments({ companyId: A.companyId });
    const f = await xlsx([H,
      ['OK-1', 'Valide', '', '', '', 'pce', 1, 2, 'T1', '', '', ''],
      ['', 'Sans référence', '', '', '', 'pce', 1, 2, 'T1', '', '', ''],
      ['BAD-U', 'Unité inconnue', '', '', '', 'kg', 1, 2, 'T1', '', '', ''],
      ['BAD-V', 'TVA inconnue', '', '', '', 'pce', 1, 2, 'T9', '', '', ''],
      ['BAD-P', 'Prix négatif', '', '', '', 'pce', -3, 'abc', 'T1', '', '', ''],
      ['BAD-C', 'Famille inconnue', '', 'Inconnue', '', 'pce', 1, 2, 'T1', '', '', ''],
      ['BAD-F', 'Fournisseur inconnu', '', '', '', 'pce', 1, 2, 'T1', '', 'NOPE', ''],
      ['OK-1', 'Doublon fichier', '', '', '', 'pce', 1, 2, 'T1', '', '', '']]);
    const r = await imp(A.token, f, 'e.xlsx', '?dryRun=false');
    expect(r.body.applied).toBe(false);
    const errs = r.body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`);
    expect(errs).toEqual(expect.arrayContaining(['3:reference', '4:unit', '5:vat', '6:purchase', '6:sale', '7:family', '8:supplier', '9:reference']));
    expect(await Product.countDocuments({ companyId: A.companyId })).toBe(before);
  });
  it('accepte un CSV (séparateur ; virgule décimale, BOM) et round-trip export → import', async () => {
    const csv = Buffer.from('﻿Référence;Désignation;Unité;Prix d\'achat;Prix de vente;Code TVA\r\nCSV-1;Article CSV;pce;1,250;2,5;T1\r\nCSV-2;"Désignation; avec point-virgule";pce;3;4;T0\r\n');
    const r = await imp(A.token, csv, 'a.csv', '?dryRun=false'); expect(r.body).toMatchObject({ applied: true, created: 2, errors: [] });
    expect(await Product.findOne({ reference: 'CSV-1' })).toMatchObject({ purchasePriceMinor: 1250, salePriceMinor: 2500 });
    expect((await Product.findOne({ reference: 'CSV-2' }))!.name).toBe('Désignation; avec point-virgule');
    const ex = await get(A.token, '/products/export?format=xlsx').buffer().parse(binaryParser);
    expect(ex.status).toBe(200);
    const back = await imp(A.token, ex.body as Buffer, 'export.xlsx', '?mode=upsert');
    expect(back.body.errors).toEqual([]); expect(back.body.toUpdate).toBe(await Product.countDocuments({ companyId: A.companyId }));
    const csvEx = await get(A.token, '/products/export?format=csv').buffer().parse(binaryParser);
    expect((csvEx.body as Buffer).toString('utf8')).toContain('Référence;Désignation;Type');
    expect((await get(A.token, '/products/export?format=pdf').buffer().parse(binaryParser)).body.subarray(0, 4).toString()).toBe('%PDF');
  });
  it('rejette les fichiers non supportés, falsifiés ou absents ; permissions : create requis, update pour upsert', async () => {
    expect((await imp(A.token, Buffer.from('MZ binaire'), 'virus.exe')).status).toBe(400);
    expect((await imp(A.token, Buffer.from('pas un zip'), 'faux.xlsx')).status).toBe(400);
    expect((await api().post('/api/v1/products/import').set(authed(A.token))).status).toBe(400);
    expect((await imp(A.token, Buffer.alloc(6 * 1024 * 1024, 'a'), 'gros.csv')).status).toBe(413);
    await makeUser(A.companyId, 'pv@a.test', ['products:view']); await makeUser(A.companyId, 'pc@a.test', ['products:create']);
    const v = (await login('pv@a.test')).token; const c = (await login('pc@a.test')).token;
    const f = await xlsx([H, ['PERM-1', 'Perm', '', '', '', 'pce', 1, 2, 'T1', '', '', '']]);
    expect((await imp(v, f, 'a.xlsx')).status).toBe(403);
    expect((await imp(c, f, 'a.xlsx', '?mode=upsert')).status).toBe(403);
    expect((await imp(c, f, 'a.xlsx', '?dryRun=false')).status).toBe(200);
    expect((await get(c, '/products/export')).status).toBe(403);
  });
});
