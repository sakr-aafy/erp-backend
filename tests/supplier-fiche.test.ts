/**
 * Module Référentiels › Fournisseurs : catégories administrables, fiche à huit onglets, statuts, achats et règlements
 * (dont anciennes dettes), documents, activités, permissions, isolation multi-société et migration.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, authed, binaryParser, login, makeUser, parseXlsx, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, logisticsCompany, plusDays, type LCtx } from './sales.helpers.js';
import { Supplier, SupplierActivity, SupplierCategory } from '../src/models/supplier.model.js';
import { Setting } from '../src/models/setting.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { DEFAULT_SUPPLIER_CATEGORIES, initSupplierCategories } from '../src/modules/suppliers/supplier.categories.js';
import { migrateSuppliers } from '../src/modules/suppliers/supplier.migration.js';

let A: LCtx, B: LCtx;
beforeAll(async () => { await setupDb(); A = await logisticsCompany('Alpha', 'admin@sa.test'); B = await logisticsCompany('Beta', 'admin@sb.test'); });
afterAll(async () => { await teardownDb(); });

const col = (name: string) => mongoose.connection.db!.collection(name);
let seq = 0;
const mk = async (extra: object = {}, c: LCtx = A) => { const r = await c.j.post('/suppliers', { name: `Fournisseur ${++seq}`, taxId: `SF-${seq}`, ...extra }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const cats = async (c: LCtx = A) => (await c.j.get('/supplier-categories')).body as { items: { id: string; name: string; isActive: boolean; supplierCount: number }[]; unclassifiedCount: number };
const binary = async (url: string, token: string) => { const r = await request(app).get(`/api/v1${url}`).set(authed(token)).buffer().parse(binaryParser); return { status: r.status, body: r.body as Buffer, headers: r.headers }; };
const user = async (c: LCtx, email: string, permissions: string[]) => { await makeUser(c.companyId, email, permissions); const token = (await login(email)).token; return { token, j: J(token) }; };
const account = async (c: LCtx) => (await c.j.post('/treasury/accounts', { code: `B${++seq}`, name: `Banque ${seq}`, type: 'bank', openingBalanceMinor: 100_000_000 })).body.id as string;
/** Commande → réception → facture validée pour un fournisseur local ; renvoie la facture. */
async function buy(c: LCtx, supplierId: string, unitPriceMinor = 1_000_000, quantity = 2, extra: object = {}) {
  const po = (await c.j.post('/purchase-orders', { supplierId, lines: [{ productId: c.products.a19, quantity, unitPriceMinor }] })).body;
  const ok = await c.j.post(`/purchase-orders/${po.id}/confirm`); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  const rec = (await c.j.post('/goods-receipts', { purchaseOrderId: po.id, warehouseId: c.w1, lines: [{ orderLineId: ok.body.lines[0].id, quantity }] })).body;
  expect((await c.j.post(`/goods-receipts/${rec.id}/validate`)).status).toBe(200);
  const draft = (await c.j.post('/purchase-invoices', { supplierId, supplierInvoiceNumber: `EXT-${++seq}`, purchaseOrderId: po.id, lines: [{ productId: c.products.a19, orderLineId: ok.body.lines[0].id, quantity, unitPriceMinor }], ...extra })).body;
  const inv = await c.j.post(`/purchase-invoices/${draft.id}/validate`); expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  return { po: ok.body, receipt: rec, invoice: inv.body };
}

describe('catégories de fournisseurs', () => {
  it('sept catégories proposées à la création de la société, une seule fois, par société', async () => {
    const list = await cats();
    expect(list.items.map((c) => c.name).sort()).toEqual([...DEFAULT_SUPPLIER_CATEGORIES].sort());
    expect((await cats(B)).items).toHaveLength(7);
    const gone = list.items.find((c) => c.name === 'Transitaire')!;
    expect((await A.j.del(`/supplier-categories/${gone.id}`)).status).toBe(200);
    expect(await initSupplierCategories(A.companyId)).toBe(0); // idempotent : une catégorie supprimée n'est pas recréée
    expect((await cats()).items).toHaveLength(6);
  });
  it('création, modification, noms vides et doublons refusés (casse ignorée), même nom permis dans une autre société', async () => {
    const c = await A.j.post('/supplier-categories', { name: 'Emballages', description: 'Cartons et palettes' }); expect(c.status).toBe(201); expect(c.body).toMatchObject({ name: 'Emballages', isActive: true, supplierCount: 0, createdAt: expect.any(String) });
    for (const name of ['  ', '']) expect((await A.j.post('/supplier-categories', { name })).status).toBe(422);
    expect((await A.j.post('/supplier-categories', { name: 'EMBALLAGES' })).status).toBe(409);
    expect((await A.j.post('/supplier-categories', { name: 'transporteur' })).status).toBe(409);
    expect((await B.j.post('/supplier-categories', { name: 'Emballages' })).status).toBe(201);
    const u = await A.j.put(`/supplier-categories/${c.body.id}`, { name: 'Emballage', description: null }); expect(u.body).toMatchObject({ name: 'Emballage', description: null });
    expect((await A.j.put(`/supplier-categories/${c.body.id}`, { name: 'Transporteur' })).status).toBe(409);
    expect((await A.j.put(`/supplier-categories/${c.body.id}`, { name: 'emballage' })).status).toBe(200); // changement de casse de la même catégorie
    expect((await A.j.get('/supplier-categories?q=embal')).body.items).toHaveLength(1);
  });
  it('association, compteurs réels, filtre, non classés', async () => {
    const list = await cats(); const transport = list.items.find((c) => c.name === 'Transporteur')!;
    const s = await mk({ categoryId: transport.id }); expect(s).toMatchObject({ categoryId: transport.id, categoryName: 'Transporteur' });
    const after = await cats(); expect(after.items.find((c) => c.id === transport.id)!.supplierCount).toBe(1); expect(after.unclassifiedCount).toBeGreaterThanOrEqual(2);
    expect((await A.j.get(`/suppliers?categoryId=${transport.id}`)).body.items.map((x: { id: string }) => x.id)).toEqual([s.id]);
    expect((await A.j.get('/suppliers?categoryId=none')).body.items.map((x: { id: string }) => x.id)).not.toContain(s.id);
    expect((await A.j.put(`/suppliers/${s.id}`, { categoryId: null })).body).toMatchObject({ categoryId: null, categoryName: null });
    expect((await SupplierActivity.find({ supplierId: s.id, kind: 'category_changed' }).lean()).map((a) => a.title)).toEqual(['Catégorie : Transporteur → Non classé']);
  });
  it('désactivée : plus proposée pour une nouvelle association, conservée par les fournisseurs existants ; réactivation', async () => {
    const c = (await A.j.post('/supplier-categories', { name: 'Outillage' })).body.id;
    const s = await mk({ categoryId: c });
    expect((await A.j.post(`/supplier-categories/${c}/deactivate`)).body.isActive).toBe(false);
    expect((await A.j.get('/supplier-categories?active=true')).body.items.map((x: { id: string }) => x.id)).not.toContain(c);
    expect((await A.j.post('/suppliers', { name: 'Nouveau', categoryId: c })).status).toBe(400);
    const kept = await A.j.put(`/suppliers/${s.id}`, { name: 'Toujours classé', categoryId: c }); expect(kept.status).toBe(200); expect(kept.body).toMatchObject({ categoryId: c, categoryActive: false });
    expect((await A.j.post(`/supplier-categories/${c}/activate`)).body.isActive).toBe(true);
  });
  it('suppression : libre si inutilisée ; utilisée → réaffectation obligatoire, aucun fournisseur supprimé', async () => {
    const from = (await A.j.post('/supplier-categories', { name: 'À fusionner' })).body.id;
    const to = (await A.j.post('/supplier-categories', { name: 'Cible' })).body.id;
    const s1 = await mk({ categoryId: from }); const s2 = await mk({ categoryId: from }); const total = await Supplier.countDocuments({ companyId: A.companyId });
    const refused = await A.j.del(`/supplier-categories/${from}`); expect(refused.status).toBe(409); expect(refused.body.error.code).toBe('CATEGORY_IN_USE');
    expect((await A.j.del(`/supplier-categories/${from}?reassignTo=${from}`)).status).toBe(400);
    const foreign = (await cats(B)).items[0]!.id; expect((await A.j.del(`/supplier-categories/${from}?reassignTo=${foreign}`)).status).toBe(404);
    const done = await A.j.del(`/supplier-categories/${from}?reassignTo=${to}`); expect(done.body).toMatchObject({ reassigned: 2, reassignedTo: 'Cible' });
    for (const id of [s1.id, s2.id]) expect((await A.j.get(`/suppliers/${id}`)).body.categoryName).toBe('Cible');
    expect(await Supplier.countDocuments({ companyId: A.companyId })).toBe(total);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'supplier-category', action: 'delete' })).toBeGreaterThanOrEqual(1);
  });
  it('isolation multi-société et permissions', async () => {
    const mine = (await cats()).items[0]!.id; const theirs = (await cats(B)).items[0]!.id;
    expect((await B.j.put(`/supplier-categories/${mine}`, { name: 'x' })).status).toBe(404); expect((await B.j.del(`/supplier-categories/${mine}`)).status).toBe(404);
    expect((await A.j.post('/suppliers', { name: 'Intrus', categoryId: theirs })).status).toBe(400);
    const v = await user(A, 'catview@sa.test', ['suppliers:view']);
    expect((await v.j.get('/supplier-categories')).status).toBe(200); expect((await v.j.post('/supplier-categories', { name: 'Non' })).status).toBe(403);
    expect((await v.j.put(`/supplier-categories/${mine}`, { name: 'Non' })).status).toBe(403); expect((await v.j.del(`/supplier-categories/${mine}`)).status).toBe(403);
    const none = await user(A, 'catnone@sa.test', ['customers:view']); expect((await none.j.get('/supplier-categories')).status).toBe(403);
    expect((await request(app).get('/api/v1/supplier-categories')).status).toBe(401);
  });
});

describe('fiche fournisseur', () => {
  it('codes FR-00001 uniques sous concurrence ; un code historique n’est jamais remplacé', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => A.j.post('/suppliers', { name: `Concurrent ${i}` })));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const codes = created.map((r) => r.body.code as string); expect(new Set(codes).size).toBe(20); expect(codes.every((c) => /^FR-\d{5}$/.test(c))).toBe(true);
    expect((await A.j.post('/suppliers', { name: 'Code imposé', code: 'FR-99999' })).status).toBe(422);
    await Supplier.updateOne({ _id: created[0]!.body.id }, { code: 'FOU-00007' });
    expect((await A.j.put(`/suppliers/${created[0]!.body.id}`, { name: 'Historique' })).body.code).toBe('FOU-00007');
  });
  it('local et étranger : devise obligatoire, matricule facultatif, pas d’indicatif tunisien imposé', async () => {
    const local = await mk({ phone: '23108065', secondaryPhone: '71 000 000', contacts: [{ name: 'Ali', phone: '98 765 432' }], address: { city: 'Tunis', country: 'Tunisie' } });
    expect(local).toMatchObject({ phone: '+21623108065', secondaryPhone: '+21671000000' }); expect(local.phoneInfo.display).toBe('+216 23 108 065'); expect(local.contacts[0].phone).toBe('+21698765432');
    const german = await mk({ isForeign: true, currency: 'EUR', taxId: null, phone: '030 901820', address: { country: 'Allemagne' } }); expect(german.phone).toBe('+4930901820');
    const unknown = await A.j.post('/suppliers', { name: 'Pays inconnu', isForeign: true, currency: 'EUR', phone: '23108065' }); expect(unknown.body.phone).toBe('23108065');
    expect((await A.j.post('/suppliers', { name: 'Sans devise', isForeign: true })).status).toBe(400);
    expect((await A.j.post('/suppliers', { name: 'Mauvais numéro', phone: 'abc' })).status).toBe(422);
    expect((await A.j.post('/suppliers', { name: 'URL dangereuse', website: 'javascript:alert(1)' })).status).toBe(422);
    for (const q of ['23108065', '23 108 065', 'Ali']) expect((await A.j.get(`/suppliers?q=${encodeURIComponent(q)}`)).body.items.map((x: { id: string }) => x.id), q).toContain(local.id);
  });
  it('champs complets, conditions personnalisées conservées, aucun champ RC / secteur ni fiscal', async () => {
    const terms = '30 % à la commande et 70 % avant expédition';
    const s = await mk({ website: 'https://f.tn', social: { facebook: 'https://facebook.com/f' }, mapsUrl: 'https://maps.google.com/?q=1', paymentTerms: terms, paymentTermsCustom: true, paymentMethod: 'check', discountPct: 5, leadTimeDays: 12 });
    expect(s).toMatchObject({ paymentTerms: terms, paymentTermsCustom: true, paymentDelayDays: 0, paymentMethod: 'check', discountPct: 5, leadTimeDays: 12, website: 'https://f.tn', social: { facebook: 'https://facebook.com/f', linkedin: null } });
    expect((await A.j.post('/suppliers', { name: 'Texte vide', paymentTermsCustom: true })).status).toBe(422);
    for (const extra of [{ registryNumber: 'x' }, { sector: 'x' }, { subjectToWithholding: true }, { balanceMinor: 5 }, { status: 'blocked' }]) expect((await A.j.post('/suppliers', { name: 'Interdit', ...extra })).status, JSON.stringify(extra)).toBe(422);
    expect((await A.j.put(`/suppliers/${s.id}`, { balanceMinor: 1 })).status).toBe(422);
    const cleared = await A.j.put(`/suppliers/${s.id}`, { website: null, social: { facebook: null }, paymentMethod: null }); expect(cleared.body).toMatchObject({ website: null, paymentMethod: null, social: { facebook: null } });
  });
  it('contacts multiples : un seul principal, repris dans le résumé', async () => {
    const s = await mk();
    await A.j.post(`/suppliers/${s.id}/contacts`, { name: 'Premier', role: 'Gérant' });
    const two = (await A.j.post(`/suppliers/${s.id}/contacts`, { name: 'Second', email: 'b@f.tn', isPrimary: true })).body;
    expect(two.contacts.filter((k: { isPrimary: boolean }) => k.isPrimary).map((k: { name: string }) => k.name)).toEqual(['Second']);
    expect((await A.j.get(`/suppliers/${s.id}/summary`)).body.supplier.primaryContact).toMatchObject({ name: 'Second', email: 'b@f.tn' });
    const first = two.contacts[0]._id; await A.j.post(`/suppliers/${s.id}/contacts/${first}/primary`);
    await A.j.del(`/suppliers/${s.id}/contacts/${first}`);
    expect((await A.j.get(`/suppliers/${s.id}`)).body.contacts).toEqual([expect.objectContaining({ name: 'Second', isPrimary: true })]);
    expect((await B.j.post(`/suppliers/${s.id}/contacts`, { name: 'x' })).status).toBe(404);
  });
  it('adresses multiples : une seule par défaut ; copiée sur la commande, conservée si utilisée', async () => {
    const s = await mk();
    await A.j.post(`/suppliers/${s.id}/delivery-addresses`, { label: 'Usine', street: 'ZI 1', city: 'Sfax', country: 'Tunisie' });
    const r = (await A.j.post(`/suppliers/${s.id}/delivery-addresses`, { label: 'Dépôt', street: 'Route 2', city: 'Sousse', country: 'Tunisie', isDefault: true })).body;
    expect(r.deliveryAddresses.filter((a: { isDefault: boolean }) => a.isDefault).map((a: { label: string }) => a.label)).toEqual(['Dépôt']);
    const po = (await A.j.post('/purchase-orders', { supplierId: s.id, lines: [{ productId: A.products.a19, quantity: 1, unitPriceMinor: 100 }] })).body;
    expect(po.supplierAddress).toMatchObject({ label: 'Dépôt' }); expect(po.receivingAddress.name).toBeTruthy();
    const used = r.deliveryAddresses.find((a: { label: string }) => a.label === 'Dépôt').id;
    expect((await A.j.del(`/suppliers/${s.id}/delivery-addresses/${used}`)).body.addressArchived).toBe(true);
    expect((await A.j.get(`/purchase-orders/${po.id}`)).body.supplierAddress.label).toBe('Dépôt');
  });
  it('liste : filtres statut, pays, origine, solde, tri ; export et fiche PDF', async () => {
    const it1 = await mk({ name: 'Milano Utensili', isForeign: true, currency: 'EUR', address: { city: 'Milan', country: 'Italie' } });
    expect((await A.j.get('/suppliers/countries')).body).toContain('Italie');
    expect((await A.j.get('/suppliers?country=italie')).body.items.map((x: { id: string }) => x.id)).toEqual([it1.id]);
    expect((await A.j.get('/suppliers?foreign=true&limit=100')).body.items.every((x: { isForeign: boolean }) => x.isForeign)).toBe(true);
    expect((await A.j.get('/suppliers?foreign=false&limit=100')).body.items.map((x: { id: string }) => x.id)).not.toContain(it1.id);
    expect((await A.j.get(`/suppliers?supplierId=${it1.id}`)).body.total).toBe(1);
    expect((await A.j.get('/suppliers?sort=country&limit=100')).status).toBe(200); expect((await A.j.get('/suppliers?sort=-code')).status).toBe(200);
    const csv = (await binary('/suppliers/export?format=csv&country=Italie', A.token)).body.toString('utf8'); expect(csv).toContain('Catégorie'); expect(csv).toContain('Non classé'); expect(csv).toContain('Milano Utensili');
    const pdf = pdfText((await binary(`/suppliers/${it1.id}/pdf`, A.token)).body); for (const t of ['Fiche fournisseur', 'Non classé', 'Milano Utensili', 'Solde dû']) expect(pdf).toContain(t);
  });
});

describe('statuts, commandes et anciennes dettes', () => {
  let s = ''; let bank = ''; let invoice: { id: string; number: string; totals: { totalTtcMinor: number } }; let po: { id: string };
  beforeAll(async () => {
    s = (await mk({ name: 'Dette Ancienne', paymentTerms: '60 jours', paymentDelayDays: 60 })).id; bank = await account(A);
    ({ invoice, po } = await buy(A, s, 1_000_000, 2, { invoiceDate: plusDays(-40), dueDate: plusDays(-10) }));
  });
  const order = (supplierId: string) => A.j.post('/purchase-orders', { supplierId, lines: [{ productId: A.products.a19, quantity: 1, unitPriceMinor: 100 }] });

  it('la commande reprend les conditions de paiement ; le solde vient de la facture validée', async () => {
    expect((await A.j.get(`/purchase-orders/${po.id}`)).body.paymentTerms).toBe('60 jours');
    const custom = await A.j.post('/purchase-orders', { supplierId: s, paymentTerms: 'À réception', lines: [{ productId: A.products.a19, quantity: 1, unitPriceMinor: 100 }] }); expect(custom.body.paymentTerms).toBe('À réception');
    await A.j.del(`/purchase-orders/${custom.body.id}`);
    expect((await A.j.get(`/suppliers/${s}`)).body.balanceMinor).toBe(invoice.totals.totalTtcMinor);
  });
  it('inactif, bloqué, archivé : nouvelle commande refusée (création et confirmation) ; brouillon antérieur non confirmable', async () => {
    const draft = (await order(s)).body;
    for (const [status, code] of [['inactive', 'SUPPLIER_INACTIVE'], ['blocked', 'SUPPLIER_BLOCKED'], ['archived', 'SUPPLIER_ARCHIVED']] as const) {
      expect((await A.j.post(`/suppliers/${s}/status`, { status, reason: 'Test' })).body).toMatchObject({ status, canOrder: false });
      const r = await order(s); expect(r.status, status).toBe(409); expect(r.body.error.code).toBe(code);
      const confirm = await A.j.post(`/purchase-orders/${draft.id}/confirm`); expect(confirm.status).toBe(409); expect(confirm.body.error.code).toBe(code);
      await A.j.post(`/suppliers/${s}/status`, { status: 'active' });
    }
    await A.j.del(`/purchase-orders/${draft.id}`);
  });
  it('import refusé pour un fournisseur étranger inactif ; changement vers un fournisseur inactif refusé', async () => {
    const f = await mk({ isForeign: true, currency: 'EUR' });
    const body = { supplierId: f.id, currency: 'EUR', exchangeRate: 3.4, lines: [{ productId: A.products.a19, quantity: 1, unitPriceMinor: 100 }] };
    const dossier = await A.j.post('/imports', body); expect(dossier.status).toBe(201);
    await A.j.post(`/suppliers/${f.id}/status`, { status: 'inactive' });
    const r = await A.j.post('/imports', body); expect(r.status).toBe(409); expect(r.body.error.code).toBe('SUPPLIER_INACTIVE');
    expect((await A.j.put(`/imports/${dossier.body.id}`, body)).status).toBe(200); // dossier existant toujours modifiable
    const other = await mk({ isForeign: true, currency: 'EUR' }); const d2 = (await A.j.post('/imports', { ...body, supplierId: other.id })).body;
    expect((await A.j.put(`/imports/${d2.id}`, body)).status).toBe(409);
  });
  it('commande déjà confirmée : réception et facture restent possibles après archivage du fournisseur', async () => {
    const x = (await mk()).id;
    const o = (await order(x)).body; const ok = (await A.j.post(`/purchase-orders/${o.id}/confirm`)).body;
    await A.j.post(`/suppliers/${x}/status`, { status: 'archived' });
    const rec = await A.j.post('/goods-receipts', { purchaseOrderId: o.id, warehouseId: A.w1, lines: [{ orderLineId: ok.lines[0].id, quantity: 1 }] }); expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect((await A.j.post(`/goods-receipts/${rec.body.id}/validate`)).status).toBe(200);
    const draft = await A.j.post('/purchase-invoices', { supplierId: x, supplierInvoiceNumber: 'APRES-ARCH', purchaseOrderId: o.id, lines: [{ productId: A.products.a19, orderLineId: ok.lines[0].id, quantity: 1, unitPriceMinor: 100 }] }); expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await A.j.post(`/purchase-invoices/${draft.body.id}/validate`)).status).toBe(200);
    expect((await A.j.get(`/suppliers/${x}`)).body.balanceMinor).toBe(119);
  });
  it('seuil d’impayés : création possible en brouillon, confirmation bloquée, règle existante conservée', async () => {
    await A.j.put(`/suppliers/${s}`, { blockThresholdMinor: 1000 });
    expect((await A.j.get(`/suppliers/${s}`)).body).toMatchObject({ ordersBlocked: true, canOrder: false, effectiveThresholdMinor: 1000 });
    const d = (await order(s)).body; const r = await A.j.post(`/purchase-orders/${d.id}/confirm`); expect(r.status).toBe(409); expect(r.body.error.code).toBe('SUPPLIER_BLOCKED');
    await A.j.del(`/purchase-orders/${d.id}`); await A.j.put(`/suppliers/${s}`, { blockThresholdMinor: null });
  });
  it('fournisseur ARCHIVÉ : consultation, règlement partiel puis total, relevé, soldes et cohérence', async () => {
    await A.j.post(`/suppliers/${s}/status`, { status: 'archived' });
    const sum = (await A.j.get(`/suppliers/${s}/summary`)).body; const ttc = invoice.totals.totalTtcMinor;
    expect(sum.finance).toMatchObject({ billedMinor: ttc, paidMinor: 0, balanceMinor: ttc, unpaidMinor: ttc, overdueMinor: ttc, overdueInvoices: 1, upcomingMinor: 0, consistent: true });
    expect((await A.j.get(`/suppliers/${s}/transactions`)).body.total).toBe(3);
    const part = await A.j.post('/supplier-payments', { supplierId: s, treasuryAccountId: bank, method: 'transfer', reference: 'VIR-1', allocations: [{ purchaseInvoiceId: invoice.id, amountMinor: 500_000 }] }); expect(part.status, JSON.stringify(part.body)).toBe(201);
    let pay = (await A.j.get(`/suppliers/${s}/payments`)).body;
    expect(pay.finance).toMatchObject({ paidMinor: 500_000, balanceMinor: ttc - 500_000, unpaidMinor: ttc - 500_000 });
    expect(pay.unpaidInvoices).toEqual([expect.objectContaining({ id: invoice.id, paymentStatus: 'partial', remainingMinor: ttc - 500_000, overdue: true })]);
    expect(pay.items[0]).toMatchObject({ number: part.body.number, reference: 'VIR-1', amountMinor: 500_000, method: 'transfer', status: 'active', invoices: [expect.objectContaining({ id: invoice.id })] }); expect(pay.items[0].account).toMatch(/Banque/);
    const rest = await A.j.post('/supplier-payments', { supplierId: s, treasuryAccountId: bank, method: 'check', allocations: [{ purchaseInvoiceId: invoice.id, amountMinor: ttc - 500_000 }] }); expect(rest.status).toBe(201);
    pay = (await A.j.get(`/suppliers/${s}/payments`)).body; expect(pay.finance).toMatchObject({ balanceMinor: 0, unpaidMinor: 0, paidMinor: ttc, consistent: true }); expect(pay.unpaidInvoices).toEqual([]); expect(pay.total).toBe(2);
    expect((await A.j.get(`/suppliers/${s}`)).body).toMatchObject({ status: 'archived', balanceMinor: 0 }); // aucune réactivation nécessaire
    const st = await binary(`/suppliers/${s}/statement?format=xlsx`, A.token); expect(st.status).toBe(200); const rows = await parseXlsx(st.body); expect(rows).toHaveLength(2); expect(rows[0]).toContain('Reste dû');
    expect((await binary(`/suppliers/${s}/payments/export?format=csv`, A.token)).body.toString('utf8')).toContain('VIR-1');
    expect((await binary(`/suppliers/${s}/transactions/export?format=csv`, A.token)).body.toString('utf8')).toContain(invoice.number);
    expect((await binary(`/suppliers/${s}/pdf`, A.token)).status).toBe(200);
    for (const url of ['/accounting/consistency', '/treasury/consistency', '/stock/consistency']) { const c = (await A.j.get(url)).body; expect(c.consistent, JSON.stringify(c)).toBe(true); }
    await A.j.post(`/suppliers/${s}/status`, { status: 'active' });
  });
  it('transactions : types, filtres, pagination ; dossier d’importation avec devise d’origine et contre-valeur réelle', async () => {
    const all = (await A.j.get(`/suppliers/${s}/transactions?limit=2`)).body; expect(all.total).toBe(3); expect(all.items).toHaveLength(2);
    expect((await A.j.get(`/suppliers/${s}/transactions?type=purchase_invoice&status=paid`)).body.items.map((r: { kind: string }) => r.kind)).toEqual(['purchase_invoice']);
    expect((await A.j.get(`/suppliers/${s}/transactions?q=${invoice.number}`)).body.total).toBe(1);
    expect((await A.j.get(`/suppliers/${s}/transactions?from=${plusDays(-60)}&to=${plusDays(-30)}`)).body.total).toBe(1);
    const f = await mk({ isForeign: true, currency: 'EUR' });
    await A.j.post('/imports', { supplierId: f.id, currency: 'EUR', exchangeRate: 3.42, lines: [{ productId: A.products.a19, quantity: 2, unitPriceMinor: 10_000 }] });
    const rows = (await A.j.get(`/suppliers/${f.id}/transactions`)).body.items;
    expect(rows).toEqual([expect.objectContaining({ kind: 'import_file', currency: 'EUR', foreignMinor: 20_000, totalHtMinor: 684_000, totalTtcMinor: null })]); // taux réel 3,42, jamais 3,5
  });
  it('activités : manuelles modifiables, automatiques immuables et sans doublon', async () => {
    const m = await A.j.post(`/suppliers/${s}/activities`, { kind: 'task', title: 'Demander le tarif' }); expect(m.status).toBe(201);
    const list = (await A.j.get(`/suppliers/${s}/activities?limit=100`)).body; const kinds = list.items.map((a: { kind: string }) => a.kind);
    for (const k of ['supplier_created', 'status_changed', 'order_created', 'order_confirmed', 'receipt_validated', 'purchase_invoice_validated', 'payment_recorded', 'task']) expect(kinds, k).toContain(k);
    expect(new Set(list.items.map((a: { id: string }) => a.id)).size).toBe(list.items.length); expect(list.total).toBe(list.items.length);
    expect(kinds.filter((k: string) => k === 'purchase_invoice_validated')).toHaveLength(1); expect(kinds.filter((k: string) => k === 'payment_recorded')).toHaveLength(2);
    expect((await A.j.get(`/suppliers/${s}/activities?kind=payment_recorded`)).body.total).toBe(2);
    const p2 = (await A.j.get(`/suppliers/${s}/activities?limit=3&page=2`)).body; expect(p2.items).toHaveLength(3); expect(p2.items[0].id).toBe(list.items[3].id);
    const auto = list.items.find((a: { kind: string; derived: boolean }) => a.kind === 'status_changed' && !a.derived);
    expect((await A.j.put(`/suppliers/${s}/activities/${auto.id}`, { title: 'Falsifié' })).status).toBe(409); expect((await A.j.del(`/suppliers/${s}/activities/${auto.id}`)).status).toBe(409);
    expect((await A.j.put(`/suppliers/${s}/activities/${m.body.id}`, { title: 'Tarif demandé' })).body.title).toBe('Tarif demandé');
    expect((await B.j.del(`/suppliers/${s}/activities/${m.body.id}`)).status).toBe(404); expect((await A.j.del(`/suppliers/${s}/activities/${m.body.id}`)).status).toBe(204);
  });
  it('suppression refusée (achats ou article liés) ; permise sinon', async () => {
    expect((await A.j.del(`/suppliers/${s}`)).status).toBe(409);
    const linked = await mk();
    await A.j.put(`/products/${A.products.a19}/prices`, { mainSupplierId: linked.id });
    const r = await A.j.del(`/suppliers/${linked.id}`); expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/fournisseur habituel/);
    await A.j.put(`/products/${A.products.a19}/prices`, { mainSupplierId: null });
    expect((await A.j.del(`/suppliers/${linked.id}`)).status).toBe(204); expect(await SupplierActivity.countDocuments({ supplierId: linked.id })).toBe(0);
  });
});

describe('documents', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const upload = (id: string, token: string, name: string, content = pdf, type = 'contract') => request(app).post(`/api/v1/suppliers/${id}/documents`).set(authed(token)).field('type', type).attach('file', content, name);
  it('envoi sécurisé, téléchargement, métadonnées, isolation ; lecture conservée après archivage', async () => {
    const s = await mk();
    const d = await upload(s.id, A.token, 'Contrat.pdf'); expect(d.status, JSON.stringify(d.body)).toBe(201); expect(d.body).toMatchObject({ typeLabel: 'Contrat fournisseur', name: 'Contrat.pdf' });
    expect((await upload(s.id, A.token, 'virus.exe', Buffer.from('MZ'))).status).toBe(400); expect((await upload(s.id, A.token, 'faux.pdf', Buffer.from('MZ ceci n’est pas un PDF'))).status).toBe(400);
    expect((await upload(s.id, A.token, 'x.pdf', pdf, 'inconnu')).status).toBe(422); expect((await upload(s.id, A.token, 'gros.pdf', Buffer.concat([pdf, Buffer.alloc(11 * 1024 * 1024)]))).status).toBe(413);
    expect((await upload(s.id, B.token, 'x.pdf')).status).toBe(404); expect((await binary(`/suppliers/${s.id}/documents/${d.body.id}/file`, B.token)).status).toBe(404);
    expect((await request(app).get(`/api/v1/suppliers/${s.id}/documents/${d.body.id}/file`)).status).toBe(401);
    expect((await A.j.put(`/suppliers/${s.id}/documents/${d.body.id}`, { type: 'price_list', description: 'Tarif 2026' })).body.typeLabel).toBe('Tarif fournisseur');
    await A.j.post(`/suppliers/${s.id}/status`, { status: 'archived' });
    const file = await binary(`/suppliers/${s.id}/documents/${d.body.id}/file`, A.token); expect(file.status).toBe(200); expect(file.body.equals(pdf)).toBe(true); expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await upload(s.id, A.token, 'apres.pdf')).status).toBe(409); expect((await A.j.del(`/suppliers/${s.id}/documents/${d.body.id}`)).status).toBe(409);
    expect((await A.j.get(`/suppliers/${s.id}/documents`)).body.items).toHaveLength(1);
    await A.j.post(`/suppliers/${s.id}/status`, { status: 'active' });
    expect((await A.j.del(`/suppliers/${s.id}/documents/${d.body.id}`)).status).toBe(204);
    expect(await col('supplierFiles.files').countDocuments({ 'metadata.ownerId': new mongoose.Types.ObjectId(s.id) })).toBe(0);
  });
});

describe('permissions : consulter un fournisseur ne donne ni les montants ni les documents d’achat', () => {
  let s = '';
  beforeAll(async () => { s = (await mk({ name: 'Confidentiel', blockThresholdMinor: 10 })).id; await buy(A, (await mk()).id); await A.j.put(`/suppliers/${s}`, { blockThresholdMinor: 10 }); await Supplier.updateOne({ _id: s }, { balanceMinor: 777 }); });
  it('suppliers:view seul : montants masqués partout ; transactions, paiements, relevé refusés', async () => {
    const v = await user(A, 'lecteur@sa.test', ['suppliers:view']);
    const one = (await v.j.get(`/suppliers/${s}`)).body; expect(one).toMatchObject({ balanceMinor: null, blockThresholdMinor: null, effectiveThresholdMinor: null, ordersBlocked: false });
    const list = (await v.j.get('/suppliers?limit=100&sort=-balanceMinor')).body; expect(list.summary.totalBalanceMinor).toBeNull(); expect(list.items.every((x: { balanceMinor: number | null }) => x.balanceMinor === null)).toBe(true);
    expect((await v.j.get('/suppliers?withBalance=true')).status).toBe(403); expect((await v.j.get('/suppliers/export?format=csv&withBalance=true')).status).toBe(403);
    expect((await binary('/suppliers/export?format=csv', v.token)).body.toString('utf8')).not.toContain('Solde');
    expect(pdfText((await binary(`/suppliers/${s}/pdf`, v.token)).body)).not.toContain('Solde dû');
    const sum = (await v.j.get(`/suppliers/${s}/summary`)).body; expect(sum.finance).toBeNull(); expect(sum.supplier.balanceMinor).toBeNull(); expect(sum.recent).toEqual({ documents: [], payments: [] }); expect(sum.allowedKinds).toEqual([]);
    expect((await v.j.get(`/suppliers/${s}/payments`)).status).toBe(403); expect((await v.j.get(`/suppliers/${s}/transactions?type=purchase_invoice`)).status).toBe(403);
    expect((await v.j.get(`/suppliers/${s}/statement?format=csv`)).status).toBe(403); expect((await v.j.get(`/suppliers/${s}/payments/export?format=csv`)).status).toBe(403);
    expect((await v.j.put(`/suppliers/${s}`, { name: 'Non' })).status).toBe(403); expect((await v.j.post(`/suppliers/${s}/status`, { status: 'blocked' })).status).toBe(403);
  });
  it('acheteur sans Trésorerie : situation visible, historique des règlements et activités de paiement masqués', async () => {
    const bank = await account(A); const supplier = (await mk()).id; const { invoice } = await buy(A, supplier);
    await A.j.post('/supplier-payments', { supplierId: supplier, treasuryAccountId: bank, method: 'cash', allocations: [{ purchaseInvoiceId: invoice.id, amountMinor: 1000 }] });
    const p = await user(A, 'acheteur@sa.test', ['suppliers:view', 'purchases:view']);
    const pay = (await p.j.get(`/suppliers/${supplier}/payments`)).body; expect(pay).toMatchObject({ canSeeHistory: false, items: [], total: 0 }); expect(pay.finance.paidMinor).toBe(1000);
    expect((await p.j.get(`/suppliers/${supplier}/summary`)).body.recent.payments).toEqual([]);
    expect((await p.j.get(`/suppliers/${supplier}/activities`)).body.items.map((a: { kind: string }) => a.kind)).not.toContain('payment_recorded');
    expect((await p.j.get(`/suppliers/${supplier}/transactions?type=import_file`)).status).toBe(403);
    expect((await p.j.post('/supplier-payments', { supplierId: supplier, treasuryAccountId: bank, method: 'cash', allocations: [{ purchaseInvoiceId: invoice.id, amountMinor: 1 }] })).status).toBe(403);
  });
  it('aucune route de la fiche n’est accessible depuis une autre société', async () => {
    for (const url of ['', '/summary', '/transactions', '/payments', '/documents', '/activities', '/pdf', '/statement?format=csv', '/payments/export?format=csv', '/transactions/export?format=csv']) expect((await B.j.get(`/suppliers/${s}${url}`)).status, url).toBe(404);
    expect((await B.j.post(`/suppliers/${s}/status`, { status: 'blocked' })).status).toBe(404);
    expect((await request(app).get(`/api/v1/suppliers/${s}/summary`)).status).toBe(401);
  });
});

describe('migration des fournisseurs (simulation, exécution, idempotence)', () => {
  it('catégories, codes, statuts, téléphones ; aucune catégorie attribuée ; données et documents inchangés', async () => {
    const company = new mongoose.Types.ObjectId();
    await col('companies').insertOne({ _id: company, name: 'Ancienne société' });
    await col('settings').insertOne({ companyId: company, baseCurrency: 'TND' });
    await col('suppliercategories').insertOne({ companyId: company, name: 'transporteur', isActive: true });
    await col('suppliers').insertMany([
      { companyId: company, name: 'Hérité 1', phone: '23108065', balanceMinor: 5000, blockThresholdMinor: 9000, address: { country: 'Tunisie' }, createdAt: new Date('2025-01-01') },
      { companyId: company, name: 'Hérité 2', code: 'FOU-00004', isArchived: true, phone: 'voir carnet', createdAt: new Date('2025-02-01') },
      { companyId: company, name: 'Hérité 3', isForeign: true, createdAt: new Date('2025-03-01') },
    ]);
    const orders = JSON.stringify(await col('purchaseorders').find().sort({ _id: 1 }).toArray());
    const state = async () => JSON.stringify([await col('suppliers').find({ companyId: company }).sort({ _id: 1 }).toArray(), await col('suppliercategories').find({ companyId: company }).sort({ _id: 1 }).toArray(), await col('settings').find({ companyId: company }).toArray()]);
    const s0 = await state();
    const dry = await migrateSuppliers({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, categoriesCreated: 6, codesAssigned: 2 }); expect(dry.foreignWithoutCurrency).toHaveLength(1); expect(await state()).toBe(s0);
    const real = await migrateSuppliers();
    expect(real).toMatchObject({ categoriesCreated: 6, codesAssigned: 2, phonesNormalized: 1 }); expect(real.phonesUnrecognized).toContainEqual(expect.objectContaining({ supplier: 'FOU-00004', value: 'voir carnet' }));
    const rows = await col('suppliers').find({ companyId: company }).sort({ createdAt: 1 }).toArray();
    expect(rows.map((r) => r.code)).toEqual(['FR-00005', 'FOU-00004', 'FR-00006']); // code historique conservé, suite sans collision
    expect(rows.map((r) => r.status)).toEqual(['active', 'archived', 'active']);
    expect(rows[0]).toMatchObject({ phone: '+21623108065', phoneOriginals: { phone: '23108065' }, balanceMinor: 5000, blockThresholdMinor: 9000, deliveryAddresses: [] }); expect(rows[1]!.phone).toBe('voir carnet');
    expect(rows.every((r) => r.categoryId === undefined)).toBe(true);
    expect((await SupplierCategory.find({ companyId: company }).lean()).map((c) => c.name)).toContain('transporteur'); expect(await SupplierCategory.countDocuments({ companyId: company })).toBe(7);
    expect((await Setting.findOne({ companyId: company }).lean())!.supplierCategoriesInitialisedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(await col('purchaseorders').find().sort({ _id: 1 }).toArray())).toBe(orders);
    const s1 = await state(); const again = await migrateSuppliers(); expect(again).toMatchObject({ categoriesCreated: 0, codesAssigned: 0, statusInitialised: 0, deliveryListsCreated: 0, phonesNormalized: 0 }); expect(await state()).toBe(s1);
  });
});
