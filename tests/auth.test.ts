import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, login, makeCompany, makeUser, PWD, setupDb, teardownDb } from './helpers.js';
import { User } from '../src/models/user.model.js';
import { RefreshToken } from '../src/models/refresh-token.model.js';

beforeAll(async () => { await setupDb(); await makeCompany('Acme', 'admin@acme.test'); });
afterAll(teardownDb);

describe('authentification', () => {
  it('connecte un utilisateur valide et renvoie profil + permissions + cookie httpOnly', async () => {
    const { res } = await login('admin@acme.test');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.permissions).toContain('invoices:validate');
    expect(res.headers['set-cookie']![0]).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
  it('rejette un mauvais mot de passe et un e-mail inconnu avec le même message', async () => {
    const a = await request(app).post('/api/v1/auth/login').send({ email: 'admin@acme.test', password: 'wrong' });
    const b = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@acme.test', password: 'wrong' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });
  it('refuse les injections NoSQL', async () => {
    const r1 = await request(app).post('/api/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(r1.status).toBe(400);
    const { token } = await login('admin@acme.test');
    const r2 = await request(app).get('/api/v1/users?q[$ne]=x').set(authed(token));
    expect(r2.status).toBe(400);
  });
  it('rejette les requêtes sans jeton ou avec jeton invalide', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(authed('abc.def.ghi'))).status).toBe(401);
  });
  it('rotation du refresh token et révocation de la famille en cas de rejeu', async () => {
    const { cookie } = await login('admin@acme.test');
    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie!);
    expect(r1.status).toBe(200);
    const newCookie = (r1.headers['set-cookie'] as unknown as string[])[0]!;
    expect(newCookie).not.toBe(cookie);
    // rejeu de l'ancien jeton => refusé + nouvelle session aussi révoquée
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie)).status).toBe(401);
  });
  it('déconnexion révoque le refresh token', async () => {
    const { cookie } = await login('admin@acme.test');
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie!)).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
  });
  it('verrouille le compte après 5 échecs', async () => {
    await makeUser((await User.findOne({ email: 'admin@acme.test' }))!.companyId, 'lock@acme.test', []);
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: 'lock@acme.test', password: 'bad' });
    const r = await request(app).post('/api/v1/auth/login').send({ email: 'lock@acme.test', password: PWD });
    expect(r.status).toBe(423);
  });
  it('un utilisateur désactivé perd immédiatement son accès (access token + refresh)', async () => {
    const admin = await User.findOne({ email: 'admin@acme.test' });
    const { user } = await makeUser(admin!.companyId, 'deact@acme.test', ['users:view']);
    const { token, cookie } = await login('deact@acme.test');
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(200);
    const adminLogin = await login('admin@acme.test');
    const d = await request(app).patch(`/api/v1/users/${user._id}/active`).set(authed(adminLogin.token)).send({ isActive: false });
    expect(d.status).toBe(200);
    expect((await request(app).get('/api/v1/users').set(authed(token))).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect((await login('deact@acme.test')).res.status).toBe(403);
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: { $exists: false } })).toBe(0);
  });
  it('change le mot de passe en appliquant la politique', async () => {
    const { token } = await login('admin@acme.test');
    const weak = await request(app).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PWD, newPassword: 'short' });
    expect(weak.status).toBe(422);
    const ok = await request(app).post('/api/v1/auth/change-password').set(authed(token)).send({ currentPassword: PWD, newPassword: 'N3w#Passw0rd!x' });
    expect(ok.status).toBe(204);
    expect((await login('admin@acme.test', PWD)).res.status).toBe(401);
    expect((await login('admin@acme.test', 'N3w#Passw0rd!x')).res.status).toBe(200);
    // remise à l'état initial pour les autres tests
    const t2 = (await login('admin@acme.test', 'N3w#Passw0rd!x')).token;
    await request(app).post('/api/v1/auth/change-password').set(authed(t2)).send({ currentPassword: 'N3w#Passw0rd!x', newPassword: PWD });
  });
  it('réinitialisation du mot de passe par jeton à usage unique', async () => {
    const { forgotPassword } = await import('../src/modules/auth/auth.service.js');
    const token = await forgotPassword('admin@acme.test');
    expect(token).toBeTruthy();
    const bad = await request(app).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(30), newPassword: 'R3set#Passw0rd!' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'R3set#Passw0rd!' });
    expect(ok.status).toBe(204);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'R3set#Passw0rd!' })).status).toBe(400);
    expect((await login('admin@acme.test', 'R3set#Passw0rd!')).res.status).toBe(200);
    // forgot ne révèle pas l'existence du compte
    const f = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@acme.test' });
    expect(f.status).toBe(200);
    const u = await User.findOne({ email: 'admin@acme.test' });
    const { hashPassword } = await import('../src/services/password.service.js');
    u!.passwordHash = await hashPassword(PWD); await u!.save();
  });
});
