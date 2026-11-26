import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, binaryParser, companyWithAdmin, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { Customer } from '../src/models/customer.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import * as customers from '../src/modules/customers/customer.service.js';
import { clearReferenceChecks, registerReferenceCheck } from '../src/services/reference-guard.js';

let A: Awaited<ReturnType<typeof companyWithAdmin>>, B: Awaited<ReturnType<typeof companyWithAdmin>>;
const api = () => request(app);
const mk = (token: string, body: object) => api().post('/api/v1/customers').set(authed(token)).send(body);

beforeAll(async () => { await setupDb(); A = await companyWithAdmin('Alpha', 'admin@a.test'); B = await companyWithAdmin('Beta', 'admin@b.test'); });
afterAll(async () => { clearReferenceChecks(); await teardownDb(); });

describe('clients : CRUD et validation', () => {
  it('crée un client, normalise le matricule fiscal et un seul contact principal', async () => {
    const r = await mk(A.token, { name: 'Société Test', taxId: ' 123 abc/m ', email: 'contact@test.tn', paymentDelayDays: 30, creditLimitMinor: 500000,
      contacts: [{ name: 'Ali', isPrimary: true }, { name: 'Sami', isPrimary: true }] });
    expect(r.status).toBe(201);
    expect(r.body.taxId).toBe('123ABC/M');
    expect(r.body.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary)).toHaveLength(1);
    expect(r.body.balanceMinor).toBe(0);
    expect(r.body.availableCreditMinor).toBe(500000);
  });
  it('matricule fiscal unique par société (casse/espaces ignorés) mais réutilisable dans une autre société', async () => {
    const d = await mk(A.token, { name: 'Doublon', taxId: '123abc/m' });
    expect(d.status).toBe(409); expect(d.body.error.message).toMatch(/matricule fiscal/i);
    expect((await mk(B.token, { name: 'Autre société', taxId: '123ABC/M' })).status).toBe(201);
  });
  it('plusieurs clients sans matricule sont autorisés', async () => {
    expect((await mk(A.token, { name: 'Particulier 1' })).status).toBe(201);
    expect((await mk(A.token, { name: 'Particulier 2', taxId: '' })).status).toBe(201);
  });
  it('rejette les données invalides (422) et les champs inconnus, y compris le solde (lecture seule)', async () => {
    for (const bad of [{ name: 'x' }, { name: 'Valide', email: 'pas-un-email' }, { name: 'Valide', creditLimitMinor: -5 }, { name: 'Valide', creditLimitMinor: 1.5 },
      { name: 'Valide', paymentDelayDays: 9999 }, { name: 'Valide', balanceMinor: 100 }, { name: 'Valide', companyId: B.companyId.toString() }, { name: 'Valide', contacts: [{ email: 'x@y.tn' }] }]) {
      expect((await mk(A.token, bad)).status, JSON.stringify(bad)).toBe(422);
    }
  });
  it('modifie un client ; la limite de crédit change est tracée avant/après dans l’audit', async () => {
    const c = (await mk(A.token, { name: 'À modifier', creditLimitMinor: 1000 })).body;
    const r = await api().put(`/api/v1/customers/${c.id}`).set(authed(A.token)).send({ creditLimitMinor: 2000, phone: '71000000' });
    expect(r.status).toBe(200); expect(r.body.creditLimitMinor).toBe(2000); expect(r.body.phone).toBe('+21671000000'); // numéro reconnu : enregistré au format international
    const log = await AuditLog.findOne({ resource: 'customer', action: 'update', resourceId: c.id }).lean();
    expect((log!.meta as { creditLimit: { from: number; to: number } }).creditLimit).toEqual({ from: 1000, to: 2000 });
    const unlimited = await api().put(`/api/v1/customers/${c.id}`).set(authed(A.token)).send({ creditLimitMinor: null });
    expect(unlimited.body.creditLimitMinor).toBeNull();
  });
});

describe('clients : archivage, suppression et règles métier', () => {
  it('archive / réactive ; un client archivé n’apparaît plus par défaut et n’est plus modifiable', async () => {
    const c = (await mk(A.token, { name: 'Archivable' })).body;
    expect((await api().post(`/api/v1/customers/${c.id}/archive`).set(authed(A.token))).body.isArchived).toBe(true);
    expect((await api().post(`/api/v1/customers/${c.id}/archive`).set(authed(A.token))).status).toBe(409);
    expect((await api().put(`/api/v1/customers/${c.id}`).set(authed(A.token)).send({ phone: '+21671000001' })).status).toBe(409);
    const def = await api().get('/api/v1/customers?q=Archivable').set(authed(A.token));
    expect(def.body.total).toBe(0);
    expect((await api().get('/api/v1/customers?q=Archivable&status=archived').set(authed(A.token))).body.total).toBe(1);
    expect((await api().post(`/api/v1/customers/${c.id}/reactivate`).set(authed(A.token))).body.isArchived).toBe(false);
    expect((await api().get('/api/v1/customers?q=Archivable').set(authed(A.token))).body.total).toBe(1);
  });
  it('assertCanSell : bloque au-delà de la limite de crédit, client archivé ; crédit illimité accepté', async () => {
    const c = (await mk(A.token, { name: 'Crédit', creditLimitMinor: 1000 })).body;
    await Customer.updateOne({ _id: c.id }, { balanceMinor: 600 });
    await expect(customers.assertCanSell(A.companyId, c.id, 400)).resolves.toBeUndefined();
    await expect(customers.assertCanSell(A.companyId, c.id, 401)).rejects.toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', status: 409 });
    const unl = (await mk(A.token, { name: 'Illimité' })).body;
    await Customer.updateOne({ _id: unl.id }, { balanceMinor: 99999999 });
    await expect(customers.assertCanSell(A.companyId, unl.id, 1e9)).resolves.toBeUndefined();
    await api().post(`/api/v1/customers/${c.id}/archive`).set(authed(A.token));
    await expect(customers.assertCanSell(A.companyId, c.id, 1)).rejects.toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
    await expect(customers.assertCanSell(B.companyId, c.id, 1)).rejects.toMatchObject({ status: 404 }); // autre société
  });
  it('suppression refusée si solde ≠ 0 ou référencé par un autre module ; sinon OK', async () => {
    const c = (await mk(A.token, { name: 'À supprimer' })).body;
    await Customer.updateOne({ _id: c.id }, { balanceMinor: 50 });
    expect((await api().delete(`/api/v1/customers/${c.id}`).set(authed(A.token))).status).toBe(409);
    await Customer.updateOne({ _id: c.id }, { balanceMinor: 0 });
    registerReferenceCheck('customer', async (_co, id) => (id.toString() === c.id ? '2 factures existent' : null));
    const r = await api().delete(`/api/v1/customers/${c.id}`).set(authed(A.token));
    expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/2 factures/);
    clearReferenceChecks();
    expect((await api().delete(`/api/v1/customers/${c.id}`).set(authed(A.token))).status).toBe(204);
    expect((await api().get(`/api/v1/customers/${c.id}`).set(authed(A.token))).status).toBe(404);
  });
});

describe('clients : isolation et permissions', () => {
  it('isolation stricte par société', async () => {
    const c = (await mk(A.token, { name: 'Privé Alpha' })).body;
    expect((await api().get(`/api/v1/customers/${c.id}`).set(authed(B.token))).status).toBe(404);
    expect((await api().put(`/api/v1/customers/${c.id}`).set(authed(B.token)).send({ phone: '+21671000009' })).status).toBe(404);
    expect((await api().delete(`/api/v1/customers/${c.id}`).set(authed(B.token))).status).toBe(404);
    expect((await api().post(`/api/v1/customers/${c.id}/archive`).set(authed(B.token))).status).toBe(404);
    expect((await api().get(`/api/v1/customers/${c.id}/pdf`).set(authed(B.token))).status).toBe(404);
    const list = await api().get('/api/v1/customers?limit=100&status=all').set(authed(B.token));
    expect(list.body.items.map((i: { name: string }) => i.name)).not.toContain('Privé Alpha');
  });
  it('permissions séparées : view / create / update / delete', async () => {
    const mkTok = async (email: string, perms: string[]) => { await makeUser(A.companyId, email, perms); return (await login(email)).token; };
    const view = await mkTok('v@a.test', ['customers:view']); const create = await mkTok('c@a.test', ['customers:create']);
    const upd = await mkTok('u@a.test', ['customers:update', 'customers:view']); const del = await mkTok('d@a.test', ['customers:delete']);
    const c = (await mk(A.token, { name: 'Perm' })).body;
    expect((await api().get('/api/v1/customers').set(authed(view))).status).toBe(200);
    expect((await mk(view, { name: 'Nope nope' })).status).toBe(403);
    expect((await api().get('/api/v1/customers').set(authed(create))).status).toBe(403);
    expect((await mk(create, { name: 'Créé par c' })).status).toBe(201);
    expect((await api().put(`/api/v1/customers/${c.id}`).set(authed(view)).send({ phone: '+21671000001' })).status).toBe(403);
    expect((await api().put(`/api/v1/customers/${c.id}`).set(authed(upd)).send({ phone: '+21671000001' })).status).toBe(200);
    expect((await api().post(`/api/v1/customers/${c.id}/archive`).set(authed(view))).status).toBe(403);
    expect((await api().delete(`/api/v1/customers/${c.id}`).set(authed(upd))).status).toBe(403);
    expect((await api().get('/api/v1/customers/export').set(authed(create))).status).toBe(403);
    expect((await api().delete(`/api/v1/customers/${c.id}`).set(authed(del))).status).toBe(204);
  });
});

describe('clients : liste, filtres, exports', () => {
  it('pagination, recherche, tri, filtre débiteurs et total des soldes côté serveur', async () => {
    await Customer.deleteMany({ companyId: B.companyId });
    for (let i = 1; i <= 7; i++) await Customer.create({ companyId: B.companyId, name: `Client ${String(i).padStart(2, '0')}`, balanceMinor: i % 2 ? i * 1000 : 0, address: { city: i < 4 ? 'Tunis' : 'Sfax' } });
    const p = await api().get('/api/v1/customers?page=2&limit=3').set(authed(B.token));
    expect(p.body.items.map((i: { name: string }) => i.name)).toEqual(['Client 04', 'Client 05', 'Client 06']); expect(p.body.total).toBe(7);
    expect((await api().get('/api/v1/customers?q=sfax').set(authed(B.token))).body.total).toBe(4);
    const deb = await api().get('/api/v1/customers?debtors=true&sort=-balanceMinor').set(authed(B.token));
    expect(deb.body.items.map((i: { balanceMinor: number }) => i.balanceMinor)).toEqual([7000, 5000, 3000, 1000]);
    expect(deb.body.summary.totalBalanceMinor).toBe(16000);
    expect((await api().get('/api/v1/customers?limit=500').set(authed(B.token))).status).toBe(422);
    expect((await api().get('/api/v1/customers?sort=passwordHash').set(authed(B.token))).status).toBe(200); // tri hors liste blanche ignoré
  });
  it('exporte en xlsx / csv / pdf selon les filtres, neutralise les formules et journalise', async () => {
    await Customer.create({ companyId: B.companyId, name: '=HYPERLINK("http://evil")', balanceMinor: 1234 });
    const x = await api().get('/api/v1/customers/export?format=xlsx&debtors=true').set(authed(B.token)).buffer().parse(binaryParser);
    expect(x.status).toBe(200); expect(x.headers['content-type']).toMatch(/spreadsheetml/); expect(x.headers['content-disposition']).toMatch(/clients-debiteurs-.*\.xlsx/);
    const rows = await parseXlsx(x.body as Buffer);
    expect(rows[0]![1]).toBe('Raison sociale / Nom'); expect(rows).toHaveLength(6); // en-tête + 5 débiteurs
    expect(rows.some((r) => r[1]!.startsWith("'=HYPERLINK"))).toBe(true);
    expect(rows.find((r) => r[1] === 'Client 07')![10]).toBe('7.000');
    const csv = await api().get('/api/v1/customers/export?format=csv').set(authed(B.token)).buffer().parse(binaryParser);
    const text = (csv.body as Buffer).toString('utf8'); expect(text.charCodeAt(0)).toBe(0xfeff); expect(text).toContain('Code;Raison sociale / Nom;Type;Matricule fiscal'); expect(text).toContain("'=HYPERLINK");
    const pdf = await api().get('/api/v1/customers/export?format=pdf').set(authed(B.token)).buffer().parse(binaryParser);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await api().get('/api/v1/customers/export?format=exe').set(authed(B.token))).status).toBe(422);
    expect(await AuditLog.countDocuments({ resource: 'customer', action: 'export', companyId: B.companyId })).toBe(3);
  });
  it('génère la fiche client PDF imprimable', async () => {
    const c = (await mk(A.token, { name: 'Fiche Test', taxId: 'FICHE1', contacts: [{ name: 'Nadia', phone: '20202020' }] })).body;
    const r = await api().get(`/api/v1/customers/${c.id}/pdf`).set(authed(A.token)).buffer().parse(binaryParser);
    expect(r.status).toBe(200); expect(r.headers['content-type']).toBe('application/pdf'); expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(await AuditLog.countDocuments({ resource: 'customer', action: 'print', resourceId: c.id })).toBe(1);
  });
});
