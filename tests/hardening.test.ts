import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authed, companyWithAdmin, setupDb, teardownDb } from './helpers.js';
import { J } from './sales.helpers.js';
import { safeText } from '../src/services/export.service.js';
import { swaggerEnabled } from '../src/config/env.js';

let A: Awaited<ReturnType<typeof companyWithAdmin>>; let B: Awaited<ReturnType<typeof companyWithAdmin>>;
beforeAll(async () => { await setupDb(); A = await companyWithAdmin('Alpha', 'admin@a.test'); B = await companyWithAdmin('Beta', 'admin@b.test'); });
afterAll(teardownDb);

describe('disponibilité et configuration', () => {
  it('/api/ready : 200 tant que MongoDB répond (sonde de disponibilité distincte de /api/health)', async () => {
    const r = await request(app).get('/api/ready'); expect(r.status).toBe(200); expect(r.body).toMatchObject({ status: 'ready', db: 'up' }); expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' });
  });
  it('Swagger : désactivé par défaut en production, activé ailleurs, forçable', () => {
    expect(swaggerEnabled({ NODE_ENV: 'production' })).toBe(false); expect(swaggerEnabled({ NODE_ENV: 'development' })).toBe(true); expect(swaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(true); expect(swaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })).toBe(false);
  });
});

describe('en-têtes HTTP et CORS', () => {
  it('en-têtes de sécurité présents, aucune signature de framework', async () => {
    const h = (await request(app).get('/api/health')).headers; expect(h['x-powered-by']).toBeUndefined(); expect(h['x-content-type-options']).toBe('nosniff'); expect(h['strict-transport-security']).toMatch(/max-age=/); expect(h['content-security-policy']).toMatch(/default-src 'self'/);
    expect(h['x-frame-options']).toBe('SAMEORIGIN'); expect(h['referrer-policy']).toBe('no-referrer'); expect(h['cross-origin-resource-policy']).toBe('same-origin');
  });
  it('CORS : origine autorisée acceptée avec cookies, origine inconnue sans en-tête Access-Control-Allow-Origin', async () => {
    const ok = await request(app).options('/api/v1/customers').set('Origin', 'http://localhost:4200').set('Access-Control-Request-Method', 'GET'); expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4200'); expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).options('/api/v1/customers').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET'); expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const get = await request(app).get('/api/health').set('Origin', 'https://evil.example'); expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('protection des routes', () => {
  const GETS = ['/customers', '/suppliers', '/products', '/quotations', '/proformas', '/invoices', '/delivery-notes', '/purchase-orders', '/goods-receipts', '/purchase-invoices', '/imports', '/warehouses', '/stock/overview', '/stock-transfers', '/inventories', '/costs/report', '/expenses', '/expense-categories',
    '/treasury/accounts', '/treasury/position', '/supplier-payments', '/accounting/entries', '/accounting/receivables', '/reports/catalog', '/reports/dashboard', '/reports/sales-by-period', '/users', '/roles', '/settings', '/audit-logs', '/companies', '/fiscal/rules'];
  it('aucune route métier ne répond sans jeton (401), ni avec un jeton invalide', async () => {
    for (const p of GETS) { const r = await request(app).get(`/api/v1${p}`); expect(r.status, p).toBe(401); const b = await request(app).get(`/api/v1${p}`).set(authed('x.y.z')); expect(b.status, `jeton invalide ${p}`).toBe(401); }
  });
  it('une route inconnue renvoie un 404 JSON sans détail technique', async () => { const r = await request(app).get('/api/v1/inexistant').set(authed(A.token)); expect(r.status).toBe(404); expect(JSON.stringify(r.body)).not.toMatch(/stack|node_modules|at \w+ \(/); });
  it('les réponses ne contiennent jamais de hachage de mot de passe ni de jeton de réinitialisation', async () => {
    for (const p of ['/users', '/auth/me', '/roles', '/companies']) { const r = await J(A.token).get(p); expect(JSON.stringify(r.body), p).not.toMatch(/passwordHash|\$2[aby]\$|resetToken|refreshToken/i); }
  });
});

describe('injection et validation', () => {
  it('opérateurs MongoDB dans la requête ou le corps : refusés (400/422), jamais exécutés', async () => {
    const j = J(A.token);
    for (const q of ['status[$ne]=x', 'q[$regex]=.*', 'customerId[$gt]=', 'page[$gt]=1']) expect([400, 422], q).toContain((await j.get(`/customers?${q}`)).status);
    expect([400, 422]).toContain((await j.get('/reports/sales-by-period?customerId[$ne]=1')).status); expect([400, 422]).toContain((await j.post('/customers', { name: { $ne: '' } })).status);
    const login = await request(app).post('/api/v1/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } }); expect([400, 422]).toContain(login.status);
  });
  it('expression régulière de recherche : caractères spéciaux neutralisés (pas de ReDoS ni d’erreur)', async () => {
    const j = J(A.token); for (const q of ['(a+)+$', '.*', '[', '\\', 'a{1,}{1,}']) expect((await j.get(`/customers?q=${encodeURIComponent(q)}`)).status, q).toBe(200);
  });
  it('affectation de masse : champs non autorisés (companyId, rôle, drapeau plateforme) refusés', async () => {
    const j = J(A.token); expect((await j.post('/customers', { name: 'Intrus', companyId: '000000000000000000000001' })).status).toBe(422); expect((await j.post('/customers', { name: 'Intrus', balanceMinor: 99999 })).status).toBe(422);
    expect((await j.post('/users', { name: 'X', username: 'x', email: 'x@a.test', password: 'Str0ng#Passw0rd', isPlatformAdmin: true })).status).toBe(422);
  });
  it('corps JSON trop volumineux : 413 ; JSON invalide : 400', async () => {
    const big = await request(app).post('/api/v1/customers').set(authed(A.token)).send({ name: 'x'.repeat(2_000_000) }); expect(big.status).toBe(413);
    const bad = await request(app).post('/api/v1/customers').set(authed(A.token)).set('Content-Type', 'application/json').send('{"name":'); expect(bad.status).toBe(400);
  });
  it('identifiants malformés : 422 (pas d’erreur serveur) ; identifiant d’une autre société : 404', async () => {
    const j = J(A.token); expect((await j.get('/customers/pas-un-id')).status).toBe(422); const c = (await J(B.token).post('/customers', { name: 'Client B', taxId: 'B1' })).body.id; expect((await j.get(`/customers/${c}`)).status).toBe(404); expect((await j.put(`/customers/${c}`, { name: 'Piraté' })).status).toBe(404); expect((await j.del(`/customers/${c}`)).status).toBe(404);
  });
});

describe('exports', () => {
  it('neutralisation des formules (CSV / Excel) : =, +, -, @, tabulation, retour chariot', () => {
    for (const v of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) expect(safeText(v), v).toBe(`'${v}`);
    expect(safeText('Client normal')).toBe('Client normal'); expect(safeText(12)).toBe(12);
  });
  it('un export CSV de rapport protège les cellules texte venant de la base', async () => {
    const j = J(A.token); await j.put('/accounting/settings', { allowExpenseSelfValidation: true }); const cat = (await j.post('/expense-categories', { name: '=cmd|\'/c calc\'!A1' })).body.id; const acc = (await j.post('/treasury/accounts', { code: 'BNK', name: 'Banque', type: 'bank', openingBalanceMinor: 100000 })).body.id;
    const e = (await j.post('/expenses', { categoryId: cat, amountMinor: 1000, date: new Date().toISOString().slice(0, 10), beneficiary: 'Bénéficiaire', method: 'cash', treasuryAccountId: acc })).body; expect((await j.post(`/expenses/${e.id}/submit`)).status).toBe(200); const v = await j.post(`/expenses/${e.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200);
    const r = await request(app).get('/api/v1/reports/expenses-by-category/export?format=csv').set(authed(A.token)).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200); const text = (r.body as Buffer).toString(); expect(text, text).toMatch(/cmd/); expect(text).toContain("'=cmd"); expect(text).not.toMatch(/(^|[;,\n"])=cmd/);
  });
});

describe('journal d’audit : ressources filtrables', () => {
  it('ne liste que les ressources réellement présentes dans le journal de la société', async () => {
    const a = (await J(A.token).get('/audit-logs/resources')).body as string[]; expect(a).toContain('expense'); expect(a).toContain('auth'); expect(a).toEqual([...a].sort());
    const b = (await J(B.token).get('/audit-logs/resources')).body as string[]; expect(b).not.toContain('expense'); expect((await request(app).get('/api/v1/audit-logs/resources')).status).toBe(401);
  });
});

