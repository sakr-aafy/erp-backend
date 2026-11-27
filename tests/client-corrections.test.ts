/**
 * Corrections de la fiche client : coordonnées et téléphones, adresses de livraison multiples (clients et fournisseurs),
 * champs RC / secteur retirés, défauts fiscaux, conditions de paiement libres, migration.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, authed, binaryParser, pdfText, setupDb, teardownDb } from './helpers.js';
import { line, logisticsCompany, plusDays, quoteBody, stockIn, today, type LCtx, acceptQuote } from './sales.helpers.js';
import { Customer } from '../src/models/customer.model.js';
import { Supplier } from '../src/models/supplier.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { migrateParties } from '../src/modules/parties/party.migration.js';

let A: LCtx, B: LCtx;
beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test'); });
afterAll(async () => { await teardownDb(); });

const col = (name: string) => mongoose.connection.db!.collection(name);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const mkCustomer = async (body: object, c: LCtx = A) => { const r = await c.j.post('/customers', body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const pdfOf = async (url: string, c: LCtx = A) => {
  const r = await request(app).get(`/api/v1${url}`).set(authed(c.token)).buffer().parse(binaryParser);
  expect(r.status).toBe(200); return pdfText(r.body as Buffer);
};
const addr = (label: string, city: string, extra: object = {}) => ({ label, street: `Zone ${label}`, city, country: 'Tunisie', ...extra });
const addAddress = async (base: 'customers' | 'suppliers', id: string, body: object, c: LCtx = A) => {
  const r = await c.j.post(`/${base}/${id}/delivery-addresses`, body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body;
};
type Adr = { id: string; label: string; isDefault: boolean; archived: boolean; city: string };
const byLabel = (list: Adr[], label: string) => list.find((a) => a.label === label)!;
const defaults = (list: Adr[]) => list.filter((a) => a.isDefault).map((a) => a.label);

describe('téléphones : format international, liens, numéros non reconnus', () => {
  it('numéro tunisien local → +216, enregistré en E.164, affiché avec espaces, lien tel:', async () => {
    const c = await mkCustomer({ name: 'Tel TN', phone: '72679670', secondaryPhone: '23108065', address: { country: 'Tunisie' }, contacts: [{ name: 'Mohamed Dridi', role: 'Responsable d’achat', phone: '98 123 456', email: 'm.dridi@exemple.tn', isPrimary: true }] });
    expect(c.phone).toBe('+21672679670'); expect(c.secondaryPhone).toBe('+21623108065');
    expect(c.secondaryPhoneInfo).toEqual({ display: '+216 23 108 065', href: 'tel:+21623108065', valid: true });
    expect(c.contacts[0]).toMatchObject({ phone: '+21698123456', phoneInfo: { display: '+216 98 123 456', valid: true } });
    expect(c.primaryContact).toMatchObject({ name: 'Mohamed Dridi', role: 'Responsable d’achat', email: 'm.dridi@exemple.tn', phoneInfo: { href: 'tel:+21698123456' } });
    expect((await col('customers').findOne({ _id: oid(c.id) }))!.secondaryPhone).toBe('+21623108065');
  });
  it('indicatif jamais ajouté deux fois ; sans pays → Tunisie', async () => {
    // Une seule fiche (un numéro n'appartient qu'à un client) : toutes les écritures donnent la même valeur enregistrée
    const c = await mkCustomer({ name: 'Préfixes', phone: '23 555 065' });
    for (const phone of ['+216 23 555 065', '00216 23555065', '216 23 555 065', '+21623555065', '23.555.065']) {
      const r = await A.j.put(`/customers/${c.id}`, { phone }); expect(r.status, phone).toBe(200); expect(r.body.phone, phone).toBe('+21623555065');
    }
  });
  it('international : pays du client respecté ; un numéro étranger ne devient jamais tunisien', async () => {
    const fr = await mkCustomer({ name: 'Client FR', address: { country: 'France' }, phone: '06 12 34 56 78', secondaryPhone: '23108065' });
    expect(fr.phone).toBe('+33612345678'); expect(fr.phoneInfo.display).toBe('+33 6 12 34 56 78');
    expect(fr.secondaryPhone).toBe('23108065'); expect(fr.secondaryPhoneInfo).toMatchObject({ valid: false, display: '23108065' });
    expect((await mkCustomer({ name: 'FR chez TN', phone: '+33 6 11 22 33 44' })).phone).toBe('+33611223344');
    expect((await mkCustomer({ name: 'DE', address: { country: 'Allemagne' }, phone: '030 901820' })).phone).toBe('+4930901820');
    const unknown = await mkCustomer({ name: 'Pays inconnu', address: { country: 'Pays imaginaire' }, phone: '24681357' });
    expect(unknown.phone).toBe('24681357'); expect(unknown.phoneInfo.valid).toBe(false);
  });
  it('un numéro non reconnu est conservé tel quel et signalé', async () => {
    const c = await mkCustomer({ name: 'Non reconnu', phone: '72 679 670 / 23 108 065' });
    expect(c.phone).toBe('72 679 670 / 23 108 065'); expect(c.phoneInfo.valid).toBe(false);
  });
  it('modification et contacts normalisés avec le pays enregistré ; recherche avec ou sans espaces', async () => {
    const c = await mkCustomer({ name: 'Recherche Tel', address: { country: 'France' } });
    expect((await A.j.put(`/customers/${c.id}`, { phone: '01 42 68 53 00' })).body.phone).toBe('+33142685300');
    const k = await A.j.post(`/customers/${c.id}/contacts`, { name: 'Jean', phone: '06 98 76 54 32' });
    expect(k.body.contacts[0].phone).toBe('+33698765432');
    const kid = k.body.contacts[0]._id as string;
    expect((await A.j.put(`/customers/${c.id}/contacts/${kid}`, { phone: '07 56 22 33 44' })).body.contacts[0].phone).toBe('+33756223344');
    for (const q of ['1 42 68 53', '33142685300', '7 56 22 33']) {
      const found = (await A.j.get(`/customers?q=${encodeURIComponent(q)}`)).body.items.map((x: { id: string }) => x.id);
      expect(found, q).toContain(c.id);
    }
  });
  it('export et fiche PDF affichent le format lisible', async () => {
    const c = await mkCustomer({ name: 'PDF Tel', phone: '23999065', contacts: [{ name: 'Ali', phone: '98999456', isPrimary: true }] });
    const csv = await A.j.get('/customers/export?format=csv&q=PDF%20Tel');
    expect(csv.text).toContain('+216 23 999 065');
    const text = await pdfOf(`/customers/${c.id}/pdf`);
    expect(text).toContain('+216 23 999 065'); expect(text).toContain('+216 98 999 456');
  });
});

describe('contact principal et localisation Google Maps', () => {
  it('suit le contact désigné principal ; aucun principal possible ; aucune duplication dans le client', async () => {
    const c = await mkCustomer({ name: 'Contacts', contacts: [{ name: 'Premier', phone: '98000001' }, { name: 'Second', phone: '98000002', email: 'second@exemple.tn' }] });
    expect(c.contacts.some((k: { isPrimary: boolean }) => k.isPrimary)).toBe(false);
    const second = c.contacts[1]._id as string;
    const p = await A.j.post(`/customers/${c.id}/contacts/${second}/primary`);
    expect(p.body.primaryContact).toMatchObject({ name: 'Second', email: 'second@exemple.tn', phone: '+21698000002' });
    const back = await A.j.post(`/customers/${c.id}/contacts/${c.contacts[0]._id}/primary`);
    expect(back.body.primaryContact.name).toBe('Premier');
    const stored = (await col('customers').findOne({ _id: oid(c.id) }))!;
    expect(Object.keys(stored)).not.toContain('primaryContact'); // calculé, jamais copié
  });
  it('lien Maps : http(s) uniquement, enregistré tel quel, effaçable', async () => {
    const c = await mkCustomer({ name: 'Maps' });
    for (const mapsUrl of ['javascript:alert(1)', 'maps.google.com', 'data:text/html,x']) expect((await A.j.put(`/customers/${c.id}`, { mapsUrl })).status, mapsUrl).toBe(422);
    expect((await A.j.put(`/customers/${c.id}`, { mapsUrl: 'https://maps.app.goo.gl/abc123' })).body.mapsUrl).toBe('https://maps.app.goo.gl/abc123');
    expect((await A.j.put(`/customers/${c.id}`, { mapsUrl: null })).body.mapsUrl).toBeNull();
  });
});

describe('RC et secteur d’activité retirés ; défauts fiscaux', () => {
  it('l’API refuse les anciens champs, ne les renvoie plus, mais conserve les valeurs historiques en base', async () => {
    expect((await A.j.post('/customers', { name: 'Ancien champ', registryNumber: 'B1' })).status).toBe(422);
    expect((await A.j.post('/customers', { name: 'Ancien champ', sector: 'Industrie' })).status).toBe(422);
    const c = await mkCustomer({ name: 'Historique' });
    await col('customers').updateOne({ _id: oid(c.id) }, { $set: { registryNumber: 'B0999', sector: 'Aluminium' } });
    const u = await A.j.put(`/customers/${c.id}`, { tradeName: 'Nouveau nom' });
    expect(u.body).not.toHaveProperty('registryNumber'); expect(u.body).not.toHaveProperty('sector');
    expect((await col('customers').findOne({ _id: oid(c.id) }))!).toMatchObject({ registryNumber: 'B0999', sector: 'Aluminium', tradeName: 'Nouveau nom' });
    const text = await pdfOf(`/customers/${c.id}/pdf`);
    expect(text).not.toContain('B0999'); expect(text).not.toContain('Aluminium'); expect(text).not.toContain('Registre de commerce');
    expect((await A.j.get('/customers/export?format=csv')).text).not.toContain('B0999');
  });
  it('nouveau client : retenue à la source activée, timbre non exonéré ; modifiables', async () => {
    const d = await mkCustomer({ name: 'Défauts' });
    expect(d).toMatchObject({ subjectToWithholding: true, stampExempt: false });
    expect((await col('customers').findOne({ _id: oid(d.id) }))!).toMatchObject({ subjectToWithholding: true, stampExempt: false });
    const manual = await mkCustomer({ name: 'Manuel', subjectToWithholding: false, stampExempt: true });
    expect(manual).toMatchObject({ subjectToWithholding: false, stampExempt: true });
    // une modification sans ces champs ne les réapplique pas
    expect((await A.j.put(`/customers/${manual.id}`, { tradeName: 'x' })).body).toMatchObject({ subjectToWithholding: false, stampExempt: true });
    expect((await A.j.put(`/customers/${manual.id}`, { subjectToWithholding: true })).body.subjectToWithholding).toBe(true);
  });
  it('un client existant sans réglage enregistré reste non assujetti après modification', async () => {
    const { insertedId } = await col('customers').insertOne({ companyId: A.companyId, name: 'Avant défaut', contacts: [], balanceMinor: 0, isArchived: false });
    expect((await A.j.get(`/customers/${insertedId}`)).body.subjectToWithholding).toBe(false);
    expect((await A.j.put(`/customers/${insertedId}`, { tradeName: 'x' })).body.subjectToWithholding).toBe(false);
    expect((await col('customers').findOne({ _id: insertedId }))!.subjectToWithholding).toBeUndefined();
  });
  it('le défaut ne déclenche aucune retenue sans règle validée applicable', async () => {
    const c = await mkCustomer({ name: 'Sans règle' });
    const r = await A.j.post('/sales/calculate', { docType: 'invoice', customerId: c.id, withholdingOperationType: 'INCONNUE', lines: [line(A.products.a19)] });
    expect(r.status).toBe(200); expect(r.body.totals).toMatchObject({ withholdingMinor: 0, stampMinor: 0 }); expect(r.body.withholding).toBeNull();
    const none = await A.j.post('/sales/calculate', { docType: 'invoice', customerId: c.id, lines: [line(A.products.a19)] });
    expect(none.body.totals.totalPayableMinor).toBe(none.body.totals.totalTtcMinor);
  });
});

describe('adresses de livraison multiples — clients', () => {
  let c = ''; let depot = ''; let usine = '';
  it('ajout, champs requis, une seule adresse par défaut', async () => {
    c = (await mkCustomer({ name: 'Palma', address: { street: 'Siège', city: 'Tunis', country: 'Tunisie' } })).id;
    for (const bad of [{ street: 'x', city: 'Tunis', country: 'Tunisie' }, { label: 'Dépôt', city: 'Tunis', country: 'Tunisie' }, { label: 'Dépôt', street: 'Rue 1', country: 'Tunisie' },
      addr('Dépôt', 'Tunis', { mapsUrl: 'javascript:alert(1)' }), addr('Dépôt', 'Tunis', { contactPhone: 'abc' }), addr('Dépôt', 'Tunis', { inconnu: 1 })]) {
      expect((await A.j.post(`/customers/${c}/delivery-addresses`, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    const a = await addAddress('customers', c, addr('Dépôt Tunis', 'Tunis', { postalCode: '1000', contactName: 'Sami', contactPhone: '98123456', mapsUrl: 'https://maps.google.com/?q=1', instructions: 'Quai 2' }));
    depot = byLabel(a.deliveryAddresses, 'Dépôt Tunis').id;
    expect(a.deliveryAddresses[0]).toMatchObject({ isDefault: true, contactPhone: '+21698123456', contactPhoneInfo: { display: '+216 98 123 456' } }); // la première devient par défaut
    const b = await addAddress('customers', c, addr('Usine principale', 'Sfax'));
    usine = byLabel(b.deliveryAddresses, 'Usine principale').id;
    expect(defaults(b.deliveryAddresses)).toEqual(['Dépôt Tunis']);
    const d = await addAddress('customers', c, addr('Magasin Sousse', 'Sousse', { isDefault: true }));
    expect(defaults(d.deliveryAddresses)).toEqual(['Magasin Sousse']); expect(d.deliveryAddresses).toHaveLength(3);
  });
  it('modification, effacement d’un champ, changement et retrait de l’adresse par défaut', async () => {
    const u = await A.j.put(`/customers/${c}/delivery-addresses/${depot}`, { city: 'Ariana', instructions: '' });
    expect(byLabel(u.body.deliveryAddresses, 'Dépôt Tunis')).toMatchObject({ city: 'Ariana', instructions: null, contactName: 'Sami' });
    const s = await A.j.post(`/customers/${c}/delivery-addresses/${usine}/default`);
    expect(defaults(s.body.deliveryAddresses)).toEqual(['Usine principale']);
    const off = await A.j.put(`/customers/${c}/delivery-addresses/${usine}`, { isDefault: false });
    expect(defaults(off.body.deliveryAddresses)).toHaveLength(1); expect(defaults(off.body.deliveryAddresses)).not.toContain('Usine principale');
    await A.j.post(`/customers/${c}/delivery-addresses/${usine}/default`);
  });
  it('ajouts simultanés : toujours une seule adresse par défaut', async () => {
    const x = (await mkCustomer({ name: 'Concurrence adresses' })).id as string;
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => A.j.post(`/customers/${x}/delivery-addresses`, addr(`Adresse ${i}`, 'Tunis', { isDefault: true }))));
    expect(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status))).toBe(true);
    const list = (await A.j.get(`/customers/${x}`)).body.deliveryAddresses as Adr[];
    expect(list).toHaveLength(5); expect(defaults(list)).toHaveLength(1);
  });
  it('isolation entre sociétés et appartenance au client', async () => {
    for (const r of [await B.j.post(`/customers/${c}/delivery-addresses`, addr('Intrus', 'Tunis')), await B.j.put(`/customers/${c}/delivery-addresses/${depot}`, { city: 'X1' }),
      await B.j.post(`/customers/${c}/delivery-addresses/${depot}/default`), await B.j.del(`/customers/${c}/delivery-addresses/${depot}`)]) expect(r.status).toBe(404);
    const other = (await mkCustomer({ name: 'Autre client' })).id as string;
    expect((await A.j.put(`/customers/${other}/delivery-addresses/${depot}`, { city: 'X1' })).status).toBe(404);
    // document : l'adresse doit appartenir au client concerné ET à la société
    expect((await A.j.post('/quotations', quoteBody({ ...A, customerId: other }, [line(A.products.a19)], { deliveryAddressId: depot }))).body.error?.code ?? '').toBe('DELIVERY_ADDRESS_INVALID');
    expect((await B.j.post('/quotations', quoteBody(B, [line(B.products.a19)], { deliveryAddressId: depot }))).status).toBe(400);
    expect((await B.j.post('/quotations', quoteBody({ ...B, customerId: c }, [line(B.products.a19)], { deliveryAddressId: depot }))).status).toBe(400);
  });
  it('sélection dans les documents, conversions, copie conservée après modification et validation, PDF', async () => {
    const ctx = { ...A, customerId: c };
    const def = await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)]));
    expect(def.body.deliveryAddress.label).toBe('Usine principale'); // adresse par défaut présélectionnée
    expect((await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)], { deliveryAddressId: null }))).body.deliveryAddress).toBeNull();
    const q = (await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19, 2)], { deliveryAddressId: depot }))).body;
    expect(q.deliveryAddress).toMatchObject({ addressId: depot, label: 'Dépôt Tunis', city: 'Ariana', contactName: 'Sami' });
    // modification du brouillon sans préciser l'adresse : la copie est conservée
    const kept = await A.j.put(`/quotations/${q.id}`, quoteBody(ctx, [line(A.products.a19, 2)]));
    expect(kept.body.deliveryAddress.label).toBe('Dépôt Tunis');
    const qText = await pdfOf(`/quotations/${q.id}/pdf`);
    expect(qText).toContain('LIVRAISON'); expect(qText).toContain('Ariana'); expect(qText).toContain('+216 98 123 456');
    await acceptQuote(A.j, q.id); const pro = (await A.j.post(`/quotations/${q.id}/convert-proforma`)).body;
    expect((await A.j.get(`/proformas/${pro.proformaId}`)).body.deliveryAddress.label).toBe('Dépôt Tunis');
    const inv = (await A.j.post(`/proformas/${pro.proformaId}/convert-invoice`)).body;
    const draft = (await A.j.get(`/invoices/${inv.invoiceId}`)).body; expect(draft.deliveryAddress.label).toBe('Dépôt Tunis');
    // le référentiel change avant la validation : le document garde sa copie
    await A.j.put(`/customers/${c}/delivery-addresses/${depot}`, { city: 'Bizerte', label: 'Dépôt déplacé' });
    const v = await A.j.post(`/invoices/${inv.invoiceId}/validate`);
    expect(v.status, JSON.stringify(v.body)).toBe(200); expect(v.body.deliveryAddress).toMatchObject({ label: 'Dépôt Tunis', city: 'Ariana' });
    expect((await A.j.put(`/invoices/${inv.invoiceId}`, { customerId: c, lines: [line(A.products.a19)] })).status).toBe(409); // validée : immuable
    expect((await pdfOf(`/invoices/${inv.invoiceId}/pdf`))).toContain('Ariana');
    // avoir : même adresse que la facture
    const cn = await A.j.post(`/invoices/${inv.invoiceId}/credit-note`, { reason: 'Retour marchandise' });
    expect(cn.body.deliveryAddress.city).toBe('Ariana');
    // modification d'un brouillon en resélectionnant la même adresse : version à jour du référentiel
    const upd = await A.j.put(`/quotations/${def.body.id}`, quoteBody(ctx, [line(A.products.a19)], { deliveryAddressId: depot }));
    expect(upd.body.deliveryAddress).toMatchObject({ label: 'Dépôt déplacé', city: 'Bizerte' });
  });
  it('bon de livraison : adresse du document source ou choisie, puis facturation du BL avec la même adresse', async () => {
    const ctx = { ...A, customerId: c };
    await stockIn(A, A.products.a19, 20, 50_000);
    const q = (await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19, 3)], { deliveryAddressId: depot, paymentTerms: 'Paiement selon contrat' }))).body;
    await acceptQuote(A.j, q.id);
    const conv = (await A.j.post(`/quotations/${q.id}/convert-proforma`)).body; const p = (await A.j.get(`/proformas/${conv.proformaId}`)).body;
    const src = { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1 }] };
    const bl = (await A.j.post('/delivery-notes', src)).body; expect(bl.deliveryAddress.addressId).toBe(depot);
    const other = (await A.j.post('/delivery-notes', { ...src, deliveryAddressId: usine })).body; expect(other.deliveryAddress.label).toBe('Usine principale');
    expect((await A.j.post(`/delivery-notes/${bl.id}/validate`, { warehouseId: A.w1 })).status).toBe(200);
    expect(await pdfOf(`/delivery-notes/${bl.id}/pdf`)).toContain('LIVRAISON');
    const inv = await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [bl.id] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.deliveryAddress.addressId).toBe(depot); expect(inv.body).toMatchObject({ paymentTerms: 'Paiement selon contrat', paymentTermsCustom: true });
    const direct = await A.j.post('/delivery-notes', { customerId: c, lines: [line(A.products.a19)] });
    expect(direct.body.deliveryAddress.label).toBe('Usine principale');
  });
  it('adresse utilisée : archivée et non supprimée ; non sélectionnable ; réactivable ; adresse libre supprimée', async () => {
    const d = await A.j.del(`/customers/${c}/delivery-addresses/${depot}`);
    expect(d.status).toBe(200); expect(d.body.addressArchived).toBe(true); expect(byLabel(d.body.deliveryAddresses, 'Dépôt déplacé')).toMatchObject({ archived: true, isDefault: false });
    expect((await A.j.post('/quotations', quoteBody({ ...A, customerId: c }, [line(A.products.a19)], { deliveryAddressId: depot }))).status).toBe(400);
    expect((await A.j.put(`/customers/${c}/delivery-addresses/${depot}`, { city: 'Nabeul' })).status).toBe(409);
    expect((await A.j.post(`/customers/${c}/delivery-addresses/${depot}/default`)).status).toBe(409);
    expect((await A.j.del(`/customers/${c}/delivery-addresses/${depot}`)).status).toBe(409);
    const r = await A.j.post(`/customers/${c}/delivery-addresses/${depot}/restore`); expect(byLabel(r.body.deliveryAddresses, 'Dépôt déplacé').archived).toBe(false);
    expect(defaults(r.body.deliveryAddresses)).toEqual(['Usine principale']);
    const free = (await addAddress('customers', c, addr('Jamais utilisée', 'Gabès', { isDefault: true }))).deliveryAddresses as Adr[];
    const del = await A.j.del(`/customers/${c}/delivery-addresses/${byLabel(free, 'Jamais utilisée').id}`);
    expect(del.body.addressArchived).toBe(false); expect(del.body.deliveryAddresses.map((a: Adr) => a.label)).not.toContain('Jamais utilisée');
    expect(defaults(del.body.deliveryAddresses)).toHaveLength(1); // le défaut est reporté
    expect(await AuditLog.countDocuments({ resource: 'customer', resourceId: c, action: { $in: ['address-add', 'address-update', 'address-default', 'address-archive', 'address-restore', 'address-remove'] } })).toBeGreaterThan(6);
    const text = await pdfOf(`/customers/${c}/pdf`); expect(text).toContain('Adresses de livraison'); expect(text).toContain('Usine principale');
  });
  it('client archivé : adresses en lecture seule ; permission requise', async () => {
    const x = (await mkCustomer({ name: 'Archivé' })).id as string;
    await A.j.post(`/customers/${x}/archive`);
    expect((await A.j.post(`/customers/${x}/delivery-addresses`, addr('Dépôt', 'Tunis'))).status).toBe(409);
    expect((await request(app).post(`/api/v1/customers/${x}/delivery-addresses`).send(addr('Dépôt', 'Tunis'))).status).toBe(401);
  });
  it('client non migré : l’ancienne adresse de livraison reste visible, sélectionnable et copiée', async () => {
    const { insertedId } = await col('customers').insertOne({ companyId: A.companyId, name: 'Non migré', code: 'CL-90001', status: 'active', contacts: [], balanceMinor: 0, isArchived: false,
      address: { city: 'Tunis' }, shippingSameAsBilling: false, shippingAddress: { street: 'Ancien dépôt', city: 'Kairouan', country: 'Tunisie' } });
    const dto = (await A.j.get(`/customers/${insertedId}`)).body;
    expect(dto.deliveryAddresses).toEqual([expect.objectContaining({ id: String(insertedId), city: 'Kairouan', isDefault: true })]);
    const q = await A.j.post('/quotations', quoteBody({ ...A, customerId: String(insertedId) }, [line(A.products.a19)]));
    expect(q.body.deliveryAddress.city).toBe('Kairouan');
    // la première adresse ajoutée conserve l'ancienne dans la liste
    const added = await addAddress('customers', String(insertedId), addr('Nouveau', 'Sousse'));
    expect(added.deliveryAddresses.map((a: Adr) => a.city)).toEqual(['Kairouan', 'Sousse']);
  });
});

describe('adresses de livraison — fournisseurs, commandes et réceptions', () => {
  let nord = ''; let sud = '';
  it('plusieurs adresses, modification, défaut unique, isolation', async () => {
    await addAddress('suppliers', A.supplierId, addr('Usine Nord', 'Bizerte', { contactPhone: '72 000 111' }));
    const s = await addAddress('suppliers', A.supplierId, addr('Entrepôt Sud', 'Gafsa'));
    nord = byLabel(s.deliveryAddresses, 'Usine Nord').id; sud = byLabel(s.deliveryAddresses, 'Entrepôt Sud').id;
    expect(defaults(s.deliveryAddresses)).toEqual(['Usine Nord']);
    const d = await A.j.post(`/suppliers/${A.supplierId}/delivery-addresses/${sud}/default`); expect(defaults(d.body.deliveryAddresses)).toEqual(['Entrepôt Sud']);
    const u = await A.j.put(`/suppliers/${A.supplierId}/delivery-addresses/${nord}`, { city: 'Menzel' }); expect(byLabel(u.body.deliveryAddresses, 'Usine Nord').city).toBe('Menzel');
    expect((await B.j.put(`/suppliers/${A.supplierId}/delivery-addresses/${nord}`, { city: 'X1' })).status).toBe(404);
    expect((await B.j.post(`/suppliers/${A.supplierId}/delivery-addresses`, addr('Intrus', 'Tunis'))).status).toBe(404);
    expect(await pdfOf(`/suppliers/${A.supplierId}/pdf`)).toContain('Entrep');
  });
  it('commande : adresse fournisseur et adresse de réception distinctes ; réception copiée ; historique figé', async () => {
    await A.j.put(`/warehouses/${A.w1}`, { code: 'WH1', name: 'Magasin principal', address: 'Zone industrielle Ben Arous', isDefault: true });
    const lines = [{ productId: A.products.a19, quantity: 4, unitPriceMinor: 10_000 }];
    const def = (await A.j.post('/purchase-orders', { supplierId: A.supplierId, lines })).body;
    expect(def.supplierAddress.label).toBe('Entrepôt Sud'); expect(def.receivingAddress).toMatchObject({ warehouseId: A.w1, name: 'Magasin principal', address: 'Zone industrielle Ben Arous' });
    const o = (await A.j.post('/purchase-orders', { supplierId: A.supplierId, supplierAddressId: nord, receivingWarehouseId: A.w2, lines })).body;
    expect(o.supplierAddress).toMatchObject({ addressId: nord, city: 'Menzel' }); expect(o.receivingAddress.warehouseId).toBe(A.w2);
    // adresse d'un autre fournisseur, magasin d'une autre société : refusés
    const foreign = (await addAddress('customers', A.customerId, addr('Client', 'Tunis'))).deliveryAddresses[0].id as string;
    expect((await A.j.post('/purchase-orders', { supplierId: A.supplierId, supplierAddressId: foreign, lines })).status).toBe(400);
    expect((await A.j.post('/purchase-orders', { supplierId: A.supplierId, receivingWarehouseId: B.w1, lines })).status).toBe(400);
    expect((await B.j.post('/purchase-orders', { supplierId: B.supplierId, supplierAddressId: nord, lines: [{ productId: B.products.a19, quantity: 1 }] })).status).toBe(400);
    const c = (await A.j.post(`/purchase-orders/${o.id}/confirm`)).body;
    const rec = (await A.j.post('/goods-receipts', { purchaseOrderId: o.id, warehouseId: A.w1, lines: [{ orderLineId: c.lines[0].id, quantity: 2 }] })).body;
    expect(rec.supplierAddress.addressId).toBe(nord); expect(rec.receivingAddress.address).toBe('Zone industrielle Ben Arous');
    expect((await A.j.post(`/goods-receipts/${rec.id}/validate`)).status).toBe(200);
    await A.j.put(`/suppliers/${A.supplierId}/delivery-addresses/${nord}`, { city: 'Autre ville' });
    await A.j.put(`/warehouses/${A.w1}`, { code: 'WH1', name: 'Magasin principal', address: 'Nouvelle adresse', isDefault: true });
    const after = (await A.j.get(`/goods-receipts/${rec.id}`)).body;
    expect(after.supplierAddress.city).toBe('Menzel'); expect(after.receivingAddress.address).toBe('Zone industrielle Ben Arous');
    expect((await A.j.get(`/purchase-orders/${o.id}`)).body.supplierAddress.city).toBe('Menzel');
    const d = await A.j.del(`/suppliers/${A.supplierId}/delivery-addresses/${nord}`); expect(d.body.addressArchived).toBe(true);
  });
});

describe('conditions de paiement libres', () => {
  const TERMS = '40 % à la commande, 30 % avant la livraison et 30 % après installation, selon le procès-verbal de réception signé';
  let c = '';
  it('texte libre enregistré et relu (plus de 80 caractères) ; texte obligatoire en mode personnalisé', async () => {
    expect((await A.j.post('/customers', { name: 'Vide', paymentTermsCustom: true })).status).toBe(422);
    expect((await A.j.post('/customers', { name: 'Long', paymentTerms: 'x'.repeat(501) })).status).toBe(422);
    c = (await mkCustomer({ name: 'Conditions', paymentTerms: TERMS, paymentTermsCustom: true })).id;
    expect((await A.j.get(`/customers/${c}`)).body).toMatchObject({ paymentTerms: TERMS, paymentTermsCustom: true });
    expect((await col('customers').findOne({ _id: oid(c) }))!.paymentTerms).toBe(TERMS);
    expect(await pdfOf(`/customers/${c}/pdf`)).toContain('40 %');
  });
  it('repris dans le devis, adaptable par document, affiché au PDF, conservé à la conversion', async () => {
    const ctx = { ...A, customerId: c };
    const q = (await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)]))).body;
    expect(q).toMatchObject({ paymentTerms: TERMS, paymentTermsCustom: true });
    expect(await pdfOf(`/quotations/${q.id}/pdf`)).toContain('Conditions de paiement : 40 %');
    const own = (await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)], { paymentTerms: '50 % à la commande et 50 % à la livraison' }))).body;
    expect(own).toMatchObject({ paymentTerms: '50 % à la commande et 50 % à la livraison', paymentTermsCustom: true });
    expect((await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)], { paymentTerms: '30 jours' }))).body.paymentTermsCustom).toBe(false);
    expect((await A.j.post('/quotations', quoteBody(ctx, [line(A.products.a19)], { paymentTerms: null }))).body.paymentTerms).toBeNull();
    // modification sans préciser les conditions : conservées
    expect((await A.j.put(`/quotations/${own.id}`, quoteBody(ctx, [line(A.products.a19, 2)]))).body.paymentTerms).toBe('50 % à la commande et 50 % à la livraison');
    expect((await A.j.post(`/quotations/${own.id}/duplicate`)).body.paymentTerms).toBe('50 % à la commande et 50 % à la livraison');
    await acceptQuote(A.j, own.id); const pro = (await A.j.post(`/quotations/${own.id}/convert-proforma`)).body;
    expect((await A.j.get(`/proformas/${pro.proformaId}`)).body.paymentTerms).toBe('50 % à la commande et 50 % à la livraison');
    expect(await pdfOf(`/proformas/${pro.proformaId}/pdf`)).toContain('Conditions de paiement : 50 %');
  });
  it('conditions personnalisées : aucune échéance inventée ; échéancier réel requis ; facture validée figée', async () => {
    const d = (await A.j.post('/invoices', { customerId: c, lines: [line(A.products.a19)] })).body;
    expect(d).toMatchObject({ paymentTerms: TERMS, paymentTermsCustom: true, schedule: [] });
    const refused = await A.j.post(`/invoices/${d.id}/validate`);
    expect(refused.status).toBe(409); expect(refused.body.error.code).toBe('PAYMENT_SCHEDULE_REQUIRED');
    expect((await A.j.get(`/invoices/${d.id}`)).body).toMatchObject({ status: 'draft', number: null });
    const schedule = [{ dueDate: today(), percent: 40 }, { dueDate: plusDays(20), percent: 30 }, { dueDate: plusDays(60), percent: 30 }];
    expect((await A.j.put(`/invoices/${d.id}`, { customerId: c, lines: [line(A.products.a19)], schedule })).body.paymentTerms).toBe(TERMS);
    expect(await pdfOf(`/invoices/${d.id}/pdf`)).toContain('40 %');
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body;
    expect(v.status).toBe('validated'); expect(v.schedule.map((s: { percent: number }) => s.percent)).toEqual([40, 30, 30]);
    expect(v.schedule.reduce((s: number, x: { amountMinor: number }) => s + x.amountMinor, 0)).toBe(v.totals.totalPayableMinor);
    await A.j.put(`/customers/${c}`, { paymentTerms: 'Comptant', paymentTermsCustom: false, paymentDelayDays: 0 });
    expect((await A.j.get(`/invoices/${d.id}`)).body).toMatchObject({ paymentTerms: TERMS, paymentTermsCustom: true });
    expect(await pdfOf(`/invoices/${d.id}/pdf`)).toContain('Conditions de paiement : 40 %');
  });
  it('préréglage : échéance unique selon le délai, comme auparavant', async () => {
    const p = (await mkCustomer({ name: 'Trente', paymentTerms: '30 jours', paymentDelayDays: 30 })).id as string;
    const d = (await A.j.post('/invoices', { customerId: p, lines: [line(A.products.a19)] })).body;
    expect(d).toMatchObject({ paymentTerms: '30 jours', paymentTermsCustom: false });
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body;
    expect(v.schedule).toHaveLength(1); expect(v.schedule[0].dueDate.slice(0, 10)).toBe(plusDays(30));
  });
});

describe('impression des PDF', () => {
  it('montants au-delà de mille lisibles et pied de page sur la même page', async () => {
    const c = (await mkCustomer({ name: 'Impression' })).id as string;
    const q = (await A.j.post('/quotations', quoteBody({ ...A, customerId: c }, [line(A.products.a19, 20)]))).body;
    const r = await request(app).get(`/api/v1/quotations/${q.id}/pdf`).set(authed(A.token)).buffer().parse(binaryParser);
    const text = pdfText(r.body as Buffer);
    expect(text).toContain('montants en'); expect(text).not.toMatch(/\/\d{3},/); expect(text).toMatch(/2\s000,000/);
    expect((r.body as Buffer).toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});

describe('migration des tiers (simulation, exécution, idempotence)', () => {
  it('convertit sans rien perdre et ne touche pas aux documents', async () => {
    await Customer.deleteMany({}); await Supplier.deleteMany({});
    const company = new mongoose.Types.ObjectId(); const kid = new mongoose.Types.ObjectId();
    const base = { companyId: company, balanceMinor: 0, isArchived: false, contacts: [] };
    const ins = await col('customers').insertMany([
      { ...base, name: 'Avec livraison', code: 'CL-00001', address: { country: 'Tunisie' }, shippingSameAsBilling: false, shippingAddress: { street: 'Dépôt', city: 'Sfax', postalCode: '3000', country: 'Tunisie' },
        phone: '71 000 000', secondaryPhone: 'voir standard', registryNumber: 'RC-1', sector: 'Industrie', contacts: [{ _id: kid, name: 'Contact', phone: '23108065', isPrimary: true }] },
      { ...base, name: 'Identique', code: 'CL-00002', shippingSameAsBilling: true, subjectToWithholding: true, stampExempt: true, phone: '+216 98 000 000' },
      { ...base, name: 'Français', code: 'CL-00003', address: { country: 'France' }, phone: '06 12 34 56 78' },
    ]);
    await col('suppliers').insertOne({ companyId: company, name: 'Ancien fournisseur', address: { city: 'Tunis' }, contacts: [], isArchived: false, balanceMinor: 0 });
    const ids = Object.values(ins.insertedIds);
    const snapshot = async () => JSON.stringify([await col('customers').find().sort({ _id: 1 }).toArray(), await col('suppliers').find().sort({ _id: 1 }).toArray()]);
    const documents = async () => JSON.stringify([await col('quotations').find().sort({ _id: 1 }).toArray(), await col('invoices').find().sort({ _id: 1 }).toArray()]);
    const docs0 = await documents(); const before = await snapshot();

    const dry = await migrateParties({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, customersScanned: 3, suppliersScanned: 1, addressListsCreated: 3, addressesConverted: 1, supplierListsCreated: 1, fiscalPreserved: 2, phonesNormalized: 4 });
    expect(dry.phonesUnrecognized).toEqual([{ customer: 'CL-00001', field: 'téléphone secondaire', value: 'voir standard' }]);
    expect(await snapshot()).toBe(before); // simulation : aucune écriture

    const real = await migrateParties();
    expect({ ...real, dryRun: true }).toEqual(dry);
    const one = (await col('customers').findOne({ _id: ids[0] }))!;
    expect(one).toMatchObject({ phone: '+21671000000', secondaryPhone: 'voir standard', registryNumber: 'RC-1', sector: 'Industrie', subjectToWithholding: false, stampExempt: false,
      shippingSameAsBilling: false, shippingAddress: { city: 'Sfax' } }); // anciennes valeurs conservées
    expect(one.contacts[0]).toMatchObject({ _id: kid, phone: '+21623108065' });
    expect(one.phoneOriginals).toEqual({ phone: '71 000 000', contacts_0_phone: '23108065' });
    expect(one.deliveryAddresses).toHaveLength(1);
    expect(one.deliveryAddresses[0]).toMatchObject({ label: 'Adresse de livraison', street: 'Dépôt', city: 'Sfax', postalCode: '3000', isDefault: true });
    expect(String(one.deliveryAddresses[0]._id)).toBe(String(ids[0]));
    expect((await col('customers').findOne({ _id: ids[1] }))!).toMatchObject({ deliveryAddresses: [], subjectToWithholding: true, stampExempt: true, phone: '+21698000000' });
    expect((await col('customers').findOne({ _id: ids[2] }))!.phone).toBe('+33612345678');
    expect((await col('suppliers').findOne({ companyId: company }))!).toMatchObject({ deliveryAddresses: [], address: { city: 'Tunis' } });
    expect(await documents()).toBe(docs0);

    const after = await snapshot();
    const again = await migrateParties();
    expect(again).toMatchObject({ addressListsCreated: 0, addressesConverted: 0, supplierListsCreated: 0, fiscalPreserved: 0, phonesNormalized: 0 });
    expect(again.phonesUnrecognized).toHaveLength(1);
    expect(await snapshot()).toBe(after);
  });
});
