import { spawnSync } from 'node:child_process';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, login, makeCompany, makeUser, PWD, setupDb, teardownDb } from './helpers.js';
import { setMailTransport } from '../src/services/mail.service.js';
import { RefreshToken } from '../src/models/refresh-token.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';

beforeAll(async () => { await setupDb(); await makeCompany('Sec', 'admin@sec.test'); });
afterAll(teardownDb);

describe('révocation immédiate des access tokens', () => {
  it('logout : l’access token est refusé aussitôt (sans attendre l’expiration)', async () => {
    const { token, cookie } = await login('admin@sec.test');
    expect((await request(app).get('/api/v1/auth/me').set(authed(token))).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie!).set(authed(token))).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set(authed(token))).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'logout' })).toBeGreaterThan(0);
  });
  it('logout avec access token seul (cookie perdu) révoque aussi la session', async () => {
    const { token } = await login('admin@sec.test');
    await request(app).post('/api/v1/auth/logout').set(authed(token));
    expect((await request(app).get('/api/v1/auth/me').set(authed(token))).status).toBe(401);
  });
  it('un logout ne touche pas les autres sessions du même utilisateur', async () => {
    const a = await login('admin@sec.test'); const b = await login('admin@sec.test');
    await request(app).post('/api/v1/auth/logout').set('Cookie', a.cookie!);
    expect((await request(app).get('/api/v1/auth/me').set(authed(a.token))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(authed(b.token))).status).toBe(200);
  });
  it('la rotation du refresh conserve la session : le nouvel access token reste valide, pas l’ancien après logout', async () => {
    const a = await login('admin@sec.test');
    const r = await request(app).post('/api/v1/auth/refresh').set('Cookie', a.cookie!);
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(authed(r.body.accessToken))).status).toBe(200);
    await request(app).post('/api/v1/auth/logout').set('Cookie', (r.headers['set-cookie'] as unknown as string[])[0]!);
    expect((await request(app).get('/api/v1/auth/me').set(authed(r.body.accessToken))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(authed(a.token))).status).toBe(401);
  });
  it('changement de mot de passe et réinitialisation admin révoquent toutes les sessions', async () => {
    const admin = await login('admin@sec.test');
    const { user } = await makeUser((await import('../src/models/user.model.js').then((m) => m.User.findOne({ email: 'admin@sec.test' })))!.companyId, 'v@sec.test', []);
    const s1 = await login('v@sec.test'); const s2 = await login('v@sec.test');
    await request(app).post(`/api/v1/users/${user._id}/reset-password`).set(authed(admin.token)).send({ newPassword: 'Rst#Passw0rd!x' }).expect(204);
    expect((await request(app).get('/api/v1/auth/me').set(authed(s1.token))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(authed(s2.token))).status).toBe(401);
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: { $exists: false } })).toBe(0);
  });
  it('un access token sans sid (ancien format) ou signé par un autre secret est refusé', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const bad1 = jwt.sign({ sub: '6afe0bdb7cd75d8955553c3a' }, process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-0123456789-0123456789');
    const bad2 = jwt.sign({ sub: 'x', sid: 'y' }, 'a'.repeat(40));
    expect((await request(app).get('/api/v1/auth/me').set(authed(bad1))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(authed(bad2))).status).toBe(401);
  });
});

describe('SMTP et réinitialisation par e-mail', () => {
  it('envoie un e-mail contenant le lien ; le jeton n’est jamais dans la réponse HTTP et fonctionne une seule fois', async () => {
    const sent: { to: string; text: string }[] = [];
    const t = nodemailer.createTransport({ jsonTransport: true });
    t.sendMail = (async (m: { to: string; text: string }) => { sent.push(m); return {}; }) as never;
    setMailTransport(t);
    const r = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@sec.test' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('admin@sec.test');
    const token = /reset-password\?token=([\w-]+)/.exec(sent[0]!.text)![1]!;
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Mail#Reset2026x' })).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Mail#Reset2026y' })).status).toBe(400);
    // compte inconnu : même réponse, aucun e-mail
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@sec.test' })).status).toBe(200);
    expect(sent).toHaveLength(1);
    setMailTransport(null);
    const u = await (await import('../src/models/user.model.js')).User.findOne({ email: 'admin@sec.test' });
    u!.passwordHash = await (await import('../src/services/password.service.js')).hashPassword(PWD); await u!.save();
  });
  it('GET /auth/config indique si la réinitialisation est active', async () => {
    const r = await request(app).get('/api/v1/auth/config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ passwordResetEnabled: true }); // hors production
  });
});

describe('configuration de production', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config/env.ts').then(m=>console.log('RESET='+m.passwordResetEnabled))"], {
    env: { PATH: process.env.PATH!, SMTP_HOST: '', SMTP_FROM: '', ...env }, encoding: 'utf8', cwd: process.cwd(),
  });
  const base = { NODE_ENV: 'production', MONGO_URI: 'mongodb://x', JWT_ACCESS_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90aabbccdd', JWT_REFRESH_SECRET: '0f9e8d7c6b5a49382716f5e4d3c2b1a0ffeeddcc',
    COOKIE_SECURE: 'true', CORS_ORIGIN: 'https://erp.exemple.tn', APP_URL: 'https://erp.exemple.tn' };
  it('refuse de démarrer avec des réglages dangereux', () => {
    for (const bad of <Record<string, string>[]>[{ COOKIE_SECURE: 'false' }, { JWT_ACCESS_SECRET: 'change-me-access-secret-min-32-chars-xxxx' }, { JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET },
      { CORS_ORIGIN: '*' }, { CORS_ORIGIN: 'http://erp.exemple.tn' }, { BCRYPT_ROUNDS: '4' }, { DEV_LOG_RESET_TOKEN: 'true' }, { APP_URL: 'http://x' }]) {
      const r = run({ ...base, ...bad });
      expect(r.status, JSON.stringify(bad)).not.toBe(0);
    }
  });
  it('accepte une configuration saine ; réinitialisation désactivée sans SMTP, activée avec', () => {
    const ok = run(base);
    expect(ok.status).toBe(0); expect(ok.stdout).toContain('RESET=false');
    const smtp = run({ ...base, SMTP_HOST: 'smtp.exemple.tn', SMTP_FROM: 'ERP <no-reply@exemple.tn>' });
    expect(smtp.status).toBe(0); expect(smtp.stdout).toContain('RESET=true');
    expect(run({ ...base, SMTP_HOST: 'smtp.exemple.tn' }).status).not.toBe(0); // SMTP_FROM requis
  });
});
