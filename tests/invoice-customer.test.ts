/** Correction des coordonnées du client sur une facture validée : montants intacts, historique, droits et unicité. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeUser, setupDb, teardownDb } from './helpers.js';
import { J, line, logisticsCompany, quoteBody, type LCtx } from './sales.helpers.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Customer } from '../src/models/customer.model.js';
import { Invoice } from '../src/models/sales.model.js';

type Any = Record<string, any>;
let A: LCtx, B: LCtx; let SVC: string; let seq = 0;
const ok = (r: { status: number; body: Any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const details = (extra: object = {}) => ({ name: 'Société Corrigée', taxId: '1234567 a', phone: '71 000 111', email: 'Compta@Corrigee.tn', address: { street: '5 rue Neuve', city: 'Sfax', postalCode: '3000', country: 'Tunisie' }, reason: 'Matricule erroné', updateCustomer: false, ...extra });
const setup = async () => {
  const customer = ok(await A.j.post('/customers', { name: `Client coordonnées ${++seq}`, subjectToWithholding: false }), 201);
  const draft = ok(await A.j.post('/invoices', quoteBody({ ...A, customerId: customer.id }, [line(SVC, 2)], { validUntil: undefined })), 201);
  return { customer, draft };
};
const put = (id: string, body: object, j = A.j) => j.put(`/invoices/${id}/customer-details`, body);

beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Coord', 'admin@coord.test'); B = await logisticsCompany('Voisin', 'admin@voisin.test');
  SVC = ok(await A.j.post('/products', { reference: 'POSE-C', name: 'Pose', unitId: A.unitId, vatRateCode: 'T19', purchasePriceMinor: 1000, salePriceMinor: 90_000, kind: 'service' }), 201).id;
});
afterAll(teardownDb);

describe('coordonnées du client sur une facture validée', () => {
  it('brouillon refusé : il se modifie directement', async () => {
    const { draft } = await setup(); expect((await put(draft.id, details())).status).toBe(409);
  });

  it('corrige la facture seule : montants, numéro, solde et fiche inchangés ; historique et audit', async () => {
    const { customer, draft } = await setup(); const before = ok(await A.j.post(`/invoices/${draft.id}/validate`));
    const balance = (await Customer.findById(customer.id))!.balanceMinor;
    const after = ok(await put(before.id, details()));
    expect(after.customer).toMatchObject({ name: 'Société Corrigée', taxId: '1234567A', email: 'compta@corrigee.tn', phone: '+21671000111', address: { street: '5 rue Neuve', city: 'Sfax' }, code: customer.code });
    for (const k of ['number', 'status', 'totals', 'lines', 'schedule', 'issueDate', 'balanceDueMinor', 'customerId']) expect(after[k], k).toEqual(before[k]);
    expect(after.customerCorrections).toHaveLength(1);
    expect(after.customerCorrections[0]).toMatchObject({ reason: 'Matricule erroné', userName: 'Admin Coord', before: { name: customer.name, taxId: '' }, after: { name: 'Société Corrigée' } });
    expect((await Customer.findById(customer.id))!).toMatchObject({ name: customer.name, balanceMinor: balance });
    expect(await AuditLog.countDocuments({ action: 'correct-customer-details', resourceId: before.id })).toBe(1);
    expect((await put(before.id, details())).status).toBe(409); // rien à changer : pas de ligne d'historique vide
    // seconde correction : la ligne retirée disparaît, l'historique s'ajoute
    const second = ok(await put(before.id, details({ email: '', reason: 'E-mail à retirer' })));
    expect(second.customer.email).toBeUndefined(); expect(second.customerCorrections.map((c: Any) => c.reason)).toEqual(['Matricule erroné', 'E-mail à retirer']);
    expect((await A.j.put(`/invoices/${before.id}`, quoteBody({ ...A, customerId: customer.id }, [line(SVC, 1)], { validUntil: undefined }))).status).toBe(409); // le reste demeure immuable
  });

  it('met aussi à jour la fiche sur demande ; un matricule déjà pris laisse facture et fiche intactes', async () => {
    const { customer, draft } = await setup(); const inv = ok(await A.j.post(`/invoices/${draft.id}/validate`));
    ok(await A.j.post('/customers', { name: 'Détenteur', taxId: '7654321B' }), 201);
    const refused = await put(inv.id, details({ taxId: '7654321B', phone: '', email: '', updateCustomer: true }));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((await Invoice.findById(inv.id).lean())!.customerSnapshot.name).toBe(customer.name); expect((await Invoice.findById(inv.id).lean())!.customerCorrections).toBeUndefined();
    ok(await put(inv.id, details({ taxId: '9999999C', phone: '71 000 222', email: 'fiche@corrigee.tn', updateCustomer: true })));
    expect((await Customer.findById(customer.id).lean())!).toMatchObject({ name: 'Société Corrigée', taxId: '9999999C', email: 'fiche@corrigee.tn', phone: '+21671000222', address: { city: 'Sfax' } });
  });

  it('corps incomplet ou invalide refusé ; droits et société cloisonnés', async () => {
    const { draft } = await setup(); const inv = ok(await A.j.post(`/invoices/${draft.id}/validate`));
    const { email: _omitted, ...partial } = details();
    for (const bad of [partial, details({ reason: 'x' }), details({ phone: 'abc' }), details({ email: 'pas-un-email' }), details({ totals: {} })]) expect((await put(inv.id, bad)).status).toBe(422);
    expect((await put(inv.id, details(), B.j)).status).toBe(404);
    await makeUser(A.companyId, 'saisie@coord.test', ['invoices:view', 'invoices:update']);
    expect((await put(inv.id, details(), J((await login('saisie@coord.test')).token))).status).toBe(403);
    await makeUser(A.companyId, 'valideur@coord.test', ['invoices:view', 'invoices:update', 'invoices:validate']);
    const v = J((await login('valideur@coord.test')).token);
    expect((await put(inv.id, details({ updateCustomer: true }), v)).status).toBe(403);
    expect((await put(inv.id, details(), v)).status).toBe(200);
  });
});
