import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, binaryParser, companyWithAdmin, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { J } from './sales.helpers.js';
import { Supplier } from '../src/models/supplier.model.js';
import { Setting } from '../src/models/setting.model.js';
import * as suppliers from '../src/modules/suppliers/supplier.service.js';
import { clearReferenceChecks, registerReferenceCheck } from '../src/services/reference-guard.js';

let A: Awaited<ReturnType<typeof companyWithAdmin>>, B: Awaited<ReturnType<typeof companyWithAdmin>>;
const api = () => request(app);
const mk = (token: string, body: object) => api().post('/api/v1/suppliers').set(authed(token)).send(body);
beforeAll(async () => { await setupDb(); A = await companyWithAdmin('Alpha', 'admin@a.test'); B = await companyWithAdmin('Beta', 'admin@b.test'); });
afterAll(async () => { clearReferenceChecks(); await teardownDb(); });

describe('fournisseurs', () => {
  it('crée avec matricule fiscal unique par société et champs spécifiques', async () => {
    const r = await mk(A.token, { name: 'Fournisseur SA', taxId: 'f 001', leadTimeDays: 14, paymentTerms: '60 jours', paymentDelayDays: 60 });
    expect(r.status).toBe(201); expect(r.body.taxId).toBe('F001'); expect(r.body.leadTimeDays).toBe(14);
    expect((await mk(A.token, { name: 'Bis', taxId: 'F001' })).status).toBe(409);
    expect((await mk(B.token, { name: 'Autre', taxId: 'F001' })).status).toBe(201);
  });
  it('valide les données (422) : solde non modifiable, délai négatif, devise mal formée', async () => {
    for (const bad of [{ name: 'a' }, { name: 'Valide', balanceMinor: 5 }, { name: 'Valide', leadTimeDays: -1 }, { name: 'Valide', currency: 'EURO' }, { name: 'Valide', blockThresholdMinor: -1 }]) {
      expect((await mk(A.token, bad)).status, JSON.stringify(bad)).toBe(422);
    }
  });
  it('fournisseur étranger : la devise doit être configurée dans les paramètres', async () => {
    expect((await mk(A.token, { name: 'Étranger SARL', isForeign: true, currency: 'USD' })).status).toBe(400);
    await Setting.updateOne({ companyId: A.companyId }, { $push: { currencies: { code: 'EUR', decimals: 2 } } });
    const ok = await mk(A.token, { name: 'Étranger GmbH', isForeign: true, currency: 'eur' });
    expect(ok.status).toBe(201); expect(ok.body.currency).toBe('EUR');
    expect((await api().get('/api/v1/suppliers?foreign=true').set(authed(A.token))).body.items.map((s: { name: string }) => s.name)).toEqual(['Étranger GmbH']);
  });
  it('assertCanOrder : seuil fournisseur prioritaire, sinon seuil société, sinon pas de blocage ; archivé refusé', async () => {
    const s = (await mk(A.token, { name: 'Seuil', blockThresholdMinor: 1000 })).body;
    await Supplier.updateOne({ _id: s.id }, { balanceMinor: 1000 });
    await expect(suppliers.assertCanOrder(A.companyId, s.id)).resolves.toBeUndefined(); // = seuil : pas dépassé
    await Supplier.updateOne({ _id: s.id }, { balanceMinor: 1001 });
    await expect(suppliers.assertCanOrder(A.companyId, s.id)).rejects.toMatchObject({ code: 'SUPPLIER_BLOCKED', status: 409 });
    expect((await api().get(`/api/v1/suppliers/${s.id}`).set(authed(A.token))).body.ordersBlocked).toBe(true);

    const n = (await mk(A.token, { name: 'Sans seuil' })).body;
    await Supplier.updateOne({ _id: n.id }, { balanceMinor: 10_000_000 });
    await expect(suppliers.assertCanOrder(A.companyId, n.id)).resolves.toBeUndefined(); // aucun seuil configuré : pas de blocage
    await api().put('/api/v1/settings').set(authed(A.token)).send({ supplierBlockThresholdMinor: 5000 });
    await expect(suppliers.assertCanOrder(A.companyId, n.id)).rejects.toMatchObject({ code: 'SUPPLIER_BLOCKED' });
    await api().put(`/api/v1/suppliers/${n.id}`).set(authed(A.token)).send({ blockThresholdMinor: 99_999_999 });
    await expect(suppliers.assertCanOrder(A.companyId, n.id)).resolves.toBeUndefined(); // le seuil fournisseur l'emporte
    await api().put(`/api/v1/suppliers/${n.id}`).set(authed(A.token)).send({ blockThresholdMinor: null });
    await expect(suppliers.assertCanOrder(A.companyId, n.id)).rejects.toMatchObject({ code: 'SUPPLIER_BLOCKED' }); // retour au seuil société

    await api().post(`/api/v1/suppliers/${s.id}/archive`).set(authed(A.token));
    await expect(suppliers.assertCanOrder(A.companyId, s.id)).rejects.toMatchObject({ code: 'SUPPLIER_ARCHIVED' });
    await expect(suppliers.assertCanOrder(B.companyId, n.id)).rejects.toMatchObject({ status: 404 });
    await api().put('/api/v1/settings').set(authed(A.token)).send({ supplierBlockThresholdMinor: undefined });
  });
  it('archivage, suppression conditionnée, isolation par société', async () => {
    const s = (await mk(A.token, { name: 'Cycle de vie' })).body;
    expect((await api().post(`/api/v1/suppliers/${s.id}/archive`).set(authed(A.token))).body.isArchived).toBe(true);
    expect((await api().put(`/api/v1/suppliers/${s.id}`).set(authed(A.token)).send({ phone: '71 000 000' })).status).toBe(409);
    expect((await api().post(`/api/v1/suppliers/${s.id}/reactivate`).set(authed(A.token))).body.isArchived).toBe(false);
    expect((await api().get(`/api/v1/suppliers/${s.id}`).set(authed(B.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/suppliers/${s.id}`).set(authed(B.token))).status).toBe(404);
    await Supplier.updateOne({ _id: s.id }, { balanceMinor: 1 });
    expect((await api().delete(`/api/v1/suppliers/${s.id}`).set(authed(A.token))).status).toBe(409);
    await Supplier.updateOne({ _id: s.id }, { balanceMinor: 0 });
    registerReferenceCheck('supplier', async () => '1 commande d’achat');
    expect((await api().delete(`/api/v1/suppliers/${s.id}`).set(authed(A.token))).status).toBe(409);
    clearReferenceChecks();
    expect((await api().delete(`/api/v1/suppliers/${s.id}`).set(authed(A.token))).status).toBe(204);
  });
  it('RBAC séparé view/create/update/delete', async () => {
    await makeUser(A.companyId, 'sv@a.test', ['suppliers:view']); await makeUser(A.companyId, 'sc@a.test', ['suppliers:create']);
    const v = (await login('sv@a.test')).token; const c = (await login('sc@a.test')).token;
    expect((await api().get('/api/v1/suppliers').set(authed(v))).status).toBe(200);
    expect((await mk(v, { name: 'Non autorisé' })).status).toBe(403);
    expect((await mk(c, { name: 'Autorisé ici' })).status).toBe(201);
    expect((await api().get('/api/v1/suppliers').set(authed(c))).status).toBe(403);
  });
  it('liste filtrée (impayés), total de la balance, exports xlsx/csv/pdf et fiche PDF', async () => {
    await Supplier.deleteMany({ companyId: B.companyId });
    await Supplier.create([{ companyId: B.companyId, name: 'Four 1', balanceMinor: 2000 }, { companyId: B.companyId, name: 'Four 2', balanceMinor: 0 }, { companyId: B.companyId, name: 'Four 3', balanceMinor: 500 }]);
    const l = await api().get('/api/v1/suppliers?withBalance=true&sort=-balanceMinor').set(authed(B.token));
    expect(l.body.items.map((i: { name: string }) => i.name)).toEqual(['Four 1', 'Four 3']); expect(l.body.summary.totalBalanceMinor).toBe(2500);
    const x = await api().get('/api/v1/suppliers/export?format=xlsx&withBalance=true').set(authed(B.token)).buffer().parse(binaryParser);
    expect(x.headers['content-disposition']).toMatch(/balance-fournisseurs/);
    const rows = await parseXlsx(x.body as Buffer); expect(rows).toHaveLength(3); expect(rows[1]![rows[0]!.indexOf('Solde dû')]).toBe('2.000');
    for (const f of ['csv', 'pdf']) expect((await api().get(`/api/v1/suppliers/export?format=${f}`).set(authed(B.token))).status).toBe(200);
    const id = (await Supplier.findOne({ companyId: B.companyId }))!._id;
    const pdf = await api().get(`/api/v1/suppliers/${id}/pdf`).set(authed(B.token)).buffer().parse(binaryParser);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('paramètres : seuil global fournisseur', () => {
  it('peut être défini puis retiré (null)', async () => {
    await api().put('/api/v1/settings').set(authed(B.token)).send({ supplierBlockThresholdMinor: 777 });
    expect((await Setting.findOne({ companyId: B.companyId }))!.supplierBlockThresholdMinor).toBe(777);
    await api().put('/api/v1/settings').set(authed(B.token)).send({ supplierBlockThresholdMinor: null }).expect(200);
    expect((await Setting.findOne({ companyId: B.companyId }))!.supplierBlockThresholdMinor).toBeUndefined();
  });
});

describe('fournisseur étranger : règle appliquée côté serveur', () => {
  it('la devise est obligatoire à la création et ne peut pas être retirée', async () => {
    const c = await companyWithAdmin('Devise', 'admin@devise.test'); const j = J(c.token); await j.put('/settings', { baseCurrency: 'TND', currencies: [{ code: 'TND', name: 'Dinar', symbol: 'DT', decimals: 3 }, { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 }] });
    const bad = await j.post('/suppliers', { name: 'Étranger sans devise', taxId: 'X-1', isForeign: true }); expect(bad.status).toBe(400); expect(bad.body.error.message).toMatch(/devise/i);
    const ok = await j.post('/suppliers', { name: 'Foreign GmbH', taxId: 'X-2', isForeign: true, currency: 'EUR' }); expect(ok.status).toBe(201);
    expect((await j.put(`/suppliers/${ok.body.id}`, { currency: null })).status).toBe(400); // retrait de la devise refusé
    const local = await j.post('/suppliers', { name: 'Local', taxId: 'X-3' }); expect(local.status).toBe(201); expect((await j.put(`/suppliers/${local.body.id}`, { isForeign: true })).status).toBe(400); // passage à « étranger » sans devise refusé
    expect((await j.put(`/suppliers/${local.body.id}`, { isForeign: true, currency: 'EUR' })).status).toBe(200);
  });
});

