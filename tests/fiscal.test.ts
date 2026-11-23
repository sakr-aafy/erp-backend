import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeUser, setupDb, teardownDb } from './helpers.js';
import { J, line, plusDays, quoteBody, salesCompany, today, type Ctx } from './sales.helpers.js';
import { FiscalRule } from '../src/models/fiscal-rule.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Customer } from '../src/models/customer.model.js';

let A: Ctx;
beforeAll(async () => { await setupDb(); A = await salesCompany('Alpha', 'admin@a.test'); });
afterAll(teardownDb);

const vatRule = (code: string, from: string, ratePct: number, extra: object = {}) => ({ kind: 'vat', code, label: code, effectiveFrom: from, vat: { regime: 'taxable', ratePct }, ...extra });

describe('règles fiscales : brouillon, validation, historique', () => {
  it('une règle créée est un BROUILLON : jamais appliquée tant qu’elle n’est pas validée', async () => {
    const r = await A.j.post('/fiscal/rules', vatRule('NEW9', '2000-01-01', 9)); expect(r.status).toBe(201); expect(r.body.status).toBe('draft');
    const q = await A.j.post('/quotations', quoteBody(A, [{ designation: 'Prestation', quantity: 1, unitPriceMinor: 1000, vatCode: 'NEW9' }]));
    expect(q.status).toBe(400); expect(q.body.error.message).toMatch(/aucune règle validée/);
    expect((await A.j.get('/fiscal/vat-catalog')).body.map((v: { code: string }) => v.code)).not.toContain('NEW9');
    // un article ne peut pas utiliser un code sans règle validée
    expect((await A.j.post('/products', { reference: 'N9', name: 'Neuf', unitId: A.unitId, vatRateCode: 'NEW9' })).status).toBe(400);
    expect((await A.j.post(`/fiscal/rules/${r.body.id}/validate`)).status).toBe(200);
    expect((await A.j.post('/quotations', quoteBody(A, [{ designation: 'Prestation', quantity: 1, unitPriceMinor: 1000, vatCode: 'NEW9' }]))).status).toBe(201);
  });
  it('permissions : créer ≠ valider (settings:validate dédié)', async () => {
    await makeUser(A.companyId, 'compta@a.test', ['settings:view', 'settings:create', 'settings:update']);
    const t = J((await login('compta@a.test')).token);
    const r = await t.post('/fiscal/rules', vatRule('PERM', '2000-01-01', 5)); expect(r.status).toBe(201);
    expect((await t.post(`/fiscal/rules/${r.body.id}/validate`)).status).toBe(403);
    await makeUser(A.companyId, 'sans@a.test', []);
    const n = J((await login('sans@a.test')).token);
    expect((await n.post('/fiscal/rules', vatRule('X', '2000-01-01', 5))).status).toBe(403);
    expect((await n.get('/fiscal/rules')).status).toBe(403);
    expect((await n.get('/fiscal/vat-catalog')).status).toBe(200); // catalogue ouvert aux utilisateurs authentifiés
  });
  it('règle validée immuable ; nouvelle version avec date d’effet postérieure ; résolution par date', async () => {
    const v1 = (await A.j.post('/fiscal/rules', vatRule('HIST', '2020-01-01', 18))).body;
    await A.j.post(`/fiscal/rules/${v1.id}/validate`);
    expect((await A.j.put(`/fiscal/rules/${v1.id}`, vatRule('HIST', '2020-01-01', 19))).status).toBe(409);
    expect((await A.j.del(`/fiscal/rules/${v1.id}`)).status).toBe(409);
    expect((await A.j.post(`/fiscal/rules/${v1.id}/validate`)).status).toBe(409);
    // version postérieure
    const v2 = (await A.j.post('/fiscal/rules', vatRule('HIST', '2025-06-01', 19))).body;
    expect((await A.j.post('/fiscal/rules', vatRule('HIST', '2025-06-01', 20))).status).toBe(409); // même code + même date
    const v0 = (await A.j.post('/fiscal/rules', vatRule('HIST', '2019-01-01', 17))).body;
    expect((await A.j.post(`/fiscal/rules/${v0.id}/validate`)).status).toBe(409); // antérieure à la dernière version validée
    expect((await A.j.post(`/fiscal/rules/${v2.id}/validate`)).status).toBe(200);
    const price = { designation: 'Service', quantity: 1, unitPriceMinor: 100_000, vatCode: 'HIST' };
    const at = async (d: string) => (await A.j.post('/quotations', quoteBody(A, [price], { issueDate: d, validUntil: '2030-01-01' }))).body.totals.totalVatMinor;
    expect(await at('2024-12-31')).toBe(18_000);  // ancienne règle
    expect(await at('2025-05-31')).toBe(18_000);
    expect(await at('2025-06-01')).toBe(19_000);  // nouvelle règle dès sa date d'effet
    const hist = (await A.j.get('/fiscal/rules?kind=vat&code=HIST')).body;
    expect(hist.map((r: { effectiveFrom: string }) => r.effectiveFrom.slice(0, 10))).toEqual(['2025-06-01', '2020-01-01', '2019-01-01']); // historique conservé
    expect(hist.find((r: { isCurrent: boolean }) => r.isCurrent).effectiveFrom.slice(0, 10)).toBe('2025-06-01');
    // le document existant garde son snapshot (taux d'origine) même après changement de règle
  });
  it('retrait d’une règle : version « inactive » à partir de sa date d’effet', async () => {
    const v1 = (await A.j.post('/fiscal/rules', vatRule('OLD', '2000-01-01', 10))).body; await A.j.post(`/fiscal/rules/${v1.id}/validate`);
    const v2 = (await A.j.post('/fiscal/rules', vatRule('OLD', plusDays(0), 10, { active: false }))).body; await A.j.post(`/fiscal/rules/${v2.id}/validate`);
    const body = (d: string) => quoteBody(A, [{ designation: 'x', quantity: 1, unitPriceMinor: 1000, vatCode: 'OLD' }], { issueDate: d });
    expect((await A.j.post('/quotations', body('2024-01-01'))).status).toBe(201);
    expect((await A.j.post('/quotations', body(today()))).status).toBe(400);
  });
  it('modèle de démarrage : 19/13/7/0/exonéré/suspendu créés en BROUILLON uniquement', async () => {
    const r = await A.j.post('/fiscal/templates/vat', { effectiveFrom: '2030-01-01' });
    expect(r.status).toBe(201); expect(r.body.map((x: { code: string }) => x.code).sort()).toEqual(['EXO', 'SUS', 'T0', 'T13', 'T19', 'T7'].sort());
    expect(r.body.every((x: { status: string }) => x.status === 'draft')).toBe(true);
    expect(r.body.find((x: { code: string }) => x.code === 'SUS').vat.regime).toBe('suspended');
    expect(await FiscalRule.countDocuments({ companyId: A.companyId, status: 'draft', effectiveFrom: new Date('2030-01-01') })).toBe(6);
    expect((await A.j.post('/fiscal/templates/vat', { effectiveFrom: '2030-01-01' })).body).toEqual([]); // idempotent
  });
  it('valide les formes : taux requis si taxable, timbre sans type de document', async () => {
    expect((await A.j.post('/fiscal/rules', { kind: 'vat', code: 'Z', effectiveFrom: '2020-01-01', vat: { regime: 'taxable' } })).status).toBe(422);
    expect((await A.j.post('/fiscal/rules', { kind: 'stamp', code: 'Z', effectiveFrom: '2020-01-01', stamp: { amountMinor: 1000, docTypes: [] } })).status).toBe(422);
    expect((await A.j.post('/fiscal/rules', vatRule('Z', '2020-01-01', 150))).status).toBe(422);
  });
  it('journalise création et validation avec le détail de la règle', async () => {
    const l = await AuditLog.findOne({ resource: 'fiscal-rule', action: 'validate', 'meta.code': 'HIST' }).sort({ at: -1 }).lean();
    expect(l).toBeTruthy(); expect((l!.meta as { vat: { ratePct: number } }).vat.ratePct).toBe(19);
  });
});

describe('totaux : plusieurs taux, jamais de taux par défaut', () => {
  it('chaque ligne prend le code de TVA de son article (19 / 13 / 7 / service)', async () => {
    const r = await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(A.products.a19, 2), line(A.products.b13, 1), line(A.products.c7, 5), line(A.products.svc, 1)] });
    expect(r.status).toBe(200);
    const g = Object.fromEntries(r.body.totals.vatGroups.map((x: { vatCode: string; baseMinor: number; vatMinor: number }) => [x.vatCode, [x.baseMinor, x.vatMinor]]));
    expect(g).toEqual({ T19: [280_000, 53_200], T13: [50_000, 6_500], T7: [100_000, 7_000] });
    expect(r.body.totals.totalHtMinor).toBe(430_000); expect(r.body.totals.totalTtcMinor).toBe(430_000 + 66_700);
  });
  it('une ligne libre sans code de TVA est refusée (le 19 % n’est jamais appliqué automatiquement)', async () => {
    const r = await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [{ designation: 'Libre', quantity: 1, unitPriceMinor: 1000 }] });
    expect(r.status).toBe(400); expect(r.body.error.message).toMatch(/code de TVA requis/);
  });
  it('régimes zéro / exonéré : TVA nulle ; surcharge du code possible par ligne', async () => {
    const r = await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(A.products.a19, 1, { vatCode: 'EXO' }), line(A.products.b13, 1, { vatCode: 'T0' })] });
    expect(r.body.totals.totalVatMinor).toBe(0); expect(r.body.totals.vatGroups.map((g: { regime: string }) => g.regime)).toEqual(['exempt', 'zero']);
  });
  it('remises de ligne et globale, arrondis en millimes', async () => {
    const r = await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, globalDiscountPct: 10, lines: [{ designation: 'x', quantity: 3, unitPriceMinor: 12_345, discountPct: 12.5, vatCode: 'T19' }] });
    expect(r.body.lines[0].netHtMinor).toBe(32_406); expect(r.body.totals.globalDiscountMinor).toBe(3_241); expect(r.body.totals.totalHtMinor).toBe(29_165);
    expect(r.body.totals.totalVatMinor).toBe(5_541); // 29165 × 19 % = 5541,35
    expect((await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, globalDiscountPct: 5, globalDiscountMinor: 100, lines: [line(A.products.a19)] })).status).toBe(422);
  });
  it('le client ne peut imposer aucun montant calculé (champs inconnus refusés)', async () => {
    for (const bad of [{ totals: { totalHtMinor: 1 } }, { lines: [{ ...line(A.products.a19), netHtMinor: 1 }] }, { lines: [{ ...line(A.products.a19), vat: { ratePct: 0 } }] }]) {
      expect((await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(A.products.a19)], ...bad })).status).toBe(422);
    }
  });
});

describe('retenue à la source et timbre : jamais activés sans règle validée et conditions remplies', () => {
  const calc = (extra: object = {}, lines = [line(A.products.a19)]) => A.j.post('/sales/calculate', { docType: 'invoice', customerId: A.customerId, lines, ...extra });
  it('aucune retenue ni timbre par défaut', async () => {
    const r = await calc({ withholdingOperationType: 'SERVICES' });
    expect(r.body.totals.withholdingMinor).toBe(0); expect(r.body.totals.stampMinor).toBe(0); expect(r.body.withholding).toBeNull(); expect(r.body.stamp).toBeNull();
  });
  it('retenue : brouillon sans effet ; validée → appliquée si type d’opération + client assujetti + seuil', async () => {
    const w = (await A.j.post('/fiscal/rules', { kind: 'withholding', code: 'SERVICES', effectiveFrom: '2000-01-01', withholding: { ratePct: 1.5, base: 'ttc', minTotalMinor: 100_000 } })).body;
    expect((await calc({ withholdingOperationType: 'SERVICES' })).body.totals.withholdingMinor).toBe(0); // brouillon
    await A.j.post(`/fiscal/rules/${w.id}/validate`);
    expect((await calc({ withholdingOperationType: 'SERVICES' })).body.totals.withholdingMinor).toBe(0); // client non assujetti
    await Customer.updateOne({ _id: A.customerId }, { subjectToWithholding: true });
    const ok = await calc({ withholdingOperationType: 'SERVICES' });
    expect(ok.body.totals.totalTtcMinor).toBe(119_000); expect(ok.body.totals.withholdingMinor).toBe(1_785); expect(ok.body.totals.totalPayableMinor).toBe(117_215);
    expect(ok.body.withholding).toMatchObject({ code: 'SERVICES', ratePct: 1.5, base: 'ttc' });
    expect((await calc()).body.totals.withholdingMinor).toBe(0);                                  // opération non indiquée
    expect((await calc({ withholdingOperationType: 'AUTRE' })).body.totals.withholdingMinor).toBe(0); // règle inexistante
    expect((await calc({ withholdingOperationType: 'SERVICES' }, [line(A.products.c7)])).body.totals.withholdingMinor).toBe(0); // sous le seuil (21 400 < 100 000)
  });
  it('timbre : par type de document, seuil, exonération client', async () => {
    const s = (await A.j.post('/fiscal/rules', { kind: 'stamp', code: 'TIMBRE', effectiveFrom: '2000-01-01', stamp: { amountMinor: 1_000, docTypes: ['invoice'], minTotalMinor: 50_000 } })).body;
    await A.j.post(`/fiscal/rules/${s.id}/validate`);
    const r = await calc();
    expect(r.body.totals).toMatchObject({ stampMinor: 1_000, totalTtcMinor: 119_000 }); expect(r.body.stamp.code).toBe('TIMBRE');
    expect((await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(A.products.a19)] })).body.totals.stampMinor).toBe(0); // autre type de document
    expect((await calc({}, [line(A.products.c7)])).body.totals.stampMinor).toBe(0); // sous le seuil
    await Customer.updateOne({ _id: A.customerId }, { stampExempt: true });
    expect((await calc()).body.totals.stampMinor).toBe(0);                          // client exonéré
    await Customer.updateOne({ _id: A.customerId }, { stampExempt: false });
    // deux règles de timbre pour le même type : configuration ambiguë refusée
    const s2 = (await A.j.post('/fiscal/rules', { kind: 'stamp', code: 'TIMBRE2', effectiveFrom: '2000-01-01', stamp: { amountMinor: 500, docTypes: ['invoice'] } })).body; await A.j.post(`/fiscal/rules/${s2.id}/validate`);
    expect((await calc()).status).toBe(409);
  });
});
