import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, login, makeCompany, makeUser, PWD, setupDb, teardownDb } from './helpers.js';
import { AuditLog } from '../src/models/audit-log.model.js';

let A: Awaited<ReturnType<typeof makeCompany>>, B: Awaited<ReturnType<typeof makeCompany>>;
beforeAll(async () => {
  await setupDb();
  A = await makeCompany('Alpha', 'admin@alpha.test', true);
  B = await makeCompany('Beta', 'admin@beta.test');
});
afterAll(teardownDb);

describe('RBAC (permissions séparées par action)', () => {
  it('view seul : lecture OK, création/modification/suppression/validation refusées', async () => {
    await makeUser(A.companyId, 'viewer@alpha.test', ['users:view', 'roles:view']);
    const { token } = await login('viewer@alpha.test');
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(200);
    const body = { name: 'X Y', username: 'xy', email: 'xy@alpha.test', password: PWD, roleId: A.adminRoleId.toString() };
    expect((await request(app).post('/api/v1/users').set(authed(token)).send(body)).status).toBe(403);
    expect((await request(app).put(`/api/v1/users/${A.adminId}`).set(authed(token)).send({ name: 'Zed' })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/roles/${A.adminRoleId}`).set(authed(token))).status).toBe(403);
    expect((await request(app).get('/api/v1/audit-logs').set(authed(token))).status).toBe(403);
    expect((await request(app).get('/api/v1/settings').set(authed(token))).status).toBe(403);
  });
  it('create sans view : création autorisée, lecture refusée', async () => {
    await makeUser(A.companyId, 'creator@alpha.test', ['users:create']);
    const { token } = await login('creator@alpha.test');
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(403);
    const r = await request(app).post('/api/v1/users').set(authed(token)).send({ name: 'New One', username: 'newone', email: 'new@alpha.test', password: PWD, roleId: A.adminRoleId.toString() });
    expect(r.status).toBe(201);
  });
  it('un changement de rôle s’applique immédiatement', async () => {
    const { user, role } = await makeUser(A.companyId, 'chg@alpha.test', ['users:view']);
    const { token } = await login('chg@alpha.test');
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(200);
    const adm = (await login('admin@alpha.test')).token;
    await request(app).put(`/api/v1/roles/${role._id}`).set(authed(adm)).send({ permissions: [] });
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(403);
    expect(user).toBeTruthy();
  });
  it('rejette les permissions inconnues et protège le rôle système', async () => {
    const adm = (await login('admin@alpha.test')).token;
    expect((await request(app).post('/api/v1/roles').set(authed(adm)).send({ name: 'Bad', permissions: ['foo:bar'] })).status).toBe(422);
    expect((await request(app).put(`/api/v1/roles/${A.adminRoleId}`).set(authed(adm)).send({ permissions: [] })).status).toBe(400);
    expect((await request(app).delete(`/api/v1/roles/${A.adminRoleId}`).set(authed(adm))).status).toBe(400);
    const r = await request(app).post('/api/v1/roles').set(authed(adm)).send({ name: 'Commercial', permissions: ['customers:view', 'customers:create'] });
    expect(r.status).toBe(201);
    expect((await request(app).delete(`/api/v1/roles/${r.body._id}`).set(authed(adm))).status).toBe(204);
  });
  it('interdit de supprimer un rôle attribué', async () => {
    const adm = (await login('admin@alpha.test')).token;
    const role = await request(app).post('/api/v1/roles').set(authed(adm)).send({ name: 'Utilisé', permissions: [] });
    await request(app).post('/api/v1/users').set(authed(adm)).send({ name: 'Dan D', username: 'dand', email: 'dan@alpha.test', password: PWD, roleId: role.body._id });
    expect((await request(app).delete(`/api/v1/roles/${role.body._id}`).set(authed(adm))).status).toBe(409);
  });
});

describe('multi-société (isolation)', () => {
  it('une société ne voit ni ne modifie les données d’une autre', async () => {
    const a = (await login('admin@alpha.test')).token;
    const b = (await login('admin@beta.test')).token;
    const usersB = await request(app).get('/api/v1/users').set(authed(b));
    expect(usersB.body.items.every((u: { email: string }) => u.email.endsWith('@beta.test'))).toBe(true);
    expect((await request(app).get(`/api/v1/users/${A.adminId}`).set(authed(b))).status).toBe(404);
    expect((await request(app).put(`/api/v1/users/${A.adminId}`).set(authed(b)).send({ name: 'Hack' })).status).toBe(404);
    expect((await request(app).patch(`/api/v1/users/${A.adminId}/active`).set(authed(b)).send({ isActive: false })).status).toBe(404);
    expect((await request(app).get(`/api/v1/roles/${A.adminRoleId}`).set(authed(b))).status).toBe(404);
    // affecter un rôle d'une autre société est refusé
    const r = await request(app).post('/api/v1/users').set(authed(b)).send({ name: 'Cross T', username: 'cross', email: 'cross@beta.test', password: PWD, roleId: A.adminRoleId.toString() });
    expect(r.status).toBe(400);
    expect((await request(app).get('/api/v1/settings').set(authed(a))).body.companyId).toBe(A.companyId.toString());
    const logsB = await request(app).get('/api/v1/audit-logs').set(authed(b));
    expect(logsB.body.items.every((l: { companyId: string }) => l.companyId === B.companyId.toString())).toBe(true);
  });
  it('seul l’administrateur de plateforme gère les sociétés', async () => {
    const a = (await login('admin@alpha.test')).token;
    const b = (await login('admin@beta.test')).token;
    expect((await request(app).get('/api/v1/companies').set(authed(b))).status).toBe(403);
    const body = { company: { name: 'Gamma' }, admin: { name: 'Gam Admin', username: 'gadmin', email: 'admin@gamma.test', password: PWD } };
    expect((await request(app).post('/api/v1/companies').set(authed(b)).send(body)).status).toBe(403);
    expect((await request(app).post('/api/v1/companies').set(authed(a)).send(body)).status).toBe(201);
    expect((await login('admin@gamma.test')).res.status).toBe(200);
    // doublon d'e-mail => rien n'est créé (transaction annulée)
    const dup = await request(app).post('/api/v1/companies').set(authed(a)).send({ ...body, company: { name: 'Delta' } });
    expect(dup.status).toBe(409);
    const list = await request(app).get('/api/v1/companies').set(authed(a));
    expect(list.body.map((c: { name: string }) => c.name)).not.toContain('Delta');
  });
});

describe('traçabilité', () => {
  it('journalise connexions (succès/échec) et actions sensibles, consultable avec audit:view', async () => {
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@alpha.test', password: 'bad' });
    const a = (await login('admin@alpha.test')).token;
    await request(app).post('/api/v1/roles').set(authed(a)).send({ name: 'Audité', permissions: [] });
    const res = await request(app).get('/api/v1/audit-logs?limit=100').set(authed(a));
    expect(res.status).toBe(200);
    const kinds = res.body.items.map((l: { action: string; resource: string; success: boolean }) => `${l.resource}:${l.action}:${l.success}`);
    expect(kinds).toContain('role:create:true');
    expect(kinds).toContain('auth:login:true');
    expect(await AuditLog.countDocuments({ action: 'login', success: false })).toBeGreaterThan(0);
    const f = await request(app).get('/api/v1/audit-logs?resource=role').set(authed(a));
    expect(f.body.items.every((l: { resource: string }) => l.resource === 'role')).toBe(true);
  });
});
