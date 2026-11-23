import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, login, makeCompany, setupDb, teardownDb } from './helpers.js';
import { withTransaction } from '../src/utils/transaction.js';
import { nextDocumentNumber } from '../src/services/numbering.service.js';
import { Counter } from '../src/models/counter.model.js';
import { Setting } from '../src/models/setting.model.js';
import { toMinor, fromMinor, formatMinor } from '../src/utils/money.js';

let C: Awaited<ReturnType<typeof makeCompany>>;
beforeAll(async () => { await setupDb(); C = await makeCompany('Core', 'admin@core.test'); });
afterAll(teardownDb);

describe('transactions MongoDB', () => {
  it('annule toutes les écritures si une erreur survient', async () => {
    const col = mongoose.connection.collection('tx_probe');
    await expect(withTransaction(async (s) => {
      await col.insertOne({ a: 1 }, { session: s });
      await col.insertOne({ a: 2 }, { session: s });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await col.countDocuments()).toBe(0);
    await withTransaction(async (s) => { await col.insertOne({ a: 3 }, { session: s }); });
    expect(await col.countDocuments()).toBe(1);
  });
});

describe('numérotation', () => {
  it('refuse un type de document inconnu ; séries par défaut pour les types commerciaux', async () => {
    await expect(nextDocumentNumber(C.companyId, 'inconnu')).rejects.toThrow(/non configuré/);
    const y = new Date().getUTCFullYear();
    expect(await nextDocumentNumber(C.companyId, 'quotation')).toBe(`DEV-${y}-000001`);
    expect(await nextDocumentNumber(C.companyId, 'proforma')).toBe(`PRO-${y}-000001`);
    expect(await nextDocumentNumber(C.companyId, 'creditNote')).toBe(`AV-${y}-000001`);
    expect(await nextDocumentNumber(C.companyId, 'deliveryNote')).toBe(`BL-${y}-000001`);
  });
  it('génère des numéros séquentiels sans doublon sous concurrence', async () => {
    await Setting.updateOne({ companyId: C.companyId }, { numbering: [{ docType: 'invoice', prefix: 'F', padding: 4, includeYear: true, resetYearly: true }] });
    const nums = await Promise.all(Array.from({ length: 25 }, () => nextDocumentNumber(C.companyId, 'invoice')));
    expect(new Set(nums).size).toBe(25);
    const y = new Date().getUTCFullYear();
    expect([...nums].sort()[0]).toBe(`F${y}-0001`);
    expect([...nums].sort().at(-1)).toBe(`F${y}-0025`);
    expect((await Counter.findOne({ companyId: C.companyId, key: /^invoice:/ }))!.seq).toBe(25);
  });
  it('la remise à zéro annuelle utilise un compteur par année', async () => {
    const n = await nextDocumentNumber(C.companyId, 'invoice', undefined, new Date('2030-03-01'));
    expect(n).toBe('F2030-0001');
  });
});

describe('montants en entiers', () => {
  it('convertit selon la précision de la devise', () => {
    expect(toMinor(12.345, 3)).toBe(12345);
    expect(toMinor('1,5', 3)).toBe(1500);
    expect(toMinor(10.1, 2)).toBe(1010);
    expect(fromMinor(12345, 3)).toBe(12.345);
    expect(formatMinor(1500, 3)).toBe('1.500');
    expect(() => toMinor('abc', 3)).toThrow();
  });
});

describe('paramètres', () => {
  it('les règles fiscales ne sont plus dans les paramètres généraux (aucune valeur par défaut)', async () => {
    const t = (await login('admin@core.test')).token;
    const r = await request(app).get('/api/v1/settings').set(authed(t));
    expect(r.body.vatRates).toBeUndefined(); expect(r.body.withholdingTax).toBeUndefined(); expect(r.body.stampDuty).toBeUndefined();
    const ref = await request(app).get('/api/v1/settings/reference').set(authed(t));
    expect(ref.body.vatRates).toEqual([]);
  });
  it('enregistre devises et numérotation ; valide la cohérence (doublons, devise de base inconnue)', async () => {
    const t = (await login('admin@core.test')).token;
    const put = (b: object) => request(app).put('/api/v1/settings').set(authed(t)).send(b);
    const ok = await put({ currencies: [{ code: 'TND', decimals: 3 }, { code: 'EUR', decimals: 2 }], baseCurrency: 'TND', numbering: [{ docType: 'quotation', prefix: 'D' }] });
    expect(ok.status).toBe(200); expect(ok.body.currencies).toHaveLength(2);
    expect((await put({ baseCurrency: 'USD', currencies: [{ code: 'TND', decimals: 3 }] })).status).toBe(422);
    expect((await put({ numbering: [{ docType: 'invoice' }, { docType: 'invoice' }] })).status).toBe(422);
    expect((await put({ vatRates: [{ code: 'A', rate: 1 }] })).status).toBe(422); // champ supprimé : refusé
  });
});

describe('utilisateurs : validation, pagination, filtres, rapport', () => {
  it('politique de mot de passe, doublon d’e-mail, pagination serveur et statistiques', async () => {
    const t = (await login('admin@core.test')).token;
    const mk = (i: number, pwd = 'Str0ng#Passw0rd') => request(app).post('/api/v1/users').set(authed(t))
      .send({ name: `User ${i}`, username: `user${i}`, email: `u${i}@core.test`, password: pwd, roleId: C.adminRoleId.toString() });
    expect((await mk(0, 'weakpass')).status).toBe(422);
    for (let i = 1; i <= 5; i++) expect((await mk(i)).status).toBe(201);
    expect((await mk(1)).status).toBe(409);
    const p = await request(app).get('/api/v1/users?page=2&limit=2&sort=name').set(authed(t));
    expect(p.body.items).toHaveLength(2); expect(p.body.total).toBe(6); expect(p.body.page).toBe(2);
    expect((await request(app).get('/api/v1/users?q=u3').set(authed(t))).body.total).toBe(1);
    expect((await request(app).get('/api/v1/users?limit=1000').set(authed(t))).status).toBe(422);
    const adm = await request(app).get('/api/v1/users').set(authed(t));
    const id = adm.body.items.find((u: { email: string }) => u.email === 'u1@core.test').id;
    await request(app).patch(`/api/v1/users/${id}/active`).set(authed(t)).send({ isActive: false });
    const s = await request(app).get('/api/v1/users/stats').set(authed(t));
    expect(s.body).toEqual({ active: 5, inactive: 1, total: 6 });
    expect((await request(app).get('/api/v1/users?status=inactive').set(authed(t))).body.total).toBe(1);
    // auto-désactivation interdite
    expect((await request(app).patch(`/api/v1/users/${C.adminId}/active`).set(authed(t)).send({ isActive: false })).status).toBe(400);
  });
  it('réinitialisation par administrateur : mot de passe temporaire + changement exigé', async () => {
    const t = (await login('admin@core.test')).token;
    const list = await request(app).get('/api/v1/users?q=u2').set(authed(t));
    const id = list.body.items[0].id;
    expect((await request(app).post(`/api/v1/users/${id}/reset-password`).set(authed(t)).send({ newPassword: 'weak' })).status).toBe(422);
    expect((await request(app).post(`/api/v1/users/${id}/reset-password`).set(authed(t)).send({ newPassword: 'T3mp#Passw0rd!' })).status).toBe(204);
    const l = await login('u2@core.test', 'T3mp#Passw0rd!');
    expect(l.res.status).toBe(200);
    expect(l.res.body.user.mustChangePassword).toBe(true);
  });
});

describe('infrastructure HTTP', () => {
  it('health, 404 JSON, en-têtes de sécurité, swagger', async () => {
    const h = await request(app).get('/api/health');
    expect(h.status).toBe(200);
    expect(h.headers['x-powered-by']).toBeUndefined();
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    const nf = await request(app).get('/api/v1/nope');
    expect(nf.status).toBe(404); expect(nf.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/docs/').redirects(1)).status).toBe(200);
  });
});
