/**
 * Mission 1 (« Autres modifications », pages 1 à 6) : conditions de paiement, unicité téléphone / e-mail, unités et précision
 * des quantités, remises, statuts et versions des devis, documents, commentaires, conversions et migration.
 */
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, acceptQuote, api, line, logisticsCompany, plusDays, quoteBody, salesCompany, sendQuote, type Ctx, type LCtx } from './sales.helpers.js';
import { ContactKey, Customer } from '../src/models/customer.model.js';
import { Product, Unit } from '../src/models/product.model.js';
import { Invoice, Proforma, Quotation, QuotationVersion } from '../src/models/sales.model.js';
import { Setting } from '../src/models/setting.model.js';
import { PaymentTerm } from '../src/models/payment-term.model.js';
import { setMailTransport } from '../src/services/mail.service.js';
import { cancel, expireOverdue } from '../src/modules/quotations/quotation.service.js';
import { migrateMission1 } from '../src/modules/migrations/mission1.migration.js';

let A: LCtx, B: Ctx; let meter: string, kilo: string, piece: string, M: string, K: string;
const units = async (c: Ctx) => Object.fromEntries(((await c.j.get('/product-units')).body as { id: string; fixedKey: string }[]).map((u) => [u.fixedKey, u.id]));
beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Alpha', 'admin@m1a.test'); B = await salesCompany('Beta', 'admin@m1b.test');
  const u = await units(A); piece = u['piece']!; meter = u['meter']!; kilo = u['kilogram']!;
  const mk = async (reference: string, unitId: string) => (await A.j.post('/products', { reference, name: `Article ${reference}`, unitId, vatRateCode: 'T19', salePriceMinor: 10_000, purchasePriceMinor: 5_000 })).body.id as string;
  M = await mk('CABLE', meter); K = await mk('ACIER', kilo);
});
afterAll(async () => { setMailTransport(null); await teardownDb(); });

const mkCustomer = async (body: object, c: Ctx = A) => { const r = await c.j.post('/customers', body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const quote = async (lines: object[] = [line(A.products.a19)], extra: object = {}, c: Ctx = A) => { const r = await c.j.post('/quotations', quoteBody(c, lines, extra)); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const getQ = async (id: string) => (await A.j.get(`/quotations/${id}`)).body;
const kinds = async (id: string) => ((await A.j.get(`/quotations/${id}/activities?limit=100`)).body.items as { kind: string }[]).map((e) => e.kind).reverse();
const bin = async (url: string, c: Ctx = A) => { const r = await api().get(`/api/v1${url}`).set('Authorization', `Bearer ${c.token}`).buffer().parse(binaryParser); expect(r.status, url).toBe(200); return r.body as Buffer; };
const asInput = (l: Record<string, unknown>, patch: object = {}) => ({ id: l['id'], productId: l['productId'], designation: l['designation'], quantity: l['quantity'], unitPriceMinor: l['unitPriceMinor'], discountPct: l['discountPct'], vatCode: (l['vat'] as { code: string }).code, ...patch });
const edit = (q: Record<string, any>, extra: object = {}) => ({ customerId: q.customerId, validUntil: q.validUntil.slice(0, 10), lines: q.lines.map((l: Record<string, unknown>) => asInput(l)), ...extra });
const PDF = Buffer.from('%PDF-1.4 piece jointe de test');

describe('conditions de paiement administrables', () => {
  type Term = { id: string; label: string; delayDays: number | null; isActive: boolean; isDefault: boolean; used: boolean; customerCount: number };
  const terms = async (c: Ctx = A, q = '') => (await c.j.get(`/payment-terms${q}`)).body.items as Term[];
  const byLabel = async (label: string) => (await terms()).find((t) => t.label === label)!;
  it('conditions proposées, ajout, recherche, doublon refusé, descriptions distinctes des délais', async () => {
    const list = await terms();
    expect(list.map((t) => t.label)).toEqual(expect.arrayContaining(['Comptant', '30 jours', '60 jours', '90 jours', '30 % à la commande et 70 % avant livraison', 'Paiement avant expédition', 'Paiement après réception']));
    expect((await byLabel('60 jours')).delayDays).toBe(60); expect((await byLabel('Paiement avant expédition')).delayDays).toBeNull();
    const c = await A.j.post('/payment-terms', { label: '45 jours' }); expect(c.status).toBe(201); expect(c.body.delayDays).toBe(45);
    expect((await A.j.post('/payment-terms', { label: '45 JOURS' })).status).toBe(409);
    expect((await A.j.post('/payment-terms', { label: '' })).status).toBe(422);
    expect((await terms(A, '?q=exp')).map((t) => t.label)).toEqual(['Paiement avant expédition']);
  });
  it('utilisée : suppression refusée, désactivation et réactivation ; inutilisée : supprimée', async () => {
    const t = (await A.j.post('/payment-terms', { label: '15 jours fin de mois', delayDays: null })).body;
    await mkCustomer({ name: 'Utilise 15', paymentTerms: t.label, paymentTermsCustom: true });
    const del = await A.j.del(`/payment-terms/${t.id}`); expect(del.status).toBe(409); expect(del.body.error.code).toBe('PAYMENT_TERM_IN_USE');
    expect((await A.j.post(`/payment-terms/${t.id}/deactivate`)).body).toMatchObject({ isActive: false, used: true });
    expect((await terms(A, '?active=true')).some((x) => x.id === t.id)).toBe(false);
    expect((await A.j.post(`/payment-terms/${t.id}/default`, { isDefault: true })).status).toBe(409);
    expect((await A.j.post(`/payment-terms/${t.id}/activate`)).body.isActive).toBe(true);
    const free = (await A.j.post('/payment-terms', { label: 'Libre à supprimer' })).body;
    expect((await A.j.del(`/payment-terms/${free.id}`)).status).toBe(204);
    expect((await terms()).some((x) => x.id === free.id)).toBe(false);
  });
  it('modification : les fiches suivent, les documents déjà créés gardent leur texte', async () => {
    const t = (await A.j.post('/payment-terms', { label: 'À 10 jours', delayDays: 10 })).body;
    const c = await mkCustomer({ name: 'Suit la condition', paymentTerms: 'À 10 jours', paymentDelayDays: 10 });
    const q = (await A.j.post('/quotations', quoteBody({ ...A, customerId: c.id }, [line(A.products.a19)]))).body; expect(q.paymentTerms).toBe('À 10 jours');
    expect((await A.j.put(`/payment-terms/${t.id}`, { label: 'À 12 jours', delayDays: 12 })).status).toBe(200);
    expect((await A.j.get(`/customers/${c.id}`)).body).toMatchObject({ paymentTerms: 'À 12 jours', paymentDelayDays: 12 });
    expect((await getQ(q.id)).paymentTerms).toBe('À 10 jours');
  });
  it('condition par défaut appliquée à un nouveau client ; texte libre toujours possible ; une seule par défaut', async () => {
    const a = await byLabel('30 jours'); const b = await byLabel('60 jours');
    await A.j.post(`/payment-terms/${a.id}/default`, { isDefault: true }); await A.j.post(`/payment-terms/${b.id}/default`, { isDefault: true });
    expect((await terms()).filter((t) => t.isDefault).map((t) => t.label)).toEqual(['60 jours']);
    expect(await mkCustomer({ name: 'Par défaut' })).toMatchObject({ paymentTerms: '60 jours', paymentDelayDays: 60, paymentTermsCustom: false });
    expect(await mkCustomer({ name: 'Texte libre', paymentTerms: 'Selon contrat n° 8', paymentTermsCustom: true })).toMatchObject({ paymentTerms: 'Selon contrat n° 8', paymentTermsCustom: true });
    await A.j.post(`/payment-terms/${b.id}/default`, { isDefault: false });
  });
  it('permissions et isolation multi-société', async () => {
    const t = await byLabel('90 jours');
    expect((await B.j.put(`/payment-terms/${t.id}`, { label: 'Intrus' })).status).toBe(404); expect((await B.j.del(`/payment-terms/${t.id}`)).status).toBe(404);
    expect((await terms(B)).some((x) => x.id === t.id)).toBe(false);
    await makeUser(A.companyId, 'lecture@m1a.test', ['customers:view']); const v = J((await login('lecture@m1a.test')).token);
    expect((await v.get('/payment-terms')).status).toBe(200);
    for (const r of [v.post('/payment-terms', { label: 'x' }), v.put(`/payment-terms/${t.id}`, { label: 'x' }), v.del(`/payment-terms/${t.id}`), v.post(`/payment-terms/${t.id}/deactivate`)]) expect((await r).status).toBe(403);
  });
});

describe('unicité des téléphones et e-mails (clients et contacts)', () => {
  const dup = async (r: { status: number; body: { error?: { code: string; message: string } } }, message: RegExp) => { expect(r.status, JSON.stringify(r.body)).toBe(409); expect(r.body.error!.code).toBe('DUPLICATE_CONTACT_DETAILS'); expect(r.body.error!.message).toMatch(message); };
  it('client / client : formats de téléphone équivalents et e-mail sans casse', async () => {
    await mkCustomer({ name: 'Premier', phone: '23 108 065', email: 'Achats@Premier.TN' });
    for (const phone of ['23108065', '+21623108065', '+216 23 108 065']) await dup(await A.j.post('/customers', { name: 'Second', phone }), /numéro de téléphone est déjà associé à un autre client/);
    await dup(await A.j.post('/customers', { name: 'Second', secondaryPhone: '23108065' }), /téléphone/);
    await dup(await A.j.post('/customers', { name: 'Second', email: '  achats@premier.tn ' }), /adresse e-mail est déjà associée à un autre client/);
    expect((await A.j.post('/customers', { name: 'Format invalide', email: 'pas-un-email' })).status).toBe(422);
    await mkCustomer({ name: 'Vides', email: '', phone: '' }); await mkCustomer({ name: 'Vides 2', email: '', phone: '' }); // valeurs vides ignorées
  });
  it('contact / contact et client / contact', async () => {
    const x = await mkCustomer({ name: 'Avec contact', contacts: [{ name: 'Sami', phone: '55 111 222', email: 'sami@x.tn' }] });
    await dup(await A.j.post('/customers', { name: 'Autre', contacts: [{ name: 'Ali', email: 'SAMI@x.tn' }] }), /e-mail est déjà utilisée par un contact/);
    await dup(await A.j.post('/customers', { name: 'Autre', phone: '55111222' }), /téléphone est déjà utilisé par un contact/);
    await dup(await A.j.post('/customers', { name: 'Autre', contacts: [{ name: 'Ali', phone: '23108065' }] }), /téléphone est déjà associé à un autre client/);
    // ajout et modification de contacts : même règle, y compris entre deux contacts de la même fiche
    const y = await mkCustomer({ name: 'Cible' });
    await dup(await A.j.post(`/customers/${y.id}/contacts`, { name: 'Z', phone: '55111222' }), /contact/);
    await dup(await A.j.post(`/customers/${x.id}/contacts`, { name: 'Doublon interne', email: 'sami@x.tn' }), /e-mail est déjà utilisée par un contact/);
    const k = (await A.j.post(`/customers/${y.id}/contacts`, { name: 'Ok', phone: '55999888' })).body.contacts[0];
    await dup(await A.j.put(`/customers/${y.id}/contacts/${k._id}`, { email: 'achats@premier.tn' }), /autre client/);
    expect((await A.j.get(`/customers/${y.id}`)).body.contacts[0]).toMatchObject({ phone: '+21655999888', email: null }); // rien n'a été écrit
  });
  it('le contact principal peut reprendre les coordonnées de sa propre société ; modification sans faux conflit', async () => {
    const c = await mkCustomer({ name: 'Soi-même', phone: '55 123 123', email: 'info@soi.tn', contacts: [{ name: 'Gérant', phone: '55123123', email: 'info@soi.tn', isPrimary: true }] });
    expect(c.primaryContact.email).toBe('info@soi.tn');
    expect((await A.j.put(`/customers/${c.id}`, { phone: '+216 55 123 123', email: 'INFO@soi.tn', tradeName: 'S' })).status).toBe(200);
    expect((await A.j.put(`/customers/${c.id}/contacts/${c.contacts[0]._id}`, { name: 'Gérante', phone: '55123123' })).status).toBe(200);
    await dup(await A.j.post('/customers', { name: 'Autre', email: 'info@soi.tn' }), /autre client/);
  });
  it('pays du client : un numéro étranger n’est pas préfixé +216', async () => {
    await mkCustomer({ name: 'TN local', phone: '71 000 111' });
    const fr = await mkCustomer({ name: 'FR local', address: { country: 'France' }, phone: '06 11 00 01 11' });
    expect(fr.phone).toBe('+33611000111');
    await dup(await A.j.post('/customers', { name: 'FR bis', phone: '+33 6 11 00 01 11' }), /téléphone/);
  });
  it('valeur libérée après modification ou suppression ; isolation entre sociétés', async () => {
    const c = await mkCustomer({ name: 'Libère', phone: '55 222 333', email: 'libre@x.tn' });
    expect((await B.j.post('/customers', { name: 'Autre société', phone: '55222333', email: 'libre@x.tn' })).status).toBe(201);
    await A.j.put(`/customers/${c.id}`, { phone: '55 222 334' });
    await mkCustomer({ name: 'Reprend le téléphone', phone: '55222333' });
    expect((await A.j.del(`/customers/${c.id}`)).status).toBe(204);
    await mkCustomer({ name: 'Reprend l’e-mail', email: 'libre@x.tn', phone: '55222334' });
  });
  it('créations simultanées : une seule réussit, aucune donnée partielle, aucun trou de code', async () => {
    const before = await Customer.countDocuments({ companyId: A.companyId });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => A.j.post('/customers', { name: `Concurrent ${i}`, phone: '98 765 000', email: `c${i}@c.tn` })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await Customer.countDocuments({ companyId: A.companyId })).toBe(before + 1);
    const two = await Promise.all([A.j.post('/customers', { name: 'M1', email: 'meme@c.tn' }), A.j.post('/customers', { name: 'M2', contacts: [{ name: 'k', email: 'MEME@c.tn' }] })]);
    expect(two.map((r) => r.status).sort()).toEqual([201, 409]);
    const codes = (await Customer.find({ companyId: A.companyId, code: { $exists: true } }).select('code').lean()).map((x) => Number(x.code!.split('-')[1])).sort((a, b) => a - b);
    expect(new Set(codes).size).toBe(codes.length);
    expect(await ContactKey.countDocuments({ companyId: A.companyId, value: '+21698765000' })).toBe(1);
  });
  it('doublons antérieurs : conservés, signalés, fiche toujours modifiable, aucune nouvelle copie permise', async () => {
    const one = await mkCustomer({ name: 'Historique 1', phone: '44 000 111' });
    const { insertedId } = await mongoose.connection.db!.collection('customers').insertOne({ companyId: A.companyId, name: 'Historique 2', phone: '44000111', status: 'active', contacts: [], createdAt: new Date() });
    const report = (await A.j.get('/customers/duplicates')).body.items as { value: string; occurrences: { name: string }[] }[];
    expect(report.find((g) => g.value === '+21644000111')!.occurrences.map((o) => o.name).sort()).toEqual(['Historique 1', 'Historique 2']);
    expect((await A.j.put(`/customers/${insertedId}`, { tradeName: 'Toujours modifiable' })).status).toBe(200);
    await dup(await A.j.post('/customers', { name: 'Troisième', phone: '44000111' }), /téléphone/);
    expect((await Customer.findById(one.id))!.phone).toBe('+21644000111'); // aucune fusion ni modification automatique
    await makeUser(A.companyId, 'consult@m1a.test', ['customers:view']); expect((await J((await login('consult@m1a.test')).token).get('/customers/duplicates')).status).toBe(403);
  });
  it('recherche des suggestions : nom, code, matricule, téléphone, e-mail, avec pagination serveur', async () => {
    const c = await mkCustomer({ name: 'Suggestion Atelier', taxId: 'SUG-77', phone: '55 777 777', email: 'sug@atelier.tn' });
    for (const q of ['Atelier', c.code, 'SUG-77', '55 777 777', '+21655777777', 'sug@atelier']) expect((await A.j.get(`/customers?q=${encodeURIComponent(q)}&limit=15`)).body.items.map((x: { id: string }) => x.id), q).toContain(c.id);
    const p1 = (await A.j.get('/customers?limit=5&page=1')).body; const p2 = (await A.j.get('/customers?limit=5&page=2')).body;
    expect(p1.total).toBeGreaterThan(10); expect(p1.items.map((x: { id: string }) => x.id)).not.toContain(p2.items[0].id);
  });
});

describe('unités fixes et précision des quantités', () => {
  const q = (productId: string, quantity: number) => A.j.post('/quotations', quoteBody(A, [line(productId, quantity)]));
  it('pièce : entier ; mètre et kilogramme : une décimale (API)', async () => {
    for (const [product, ok, bad] of [[() => A.products.a19, [1, 10], [1.3]], [() => M, [1.5, 2], [1.55]], [() => K, [2.7], [2.75]]] as [() => string, number[], number[]][]) {
      for (const v of ok) expect((await q(product(), v)).status, `${v}`).toBe(201);
      for (const v of bad) { const r = await q(product(), v); expect(r.status, `${v}`).toBe(422); expect(r.body.error.code).toBe('QUANTITY_PRECISION'); expect(r.body.error.message).toMatch(/refusée/); }
    }
    expect((await q(A.products.a19, 1.3)).body.error.message).toBe('Ligne 1 (A19) : quantité 1,3 refusée, l’unité « Pièce » n’accepte que des nombres entiers.');
    expect((await A.j.post('/quotations', quoteBody(A, [{ designation: 'libre', unit: 'PC', quantity: 0.5, unitPriceMinor: 1, vatCode: 'T19' }]))).status).toBe(422);
  });
  it('mêmes contrôles : proforma, facture, aperçu, BL, achats, réception, stock, transfert, inventaire, importation', async () => {
    expect((await A.j.post('/proformas', quoteBody(A, [line(A.products.a19, 1.3)]))).status).toBe(422);
    expect((await A.j.post('/invoices', { customerId: A.customerId, lines: [line(M, 1.55)] })).status).toBe(422);
    expect((await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(K, 2.75)] })).status).toBe(422);
    const p = (await A.j.post('/proformas', quoteBody(A, [line(M, 5)]))).body;
    expect((await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1.55 }] })).status).toBe(422);
    expect((await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1.5 }] })).status).toBe(201);
    expect((await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId: A.products.a19, quantity: 1.3, unitPriceMinor: 1 }] })).status).toBe(422);
    const po = (await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines: [{ productId: M, quantity: 10, unitPriceMinor: 1_000 }] })).body; await A.j.post(`/purchase-orders/${po.id}/confirm`);
    expect((await A.j.post('/goods-receipts', { purchaseOrderId: po.id, warehouseId: A.w1, lines: [{ orderLineId: po.lines[0].id, quantity: 2.55 }] })).status).toBe(422);
    expect((await A.j.post('/goods-receipts', { purchaseOrderId: po.id, warehouseId: A.w1, lines: [{ orderLineId: po.lines[0].id, quantity: 2.5 }] })).status).toBe(201);
    expect((await A.j.post('/stock/movements', { direction: 'in', productId: A.products.a19, warehouseId: A.w1, quantity: 0.5, unitCostMinor: 1, reason: 'test précision' })).status).toBe(422);
    expect((await A.j.post('/stock-transfers', { fromWarehouseId: A.w1, toWarehouseId: A.w2, lines: [{ productId: K, quantity: 0.25 }] })).status).toBe(422);
    const inv = (await A.j.post('/inventories', { warehouseId: A.w1 })).body;
    expect((await A.j.put(`/inventories/${inv.id}`, { lines: [{ productId: A.products.a19, countedQty: 2.5 }] })).status).toBe(422);
    const imp = await A.j.post('/imports', { supplierId: A.foreignSupplierId, currency: 'EUR', exchangeRate: 3.4, lines: [{ productId: A.products.a19, quantity: 1.5, unitPriceMinor: 100 }] });
    expect(imp.status, JSON.stringify(imp.body)).toBe(422);
  });
  it('article suivi par série : quantité entière même au mètre ; unité historique non proposée', async () => {
    const s = (await A.j.post('/products', { reference: 'SERIE-M', name: 'Série au mètre', unitId: meter, vatRateCode: 'T19', salePriceMinor: 1000, hasSerial: true })).body;
    const r = await q(s.id, 1.5); expect(r.status).toBe(422); expect(r.body.error.message).toMatch(/série/);
    const old = await Unit.create({ companyId: A.companyId, code: 'LOT', name: 'Lot' });
    const bad = await A.j.post('/products', { reference: 'LOT-1', name: 'Au lot', unitId: old._id.toString(), vatRateCode: 'T19', salePriceMinor: 1000 }); expect(bad.status).toBe(400); expect(bad.body.error.message).toMatch(/Pièce, Mètre ou Kilogramme/);
    await Product.updateOne({ _id: M }, { unitId: old._id }); // article existant sur une unité historique : conservé et modifiable
    expect((await A.j.put(`/products/${M}`, { name: 'Câble renommé', unitId: old._id.toString() })).status).toBe(200);
    expect((await q(M, 1.234)).status).toBe(201); // unité non reconnue : précision antérieure inchangée
    await Product.updateOne({ _id: M }, { unitId: meter });
  });
  it('quantité antérieure non conforme : conservée à la conversion et à la duplication, à corriger pour modifier ou envoyer', async () => {
    const d = await quote([line(A.products.a19, 2)]);
    await Quotation.updateOne({ _id: d.id }, { 'lines.0.quantity': 1.3 });
    expect((await A.j.put(`/quotations/${d.id}`, edit(await getQ(d.id)))).status).toBe(422);
    expect((await sendQuote(A.j, d.id)).status).toBe(422);
    const copy = await A.j.post(`/quotations/${d.id}/duplicate`); expect(copy.status).toBe(201); expect(copy.body.lines[0].quantity).toBe(1.3);
    await Quotation.updateOne({ _id: d.id }, { status: 'accepted', acceptedVersion: 1 });
    const pf = await A.j.post(`/quotations/${d.id}/convert-proforma`, {}); expect(pf.status, JSON.stringify(pf.body)).toBe(201);
    expect((await Proforma.findById(pf.body.proformaId))!.lines[0]!.quantity).toBe(1.3); // jamais arrondie
  });
  it('120 EUR au taux estimatif 3,5 = 420,000 DT (coût d’achat HT en DT) ; formules de marge inchangées', async () => {
    const p = (await A.j.post('/products', { reference: 'EUR-120', name: 'Perceuse', unitId: piece, vatRateCode: 'T19', purchaseCurrency: 'EUR', purchasePriceForeignMinor: 12_000, salePriceMinor: 600_000, estimatedCostMinor: 400_000 })).body;
    expect(p.estimatedPurchaseMinor).toBe(420_000); expect(p.estimateRate).toBe(3.5);
    expect(p.marginRatePct).toBe(50); expect(p.markPct).toBe(33.33); // sur coût : 200/400 ; sur prix de vente : 200/600
    const zero = (await A.j.post('/products', { reference: 'ZERO', name: 'Sans prix', unitId: piece, vatRateCode: 'T19', salePriceMinor: 0 })).body; expect(zero.markPct).toBeNull();
  });
});

describe('remises', () => {
  const three = () => [line(A.products.a19, 1, { unitPriceMinor: 200_000 }), line(A.products.b13, 1, { unitPriceMinor: 300_000 }), line(A.products.c7, 1, { unitPriceMinor: 500_000 })];
  it('cas A : remise globale 5 % recopiée sur chaque ligne, appliquée une seule fois (950, pas 902,500)', async () => {
    const q = await quote(three(), { syncDiscountPct: 5 });
    expect(q.lines.map((l: { discountPct: number }) => l.discountPct)).toEqual([5, 5, 5]);
    expect(q.totals).toMatchObject({ grossMinor: 1_000_000, lineDiscountsMinor: 50_000, globalDiscountMinor: 0, totalHtMinor: 950_000 });
    expect(q).toMatchObject({ syncDiscountPct: 5, globalDiscountPct: 0 });
    expect(q.totals.totalHtMinor).not.toBe(902_500);
    // les taux de ligne envoyés sont remplacés ; une ligne ajoutée prend le même taux
    const u = await A.j.put(`/quotations/${q.id}`, edit(q, { syncDiscountPct: 5, lines: [...q.lines.map((l: Record<string, unknown>) => asInput(l, { discountPct: 40 })), line(A.products.a19, 1, { unitPriceMinor: 100_000 })] }));
    expect(u.body.lines.map((l: { discountPct: number }) => l.discountPct)).toEqual([5, 5, 5, 5]); expect(u.body.totals.totalHtMinor).toBe(1_045_000);
    // retour à zéro : les derniers taux restent et redeviennent modifiables
    const back = await A.j.put(`/quotations/${q.id}`, edit(u.body, { syncDiscountPct: 0 })); expect(back.body.lines.map((l: { discountPct: number }) => l.discountPct)).toEqual([5, 5, 5, 5]); expect(back.body.totals.totalHtMinor).toBe(1_045_000);
  });
  it('cas B : remise globale nulle, taux libres par ligne (964)', async () => {
    const q = await quote([line(A.products.a19, 1, { unitPriceMinor: 200_000, discountPct: 3 }), line(A.products.b13, 1, { unitPriceMinor: 300_000, discountPct: 10 }), line(A.products.c7, 1, { unitPriceMinor: 500_000, discountPct: 0 })]);
    expect(q.totals).toMatchObject({ lineDiscountsMinor: 36_000, totalHtMinor: 964_000 });
  });
  it('cas C : remises de ligne puis remise supplémentaire en montant (930), répartie par taux de TVA', async () => {
    const lines = [line(A.products.a19, 1, { unitPriceMinor: 500_000, discountPct: 10 }), line(A.products.b13, 1, { unitPriceMinor: 500_000 })];
    const q = await quote(lines, { globalDiscountMinor: 20_000 });
    expect(q.totals).toMatchObject({ grossMinor: 1_000_000, lineDiscountsMinor: 50_000, globalDiscountMinor: 20_000, totalHtMinor: 930_000 });
    expect(q.totals.vatGroups.reduce((s: number, g: { baseMinor: number }) => s + g.baseMinor, 0)).toBe(930_000);
    expect(q.totals.vatGroups.map((g: { baseMinor: number }) => g.baseMinor)).toEqual([440_526, 489_474]);
    expect(q.totals.totalVatMinor).toBe(q.totals.vatGroups.reduce((s: number, g: { vatMinor: number }) => s + g.vatMinor, 0));
    // les deux remises globales se cumulent : % sur les lignes, puis montant
    const both = await quote(three(), { syncDiscountPct: 5, globalDiscountMinor: 20_000 }); expect(both.totals.totalHtMinor).toBe(930_000);
    expect((await A.j.post('/quotations', quoteBody(A, three(), { globalDiscountMinor: 1_000_001 }))).status).toBe(422); // jamais de total négatif
  });
  it('un chiffre après la virgule au plus (ligne, globale, client) ; ancien champ refusé', async () => {
    for (const d of [5, 5.5, 12.7, 100]) { expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1, { discountPct: d })]))).status, `${d}`).toBe(201); expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19)], { syncDiscountPct: d }))).status).toBe(201); }
    for (const d of [5.55, 0.01]) {
      expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1, { discountPct: d })]))).status, `${d}`).toBe(422);
      expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19)], { syncDiscountPct: d }))).status).toBe(422);
      expect((await A.j.post('/customers', { name: `Remise ${d}`, discountPct: d })).status).toBe(422);
      expect((await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19, 1, { discountPct: d })] })).status).toBe(422);
    }
    expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19)], { globalDiscountPct: 5 }))).status).toBe(422);
  });
  it('factures et proformas : même règle ; règles de prix de l’article vérifiées sur le taux global', async () => {
    const f = (await A.j.post('/invoices', { customerId: A.customerId, syncDiscountPct: 10, lines: three() })).body; expect(f.totals.totalHtMinor).toBe(900_000);
    const v = await A.j.post(`/invoices/${f.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); expect(v.body.totals.totalHtMinor).toBe(900_000); expect(v.body.syncDiscountPct).toBe(10);
    const credit = (await A.j.post(`/invoices/${f.id}/credit-note`, { reason: 'Retour total' })).body; expect(credit.totals.totalHtMinor).toBe(900_000);
    const p = (await A.j.post('/proformas', quoteBody(A, three(), { syncDiscountPct: 2.5 }))).body; expect(p.totals.totalHtMinor).toBe(975_000);
    await Product.updateOne({ _id: A.products.c7 }, { maxDiscountPct: 3 });
    const r = await A.j.post('/quotations', quoteBody(A, [line(A.products.c7)], { syncDiscountPct: 5 })); expect(r.status).toBe(409); expect(r.body.error.code).toBe('PRICE_RULE_VIOLATION');
    await Product.updateOne({ _id: A.products.c7 }, { $unset: { maxDiscountPct: 1 } });
  });
  it('document antérieur : montants conservés à la conversion ; ancienne remise gardée jusqu’au retrait explicite', async () => {
    const q = await quote([line(A.products.a19, 2, { discountPct: 3 })]);
    // simulation d'un devis enregistré avec l'ancienne règle (remise de 5 % en plus sur le total) et des remises à deux décimales
    const legacy = { 'lines.0.discountPct': 0.01, 'lines.0.netHtMinor': 199_980, globalDiscountPct: 5, 'totals.globalDiscountMinor': 9_999, 'totals.totalHtMinor': 189_981 };
    await Quotation.updateOne({ _id: q.id }, legacy);
    const kept = await A.j.put(`/quotations/${q.id}`, edit(await getQ(q.id), { lines: [asInput((await getQ(q.id)).lines[0], { discountPct: 3 })] }));
    expect(kept.status, JSON.stringify(kept.body)).toBe(200); expect(kept.body.globalDiscountPct).toBe(5); expect(kept.body.totals.totalHtMinor).toBe(184_300);
    const mix = await A.j.put(`/quotations/${q.id}`, edit(kept.body, { syncDiscountPct: 10 })); expect(mix.status).toBe(422); expect(mix.body.error.code).toBe('LEGACY_DISCOUNT');
    const preview = await A.j.post('/sales/calculate', { docType: 'quotation', customerId: A.customerId, lines: [line(A.products.a19, 2, { discountPct: 3 })], legacyGlobalDiscountPct: 5 }); expect(preview.body.totals.totalHtMinor).toBe(184_300);
    // le PDF nomme l'ancienne remise comme telle (ce n'est pas une remise supplémentaire saisie en montant)
    const printed = pdfText(await bin(`/quotations/${q.id}/pdf`)); expect(printed).toContain('Remise globale (5 %)'); expect(printed).not.toContain('Remise suppl\xe9mentaire');
    // conversion d'un devis accepté sous l'ancienne règle : mêmes montants
    await Quotation.updateOne({ _id: q.id }, legacy); await Quotation.updateOne({ _id: q.id }, { status: 'accepted', acceptedVersion: 1 });
    const pf = (await A.j.post(`/quotations/${q.id}/convert-proforma`, {})).body; const p = (await Proforma.findById(pf.proformaId).lean())!;
    expect(p.totals.totalHtMinor).toBe(189_981); expect(p.globalDiscountPct).toBe(5); expect(p.lines[0]!.discountPct).toBe(0.01);
    const inv = (await A.j.post(`/proformas/${pf.proformaId}/convert-invoice`)).body; expect((await Invoice.findById(inv.invoiceId))!.totals.totalHtMinor).toBe(189_981);
    const dupQ = await quote([line(A.products.a19, 2)]); await Quotation.updateOne({ _id: dupQ.id }, { globalDiscountPct: 5 });
    const removed = await A.j.put(`/quotations/${dupQ.id}`, edit(await getQ(dupQ.id), { removeLegacyDiscount: true, syncDiscountPct: 10 })); expect(removed.body).toMatchObject({ globalDiscountPct: 0, syncDiscountPct: 10 }); expect(removed.body.totals.totalHtMinor).toBe(180_000);
  });
  it('PDF : colonne Rem.% présente avec une remise globale, absente sans aucune remise de ligne', async () => {
    const withSync = pdfText(await bin(`/quotations/${(await quote(three(), { syncDiscountPct: 5 })).id}/pdf`)); expect(withSync).toContain('Rem.%'); expect(withSync).toContain('5 %');
    const amountOnly = pdfText(await bin(`/quotations/${(await quote(three(), { globalDiscountMinor: 20_000 })).id}/pdf`)); expect(amountOnly).not.toContain('Rem.%'); expect(amountOnly).toContain('Remise suppl\xe9mentaire');
  });
});

describe('versions d’un devis', () => {
  it('un brouillon se modifie sans créer de version', async () => {
    const q = await quote();
    let cur = q;
    for (const n of [2, 3, 4]) { const r = await A.j.put(`/quotations/${q.id}`, edit(cur, { revision: cur.revision, lines: [asInput(cur.lines[0], { quantity: n })] })); expect(r.status).toBe(200); cur = r.body; }
    expect(cur).toMatchObject({ version: 1, status: 'draft', revision: 3 });
    expect(await QuotationVersion.countDocuments({ quotationId: q.id })).toBe(0);
    const list = (await A.j.get(`/quotations/${q.id}/versions`)).body.items; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ version: 1, status: 'draft', current: true, frozen: false });
    // modification concurrente : la révision périmée est refusée
    const stale = await A.j.put(`/quotations/${q.id}`, edit(cur, { revision: 1 })); expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('CONCURRENT_UPDATE');
  });
  it('envoi de la V1, nouvelle version, envoi de la V2, acceptation de la V2 ; V1 inchangée', async () => {
    const q = await quote([line(A.products.a19, 1)], { deliveryTime: '4 à 6 semaines après confirmation', paymentTerms: '30 jours' });
    expect((await sendQuote(A.j, q.id)).body).toMatchObject({ status: 'sent', version: 1, editable: false });
    const v1pdf = await bin(`/quotations/${q.id}/versions/1/pdf`);
    expect(pdfText(v1pdf)).toContain('Version 1'); expect(pdfText(v1pdf)).toContain('D\xe9lai de livraison : 4 \xe0 6 semaines apr\xe8s confirmation');
    expect((await A.j.put(`/quotations/${q.id}`, edit(await getQ(q.id)))).status).toBe(409);
    expect((await A.j.del(`/quotations/${q.id}`)).status).toBe(409);
    // référentiels modifiés après l'envoi : la version figée ne change pas
    await Product.updateOne({ _id: A.products.a19 }, { name: 'Nom modifié après envoi', salePriceMinor: 999_000 });
    const nv = await A.j.post(`/quotations/${q.id}/versions`, {}); expect(nv.status, JSON.stringify(nv.body)).toBe(201);
    expect(nv.body).toMatchObject({ number: q.number, version: 2, status: 'draft', editable: true, sentAt: null, deliveryTime: '4 à 6 semaines après confirmation' });
    expect(nv.body.lines[0]).toMatchObject({ id: q.lines[0].id, unitPriceMinor: 100_000, designation: 'Article A19' });
    expect(nv.body.actions).toMatchObject({ remove: false, abandonVersion: true, accept: false });
    expect((await A.j.del(`/quotations/${q.id}`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${q.id}/accept`)).status).toBe(409); // la V1 remplacée ne s'accepte plus
    await A.j.put(`/quotations/${q.id}`, edit(nv.body, { lines: [asInput(nv.body.lines[0], { quantity: 3 })], deliveryTime: 'Disponible immédiatement' }));
    expect((await sendQuote(A.j, q.id)).body).toMatchObject({ status: 'sent', version: 2 });
    const list = (await A.j.get(`/quotations/${q.id}/versions`)).body.items;
    expect(list.map((v: { version: number; status: string; current: boolean }) => [v.version, v.status, v.current])).toEqual([[2, 'sent', true], [1, 'superseded', false]]);
    expect(list[1].totalHtMinor).toBe(100_000); expect(list[0].totalHtMinor).toBe(300_000); expect(list[1].author).toBe('Admin Alpha');
    const v1 = (await A.j.get(`/quotations/${q.id}/versions/1`)).body.content;
    expect(v1).toMatchObject({ deliveryTime: '4 à 6 semaines après confirmation', paymentTerms: '30 jours' }); expect(v1.lines[0]).toMatchObject({ quantity: 1, designation: 'Article A19', unitPriceMinor: 100_000 }); expect(v1.currency).toMatchObject({ code: 'TND', decimals: 3 });
    expect(Buffer.compare(await bin(`/quotations/${q.id}/versions/1/pdf`), v1pdf)).toBe(0); // PDF identique à celui transmis
    expect(Buffer.compare(await bin(`/quotations/${q.id}/pdf`), await bin(`/quotations/${q.id}/versions/2/pdf`))).toBe(0);
    const acc = await A.j.post(`/quotations/${q.id}/accept`); expect(acc.body).toMatchObject({ status: 'accepted', version: 2, acceptedVersion: 2 });
    expect((await A.j.put(`/quotations/${q.id}`, edit(acc.body))).status).toBe(409);
    const refused = await A.j.post(`/quotations/${q.id}/versions`, {}); expect(refused.status).toBe(409); expect(refused.body.error.message).toMatch(/dupliquez/);
    const copy = (await A.j.post(`/quotations/${q.id}/duplicate`)).body; expect(copy.number).not.toBe(q.number); expect(copy).toMatchObject({ version: 1, status: 'draft', duplicatedFromId: q.id });
    const pf = (await A.j.post(`/quotations/${q.id}/convert-proforma`, {})).body; expect(pf.quotationVersion).toBe(2);
    expect((await A.j.get(`/proformas/${pf.proformaId}`)).body).toMatchObject({ quotationId: q.id, quotationVersion: 2, deliveryTime: 'Disponible immédiatement' });
    expect(pdfText(await bin(`/proformas/${pf.proformaId}/pdf`))).toContain('Disponible imm\xe9diatement');
    expect(await kinds(q.id)).toEqual(['created', 'marked_sent', 'version_created', 'quantity_changed', 'delivery_time_changed', 'marked_sent', 'accepted', 'duplicated', 'converted_proforma']);
    await Product.updateOne({ _id: A.products.a19 }, { name: 'Article A19', salePriceMinor: 100_000 });
  });
  it('contenu figé : ni modification ni suppression d’une version', async () => {
    const q = await quote(); await sendQuote(A.j, q.id);
    await expect(QuotationVersion.updateOne({ quotationId: q.id }, { snapshot: {} })).rejects.toThrow(/figée/);
    await expect(QuotationVersion.updateOne({ quotationId: q.id }, { $set: { 'snapshot.notes': 'x' } })).rejects.toThrow(/figée/);
    await expect(QuotationVersion.deleteMany({ quotationId: q.id })).rejects.toThrow(/ne se supprime pas/);
  });
  it('devis expiré : nouvelle version avec nouvelle validité ; la version expirée est conservée', async () => {
    const q = await quote(); await sendQuote(A.j, q.id);
    await Quotation.updateOne({ _id: q.id }, { validUntil: new Date(plusDays(-1)), issueDate: new Date(plusDays(-20)) }); await expireOverdue();
    expect((await getQ(q.id)).actions).toMatchObject({ newVersion: true, edit: false, send: false, accept: false });
    expect((await A.j.post(`/quotations/${q.id}/versions`, { validUntil: plusDays(-2) })).status).toBe(400);
    const nv = await A.j.post(`/quotations/${q.id}/versions`, { validUntil: plusDays(15) });
    expect(nv.body).toMatchObject({ version: 2, status: 'draft' }); expect(nv.body.validUntil.slice(0, 10)).toBe(plusDays(15));
    expect((await A.j.get(`/quotations/${q.id}/versions`)).body.items.map((v: { status: string }) => v.status)).toEqual(['draft', 'expired']);
    const q2 = await quote(); await sendQuote(A.j, q2.id); await Quotation.updateOne({ _id: q2.id }, { validUntil: new Date(plusDays(-1)), issueDate: new Date(plusDays(-20)) }); await expireOverdue();
    expect((await A.j.post(`/quotations/${q2.id}/versions`, {})).body.validUntil.slice(0, 10) >= plusDays(0)).toBe(true); // sans date : même durée à partir d'aujourd'hui
  });
  it('abandon du brouillon : la version transmise redevient courante et acceptable ; numéros jamais réutilisés', async () => {
    const q = await quote([line(A.products.a19, 1)], { notes: 'Notes V1' }); await sendQuote(A.j, q.id);
    const nv = (await A.j.post(`/quotations/${q.id}/versions`, {})).body;
    await A.j.put(`/quotations/${q.id}`, edit(nv, { lines: [asInput(nv.lines[0], { quantity: 9 })], notes: 'Notes V2' }));
    const back = await A.j.post(`/quotations/${q.id}/versions/abandon`); expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ version: 1, status: 'sent', notes: 'Notes V1' }); expect(back.body.totals.totalHtMinor).toBe(100_000);
    expect((await A.j.get(`/quotations/${q.id}/versions`)).body.items.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, 'abandoned'], [1, 'sent']]);
    expect((await A.j.post(`/quotations/${q.id}/versions/abandon`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${q.id}/versions`, {})).body.version).toBe(3);
  });
  it('nouvelles versions simultanées : une seule créée, numérotation unique', async () => {
    const q = await quote(); await sendQuote(A.j, q.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => A.j.post(`/quotations/${q.id}/versions`, {})));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect((await getQ(q.id)).version).toBe(2);
    const sends = await Promise.all(Array.from({ length: 4 }, () => sendQuote(A.j, q.id)));
    expect(sends.some((r) => r.status === 200)).toBe(true);
    expect(await QuotationVersion.countDocuments({ quotationId: q.id, version: 2 })).toBe(1);
  });
  it('e-mail : échec sans changement ; succès fige la version et transmet son PDF ; renvoi identique', async () => {
    const q = await quote(); const sent: { attachments: { content: Buffer }[] }[] = [];
    const smtp = (fail: boolean) => { const t = nodemailer.createTransport({ jsonTransport: true }); t.sendMail = (async (m: never) => { if (fail) throw new Error('ECONNREFUSED'); sent.push(m); return {}; }) as never; setMailTransport(t); };
    smtp(true); expect((await A.j.post(`/quotations/${q.id}/send`, {})).status).toBe(502);
    expect(await getQ(q.id)).toMatchObject({ status: 'draft', editable: true }); expect(await QuotationVersion.countDocuments({ quotationId: q.id })).toBe(0);
    expect((await A.j.put(`/quotations/${q.id}`, edit(await getQ(q.id)))).status).toBe(200); // verrou libéré après l'échec
    smtp(false); expect((await A.j.post(`/quotations/${q.id}/send`, {})).status).toBe(200);
    const first = sent.at(-1)!.attachments[0]!.content; expect(Buffer.compare(first, await bin(`/quotations/${q.id}/versions/1/pdf`))).toBe(0);
    expect((await A.j.post(`/quotations/${q.id}/send`, { to: 'second@client.tn' })).status).toBe(200);
    expect(Buffer.compare(sent.at(-1)!.attachments[0]!.content, first)).toBe(0); expect((await getQ(q.id)).version).toBe(1);
    setMailTransport(null);
  });
  it('envoi en cours : le contenu est verrouillé', async () => {
    const q = await quote(); await Quotation.updateOne({ _id: q.id }, { sendingUntil: new Date(Date.now() + 60_000) });
    expect((await A.j.put(`/quotations/${q.id}`, edit(await getQ(q.id)))).status).toBe(409); expect((await sendQuote(A.j, q.id)).status).toBe(409);
  });
  it('statut Annulé : transition depuis Accepté seulement, sans route exposée ; duplication proposée', async () => {
    const q = await quote(); await acceptQuote(A.j, q.id);
    expect((await A.j.post(`/quotations/${q.id}/cancel`)).status).toBe(404);
    const c = await cancel(A.companyId, q.id, { name: 'Test' }, 'Commande annulée'); expect(c.status).toBe('cancelled'); expect(c.actions).toMatchObject({ duplicate: true, edit: false, accept: false, convertProforma: false, newVersion: false, send: false, remove: false });
    expect((await A.j.get('/quotations?status=cancelled')).body.total).toBe(1); expect((await A.j.get('/quotations/stats')).body.cancelled).toBe(1);
    expect((await A.j.get(`/quotations/${q.id}/versions`)).body.items[0].status).toBe('cancelled');
    expect((await A.j.post(`/quotations/${q.id}/duplicate`)).status).toBe(201);
    const d = await quote(); await expect(cancel(A.companyId, d.id, {})).rejects.toThrow(/Transition impossible/);
  });
  it('matrice des actions par statut (API)', async () => {
    const draft = await quote(); const sentQ = await quote(); await sendQuote(A.j, sentQ.id); const acc = await quote(); await acceptQuote(A.j, acc.id);
    const ref = await quote(); await sendQuote(A.j, ref.id); await A.j.post(`/quotations/${ref.id}/refuse`);
    const exp = await quote(); await sendQuote(A.j, exp.id); await Quotation.updateOne({ _id: exp.id }, { validUntil: new Date(plusDays(-1)), issueDate: new Date(plusDays(-9)) }); await expireOverdue();
    const expected: [string, Record<string, boolean>][] = [
      [draft.id, { edit: true, remove: true, newVersion: false, send: true, accept: false, refuse: false, convertProforma: false }],
      [sentQ.id, { edit: false, remove: false, newVersion: true, send: true, accept: true, refuse: true, convertProforma: false }],
      [acc.id, { edit: false, remove: false, newVersion: false, send: false, accept: false, refuse: false, convertProforma: true }],
      [ref.id, { edit: false, remove: false, newVersion: false, send: false, accept: false, refuse: false, convertProforma: false }],
      [exp.id, { edit: false, remove: false, newVersion: true, send: false, accept: false, refuse: false, convertProforma: false }],
    ];
    for (const [id, a] of expected) expect((await getQ(id)).actions).toMatchObject({ ...a, duplicate: true });
    for (const [id, a] of expected) {
      if (!a['accept']) expect((await A.j.post(`/quotations/${id}/accept`)).status).toBe(409);
      if (!a['edit']) expect((await A.j.put(`/quotations/${id}`, edit(await getQ(id), { validUntil: plusDays(5) }))).status).toBe(409);
      if (!a['convertProforma']) expect((await A.j.post(`/quotations/${id}/convert-proforma`, {})).status).toBe(409);
      for (const url of ['convert-invoice', 'convert-delivery-note']) expect((await A.j.post(`/quotations/${id}/${url}`)).status).toBe(410);
      expect((await A.j.get(`/quotations/${id}/pdf`)).status).toBe(200);
    }
  });
});

describe('documents et commentaires internes d’un devis', () => {
  const upload = (id: string, file: Buffer, name: string, fields: Record<string, string> = { type: 'specifications' }, c: Ctx = A) => {
    let r = api().post(`/api/v1/quotations/${id}/documents`).set('Authorization', `Bearer ${c.token}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, name);
  };
  it('ajout, métadonnées, téléchargement, suppression ; pièces conservées avec leur version transmise', async () => {
    const q = await quote();
    const d = await upload(q.id, PDF, 'cahier.pdf', { type: 'specifications', description: 'CdC', version: '1' }); expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body).toMatchObject({ typeLabel: 'Cahier des charges', name: 'cahier.pdf', version: 1, uploadedBy: 'Admin Alpha', lockedReason: null, previewable: true });
    const free = (await upload(q.id, PDF, 'catalogue.pdf', { type: 'catalog' })).body;
    expect((await A.j.put(`/quotations/${q.id}/documents/${free.id}`, { description: 'Édition 2026' })).body.description).toBe('Édition 2026');
    expect(Buffer.compare(await bin(`/quotations/${q.id}/documents/${d.body.id}/file`), PDF)).toBe(0);
    await sendQuote(A.j, q.id);
    const locked = await A.j.del(`/quotations/${q.id}/documents/${d.body.id}`); expect(locked.status).toBe(409); expect(locked.body.error.message).toMatch(/version 1/);
    expect((await A.j.del(`/quotations/${q.id}/documents/${free.id}`)).status).toBe(204);
    await A.j.post(`/quotations/${q.id}/accept`);
    const signed = (await upload(q.id, PDF, 'signe.pdf', { type: 'signed_quote' })).body; expect(signed.lockedReason).toMatch(/accepté/);
    expect((await A.j.del(`/quotations/${q.id}/documents/${signed.id}`)).status).toBe(409);
    expect((await kinds(q.id)).filter((k) => k.startsWith('document_'))).toEqual(['document_added', 'document_added', 'document_updated', 'document_removed', 'document_added']);
  });
  it('sécurité : fichiers dangereux, contenu incohérent, taille, version inconnue, permissions, isolation', async () => {
    const q = await quote();
    for (const [name, body] of [['x.exe', PDF], ['x.pdf.exe', PDF], ['x.svg', Buffer.from('<svg/>')], ['faux.pdf', Buffer.from('MZ...')], ['vide.pdf', Buffer.alloc(0)]] as [string, Buffer][]) expect((await upload(q.id, body, name)).status, name).toBe(400);
    expect((await upload(q.id, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'gros.pdf')).status).toBe(413);
    expect((await upload(q.id, PDF, 'v.pdf', { type: 'catalog', version: '7' })).status).toBe(400);
    const d = (await upload(q.id, PDF, 'ok.pdf')).body;
    expect((await B.j.get(`/quotations/${q.id}/documents`)).status).toBe(404); expect((await B.j.get(`/quotations/${q.id}/documents/${d.id}/file`)).status).toBe(404);
    expect((await upload(q.id, PDF, 'intrus.pdf', { type: 'catalog' }, B)).status).toBe(404);
    expect((await api().get(`/api/v1/quotations/${q.id}/documents/${d.id}/file`)).status).toBe(401);
    await makeUser(A.companyId, 'voir@m1a.test', ['quotations:view']); const t = (await login('voir@m1a.test')).token; const v = J(t);
    expect((await v.get(`/quotations/${q.id}/documents`)).status).toBe(200); expect((await v.del(`/quotations/${q.id}/documents/${d.id}`)).status).toBe(403);
    expect((await api().post(`/api/v1/quotations/${q.id}/documents`).set('Authorization', `Bearer ${t}`).field('type', 'catalog').attach('file', PDF, 'a.pdf')).status).toBe(403);
  });
  it('commentaires : auteur et dates ; modification par l’auteur ou un responsable ; archivage ; jamais dans le PDF ni l’e-mail', async () => {
    const q = await quote([line(A.products.a19)], { notes: 'Note commerciale visible' });
    await makeUser(A.companyId, 'redac@m1a.test', ['quotations:view', 'quotations:update']); const u = J((await login('redac@m1a.test')).token);
    const c = await u.post(`/quotations/${q.id}/comments`, { body: 'MARGE-SECRETE 12 %' }); expect(c.status).toBe(201); expect(c.body).toMatchObject({ canEdit: true, editedAt: null });
    const mine = (await A.j.post(`/quotations/${q.id}/comments`, { body: 'Commentaire direction' })).body;
    expect((await u.put(`/quotations/${q.id}/comments/${mine.id}`, { body: 'x' })).status).toBe(403); expect((await u.del(`/quotations/${q.id}/comments/${mine.id}`)).status).toBe(403);
    const ed = await u.put(`/quotations/${q.id}/comments/${c.body.id}`, { body: 'MARGE-SECRETE 10 %' }); expect(ed.body).toMatchObject({ body: 'MARGE-SECRETE 10 %' }); expect(ed.body.editedAt).toBeTruthy();
    expect((await A.j.del(`/quotations/${q.id}/comments/${c.body.id}`)).body).toMatchObject({ body: null, archivedBy: 'Admin Alpha' }); // responsable
    expect((await A.j.put(`/quotations/${q.id}/comments/${c.body.id}`, { body: 'y' })).status).toBe(409);
    expect((await A.j.post(`/quotations/${q.id}/comments`, { body: '  ' })).status).toBe(422);
    const sent: { text?: string; attachments: { content: Buffer }[] }[] = []; const t = nodemailer.createTransport({ jsonTransport: true }); t.sendMail = (async (m: never) => { sent.push(m); return {}; }) as never; setMailTransport(t);
    expect((await A.j.post(`/quotations/${q.id}/send`, { to: 'a@b.tn' })).status).toBe(200); setMailTransport(null);
    const everything = pdfText(sent[0]!.attachments[0]!.content) + JSON.stringify({ ...sent[0], attachments: [] }) + JSON.stringify((await A.j.get(`/quotations/${q.id}/versions/1`)).body) + JSON.stringify(await getQ(q.id));
    expect(everything).not.toContain('MARGE-SECRETE'); expect(everything).not.toContain('Commentaire direction'); expect(everything).toContain('Note commerciale visible');
    expect((await B.j.get(`/quotations/${q.id}/comments`)).status).toBe(404);
    expect((await kinds(q.id)).filter((k) => k.startsWith('comment_'))).toEqual(['comment_added', 'comment_added', 'comment_edited', 'comment_archived']);
  });
});

describe('migration de la mission 1', () => {
  it('simulation sans écriture ; exécution non destructive ; relance sans changement', async () => {
    const C = await salesCompany('Gamma', 'admin@m1c.test'); const db = mongoose.connection.db!;
    // État « avant » : unités libres, conditions en texte, doublon, devis en attente / envoyé / accepté, quantité non conforme
    await db.collection('units').deleteMany({ companyId: C.companyId });
    const pce = (await db.collection('units').insertOne({ companyId: C.companyId, code: 'Pc', name: 'Pièce' })).insertedId;
    await db.collection('units').insertOne({ companyId: C.companyId, code: 'ML', name: 'Mètre linéaire' }); await db.collection('units').insertOne({ companyId: C.companyId, code: 'H', name: 'Heure' });
    await db.collection('products').updateMany({ companyId: C.companyId }, { $set: { unitId: pce } });
    await PaymentTerm.collection.deleteMany({ companyId: C.companyId }); await Setting.updateOne({ companyId: C.companyId }, { $unset: { paymentTermsInitialisedAt: 1, contactKeysInitialisedAt: 1 } });
    await db.collection('contactkeys').deleteMany({ companyId: C.companyId });
    await db.collection('customers').updateOne({ companyId: C.companyId }, { $set: { paymentTerms: 'À réception de facture', phone: '+21671222333' } });
    await db.collection('customers').insertOne({ companyId: C.companyId, name: 'Doublon', phone: '71 222 333', contacts: [], status: 'active', createdAt: new Date() });
    const base = (await C.j.post('/quotations', quoteBody(C, [line(C.products.a19, 2)]))).body;
    const raw = db.collection('quotations'); const proto = (await raw.findOne({ _id: new mongoose.Types.ObjectId(base.id) }))!;
    await raw.deleteMany({ companyId: C.companyId });
    const mk = async (number: string, status: string, extra: object = {}) => (await raw.insertOne({ ...proto, _id: new mongoose.Types.ObjectId(), number, status, version: undefined, revision: undefined, ...extra }, { ignoreUndefined: true })).insertedId;
    const pending = await mk('DEV-OLD-P', 'pending', { lines: [{ ...proto['lines'][0], quantity: 1.3 }] });
    const mailed = await mk('DEV-OLD-M', 'pending', { sentAt: new Date('2025-03-01') });
    const sentQ = await mk('DEV-OLD-S', 'sent', { sentAt: new Date('2025-03-02') });
    const proformaId = new mongoose.Types.ObjectId();
    const accepted = await mk('DEV-OLD-A', 'accepted', { proformaId, globalDiscountPct: 5 });
    await db.collection('proformas').insertOne({ _id: proformaId, companyId: C.companyId, customerId: proto['customerId'], number: 'PRO-OLD-1', status: 'pending', quotationId: accepted, issueDate: new Date(), validUntil: new Date(plusDays(5)), lines: [], totals: {}, customerSnapshot: proto['customerSnapshot'] });
    const state = async () => JSON.stringify(await Promise.all(['quotations', 'quotationversions', 'proformas', 'units', 'paymentterms', 'contactkeys', 'customers', 'quotationactivities'].map(async (c) => db.collection(c).find({ companyId: C.companyId }).sort({ _id: 1 }).toArray())));
    const before = await state();
    const dry = (await migrateMission1({ dryRun: true })).companies.find((c) => c.companyId === C.companyId.toString())!;
    expect(await state()).toBe(before);
    expect(dry.units.fixed.map((u) => `${u.key}:${u.action}:${u.code}`)).toEqual(['piece:adopted:Pc', 'meter:adopted:ML', 'kilogram:created:KG']);
    expect(dry.quotations).toMatchObject({ renamedToDraft: 1, referenceSnapshots: 3, proformasLinkedToVersion: 1 });
    expect(dry.incompatibleQuantities.some((x) => x.document === 'DEV-OLD-P' && x.quantity === 1.3 && x.allowedDecimals === 0)).toBe(true);
    expect(dry.contactDuplicates.map((d) => d.value)).toContain('+21671222333');
    const real = (await migrateMission1()).companies.find((c) => c.companyId === C.companyId.toString())!;
    expect(real.quotations).toMatchObject({ renamedToDraft: 1, referenceSnapshots: 3, proformasLinkedToVersion: 1 });
    const rows = await raw.find({ companyId: C.companyId }).sort({ number: 1 }).toArray(); const by = Object.fromEntries(rows.map((r) => [r['number'], r]));
    expect([by['DEV-OLD-P']!['status'], by['DEV-OLD-M']!['status'], by['DEV-OLD-S']!['status'], by['DEV-OLD-A']!['status']]).toEqual(['draft', 'sent', 'sent', 'accepted']);
    for (const r of rows) { expect(r['version']).toBe(1); expect(r['totals']).toEqual(proto['totals']); }
    expect(by['DEV-OLD-P']!['lines'][0].quantity).toBe(1.3); expect(by['DEV-OLD-A']).toMatchObject({ globalDiscountPct: 5, acceptedVersion: 1 });
    expect((await db.collection('proformas').findOne({ _id: proformaId }))!['quotationVersion']).toBe(1);
    const snapshots = await QuotationVersion.find({ companyId: C.companyId }).lean();
    expect(snapshots.map((v) => v.quotationId.toString()).sort()).toEqual([mailed, sentQ, accepted].map(String).sort()); expect(snapshots.every((v) => v.origin === 'migration' && v.version === 1)).toBe(true);
    expect(await QuotationVersion.countDocuments({ quotationId: pending })).toBe(0); // aucun historique inventé pour un brouillon
    expect((await Unit.find({ companyId: C.companyId }).lean()).map((u) => u.code).sort()).toEqual(['H', 'KG', 'ML', 'Pc']); expect((await Unit.findById(pce))!.decimals).toBe(0);
    expect((await PaymentTerm.find({ companyId: C.companyId }).lean()).map((t) => t.label)).toContain('À réception de facture');
    expect(await Customer.countDocuments({ companyId: C.companyId })).toBe(2);
    const after = await state(); const ORDER = ['quotations', 'quotationversions', 'proformas', 'units', 'paymentterms', 'contactkeys', 'customers', 'quotationactivities']; const again = (await migrateMission1()).companies.find((c) => c.companyId === C.companyId.toString())!;
    expect(again.quotations).toEqual({ renamedToDraft: 0, versionInitialised: 0, referenceSnapshots: 0, proformasLinkedToVersion: 0 }); expect(again.paymentTerms.toCreate).toEqual([]); const final = JSON.parse(await state()); const ref = JSON.parse(after); ORDER.forEach((n, i) => expect(final[i], n).toEqual(ref[i]));
    // la version de référence reste consultable et le devis migré fonctionne
    expect((await C.j.get(`/quotations/${sentQ}/versions/1/pdf`)).status).toBe(200);
    expect((await C.j.post(`/quotations/${sentQ}/accept`)).body.status).toBe('accepted');
  });
});
