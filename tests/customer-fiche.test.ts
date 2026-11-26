import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { authed, binaryParser, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { J, line, plusDays, quoteBody, salesCompany, type Ctx } from './sales.helpers.js';
import { Customer, CustomerActivity, CustomerDocument } from '../src/models/customer.model.js';
import { Counter } from '../src/models/counter.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { migrateCustomers } from '../src/modules/customers/customer.migration.js';

let A: Ctx, B: Ctx;
const api = () => request(app);
import { app } from './helpers.js';

const invBody = (customerId: string, lines: object[]) => ({ customerId, lines });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const upload = (token: string, id: string, file: Buffer, name: string, type = 'contract', description?: string) => {
  const r = api().post(`/api/v1/customers/${id}/documents`).set(authed(token)).field('type', type).attach('file', file, name);
  return description ? r.field('description', description) : r;
};

beforeAll(async () => { await setupDb(); A = await salesCompany('Alpha', 'admin@a.test'); B = await salesCompany('Beta', 'admin@b.test'); });
afterAll(async () => { await teardownDb(); });

describe('fiche client — création, code, validation', () => {
  it('Société : code CL-00001 automatique, champs de la fiche enregistrés et normalisés', async () => {
    const r = await A.j.post('/customers', {
      type: 'company', name: 'Société Exemple SARL', tradeName: 'Exemple', taxId: ' 1234567/a ',
      address: { street: '12 rue de la Liberté', city: 'Tunis', postalCode: '1000', country: 'Tunisie' }, phone: '+216 71 000 000', secondaryPhone: '+216 98 000 000', email: 'contact@exemple.tn',
      website: 'https://exemple.tn', social: { facebook: 'https://facebook.com/exemple', linkedin: 'https://linkedin.com/company/exemple', instagram: 'https://instagram.com/exemple' }, mapsUrl: 'https://maps.google.com/?q=tunis',
      creditLimitMinor: 5_000_000, paymentTerms: '30 jours', paymentDelayDays: 30, paymentMethod: 'transfer', discountPct: 7.5, subjectToWithholding: true, stampExempt: false });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'CL-00002', type: 'company', name: 'Société Exemple SARL', tradeName: 'Exemple', taxId: '1234567/A', status: 'active', statusLabel: 'Actif',
      paymentMethod: 'transfer', discountPct: 7.5, creditLimitMinor: 5_000_000, subjectToWithholding: true, deliveryAddresses: [], canSell: true, isArchived: false });
    expect(r.body.social.linkedin).toBe('https://linkedin.com/company/exemple'); expect(r.body.mapsUrl).toContain('maps.google.com');
    expect(r.body).not.toHaveProperty('registryNumber'); expect(r.body).not.toHaveProperty('sector');
  });

  it('Passager : sans matricule fiscal ni coordonnées complètes', async () => {
    const r = await A.j.post('/customers', { type: 'walk_in', name: 'Client de passage' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ type: 'walk_in', taxId: null, code: 'CL-00003' });
  });

  it('codes uniques et sans trou sous concurrence (20 créations simultanées)', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => A.j.post('/customers', { name: `Concurrent ${i}` })));
    expect(rs.every((x) => x.status === 201)).toBe(true);
    const codes = rs.map((x) => x.body.code as string);
    expect(new Set(codes).size).toBe(20);
    const nums = codes.map((c) => Number(c.slice(3))).sort((a, b) => a - b);
    expect(nums[0]).toBe(4); expect(nums[19]).toBe(23); // continu : aucune valeur sautée
  });

  it('un échec de création (matricule fiscal en double) ne consomme pas de code', async () => {
    const before = (await Counter.findOne({ companyId: A.companyId, key: 'customer' }))!.seq;
    const dup = await A.j.post('/customers', { name: 'Doublon', taxId: '1234567/A' });
    expect(dup.status).toBe(409); expect(dup.body.error.message).toMatch(/matricule fiscal/i);
    expect((await Counter.findOne({ companyId: A.companyId, key: 'customer' }))!.seq).toBe(before);
  });

  it('la numérotation est propre à chaque société', async () => {
    expect((await B.j.post('/customers', { name: 'Premier client Beta' })).body.code).toBe('CL-00002'); // Beta a déjà « Client Test » (CL-00001)
  });

  it('validations serveur : e-mail, téléphone, URL, remise, plafond, champs inconnus (code, statut, solde, companyId)', async () => {
    for (const bad of [{ email: 'pas-un-email' }, { phone: 'abc' }, { website: 'javascript:alert(1)' }, { mapsUrl: 'ftp://x' }, { social: { facebook: 'pas une url' } }, { discountPct: 101 }, { discountPct: -1 }, { discountPct: 10.123 },
      { creditLimitMinor: -1 }, { creditLimitMinor: 1.5 }, { paymentMethod: 'bitcoin' }, { type: 'autre' }, { code: 'CL-99999' }, { status: 'blocked' }, { balanceMinor: 5 }, { companyId: B.companyId.toString() }]) {
      const r = await A.j.post('/customers', { name: 'Valide', ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await A.j.post('/customers', { name: 'Remise limite', discountPct: 100, creditLimitMinor: 0 })).status).toBe(201);
  });

  it('le code client ne peut pas être modifié', async () => {
    const c = (await A.j.get('/customers?q=Passage')).body.items[0];
    expect((await A.j.put(`/customers/${c.id}`, { code: 'CL-77777' })).status).toBe(422);
    expect((await A.j.put(`/customers/${c.id}`, { name: 'Client de passage 2' })).body.code).toBe('CL-00003');
  });
});

describe('fiche client — liste, filtres, tri, export', () => {
  it('recherche par code, nom commercial, téléphone ; filtres type / ville / statut ; tri', async () => {
    expect((await A.j.get('/customers?q=CL-00002')).body.items.map((c: { name: string }) => c.name)).toEqual(['Société Exemple SARL']);
    expect((await A.j.get('/customers?q=Exemple')).body.total).toBe(1); // nom commercial / raison sociale
    expect((await A.j.get('/customers?q=98 000')).body.total).toBe(1); // téléphone secondaire
    expect((await A.j.get('/customers?type=walk_in')).body.items.map((c: { code: string }) => c.code)).toEqual(['CL-00003']);
    expect((await A.j.get('/customers?city=tunis&type=company')).body.items).toHaveLength(1);
    expect((await A.j.get('/customers?city=tunis')).body.items.every((c: { address: { city: string } }) => c.address.city === 'Tunis')).toBe(true);
    const byCode = (await A.j.get('/customers?sort=-code&limit=3')).body.items.map((c: { code: string }) => c.code);
    expect(byCode).toEqual([...byCode].sort().reverse());
    expect((await A.j.get('/customers/cities')).body).toContain('Tunis');
    expect((await B.j.get('/customers/cities')).body).not.toContain('Tunis'); // villes d'une autre société invisibles
  });

  it('export Excel : colonnes demandées, filtres respectés, journalisé', async () => {
    const x = await api().get('/api/v1/customers/export?format=xlsx&type=walk_in').set(authed(A.token)).buffer().parse(binaryParser);
    const rows = await parseXlsx(x.body as Buffer);
    expect(rows[0]).toEqual(['Code', 'Raison sociale / Nom', 'Type', 'Matricule fiscal', 'Contact principal', 'Téléphone', 'E-mail', 'Ville', 'Conditions de paiement', 'Limite de crédit', 'Solde', 'Statut']);
    expect(rows).toHaveLength(2); expect(rows[1]![2]).toBe('Passager');
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'customer', action: 'export' })).toBeGreaterThan(0);
  });
});

describe('fiche client — contacts, adresses', () => {
  let id = '';
  it('plusieurs contacts, un seul contact principal à tout instant', async () => {
    id = (await A.j.get('/customers?q=CL-00002')).body.items[0].id;
    const k1 = await A.j.post(`/customers/${id}/contacts`, { name: 'Ali Ben Salah', role: 'Directeur', phone: '+216 71 111 111', email: 'ali@exemple.tn' });
    expect(k1.status).toBe(201); expect(k1.body.contacts).toHaveLength(1); expect(k1.body.contacts[0].isPrimary).toBe(true); // le premier devient principal
    const k2 = await A.j.post(`/customers/${id}/contacts`, { name: 'Sami Trabelsi', role: 'Acheteur', isPrimary: true });
    expect(k2.body.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary).map((c: { name: string }) => c.name)).toEqual(['Sami Trabelsi']);
    const ali = k2.body.contacts.find((c: { name: string }) => c.name === 'Ali Ben Salah');
    const k3 = await A.j.post(`/customers/${id}/contacts/${ali._id}/primary`);
    expect(k3.body.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary).map((c: { name: string }) => c.name)).toEqual(['Ali Ben Salah']);
    expect(k3.body.primaryContact.name).toBe('Ali Ben Salah');
  });
  it('modification, retrait du principal (reporté sur un autre), suppression', async () => {
    const cs = (await A.j.get(`/customers/${id}`)).body.contacts as { _id: string; name: string; isPrimary: boolean }[];
    const ali = cs.find((c) => c.name === 'Ali Ben Salah')!;
    const upd = await A.j.put(`/customers/${id}/contacts/${ali._id}`, { role: 'Directeur général' });
    expect(upd.body.contacts.find((c: { _id: string }) => c._id === ali._id).role).toBe('Directeur général');
    const del = await A.j.del(`/customers/${id}/contacts/${ali._id}`); // supprime le principal
    expect(del.status).toBe(200); expect(del.body.contacts).toHaveLength(1); expect(del.body.contacts[0].isPrimary).toBe(true);
    expect((await A.j.put(`/customers/${id}/contacts/${ali._id}`, { role: 'x' })).status).toBe(404);
    expect((await A.j.post(`/customers/${id}/contacts`, {})).status).toBe(422);
    expect((await A.j.post(`/customers/${id}/contacts`, { name: 'Contact', email: 'pas-un-email' })).status).toBe(422);
  });
  it('un nouveau document commercial copie l’adresse de livraison par défaut ; la modification du référentiel ne le réécrit pas', async () => {
    const added = await A.j.post(`/customers/${id}/delivery-addresses`, { label: 'Dépôt', street: 'Route de la plage', city: 'Sousse', country: 'Tunisie' });
    expect(added.status).toBe(201); const adr = added.body.deliveryAddresses[0].id as string;
    const q = await A.j.post('/quotations', quoteBody({ ...A, customerId: id } as Ctx, [line(A.products.a19)]));
    expect(q.status).toBe(201);
    const stored = await mongoose.connection.db!.collection('quotations').findOne({ _id: new mongoose.Types.ObjectId(q.body.id) });
    expect(stored!.deliveryAddress.city).toBe('Sousse'); expect(stored!.customerSnapshot.code).toBe('CL-00002');
    await A.j.put(`/customers/${id}/delivery-addresses/${adr}`, { city: 'Gabès' });
    const again = await mongoose.connection.db!.collection('quotations').findOne({ _id: new mongoose.Types.ObjectId(q.body.id) });
    expect(again!.deliveryAddress.city).toBe('Sousse'); // l'historique n'est jamais réécrit
  });
});

describe('fiche client — statuts et conséquences commerciales', () => {
  let c = '';
  it('Actif ↔ Inactif ↔ Bloqué ; Archivé ne revient qu’à Actif ; mêmes statuts refusés ; trace dans la chronologie', async () => {
    c = (await A.j.post('/customers', { name: 'Statuts' })).body.id;
    const s = (status: string, reason?: string) => A.j.post(`/customers/${c}/status`, { status, ...(reason && { reason }) });
    expect((await s('active')).status).toBe(409);
    expect((await s('blocked', 'Impayés')).body).toMatchObject({ status: 'blocked', statusReason: 'Impayés', canSell: false, isArchived: false });
    expect((await s('inactive')).body.status).toBe('inactive');
    expect((await s('archived')).body).toMatchObject({ status: 'archived', isArchived: true });
    expect((await s('blocked')).status).toBe(409); // archivé → seulement actif
    expect((await s('inactive')).status).toBe(409);
    expect((await s('active')).body).toMatchObject({ status: 'active', isArchived: false, statusReason: null });
    expect((await s('nimporte')).status).toBe(422);
    const acts = (await A.j.get(`/customers/${c}/activities?kind=status_changed&limit=50`)).body.items;
    expect(acts.length).toBe(4); expect(acts.every((a: { auto: boolean; editable: boolean }) => a.auto && !a.editable)).toBe(true);
  });
  it('un client bloqué / inactif / archivé ne peut recevoir ni devis, ni facture, ni BL ; actif : oui', async () => {
    const tryDoc = () => A.j.post('/quotations', quoteBody({ ...A, customerId: c } as Ctx, [line(A.products.a19)]));
    expect((await tryDoc()).status).toBe(201);
    const draft = await A.j.post('/invoices', invBody(c, [line(A.products.a19)])); expect(draft.status).toBe(201);
    for (const st of ['blocked', 'inactive', 'archived'] as const) {
      await A.j.post(`/customers/${c}/status`, { status: st });
      const r = await tryDoc(); expect(r.status, st).toBe(409); expect(r.body.error.message).toMatch(/impossible/);
      const v = await A.j.post(`/invoices/${draft.body.id}/validate`); // validation = nouvelle vente
      expect(v.status, st).toBe(409); expect(['CUSTOMER_BLOCKED', 'CUSTOMER_INACTIVE', 'CUSTOMER_ARCHIVED']).toContain(v.body.error.code);
      if (st !== 'archived') await A.j.post(`/customers/${c}/status`, { status: 'active' });
    }
    await A.j.post(`/customers/${c}/status`, { status: 'active' });
    expect((await A.j.post(`/invoices/${draft.body.id}/validate`)).status).toBe(200);
  });
  it('un client bloqué reste modifiable et peut payer ses factures ; un client archivé n’est plus modifiable', async () => {
    const inv = (await A.j.get(`/customers/${c}/transactions?type=invoice`)).body.items[0];
    await A.j.post(`/customers/${c}/status`, { status: 'blocked' });
    expect((await A.j.put(`/customers/${c}`, { notes: 'Suivi renforcé' })).status).toBe(200);
    expect((await A.j.post(`/invoices/${inv.id}/payments`, { amountMinor: 10_000, method: 'cash' })).status).toBe(201); // encaisser est toujours possible
    await A.j.post(`/customers/${c}/status`, { status: 'archived' });
    expect((await A.j.put(`/customers/${c}`, { notes: 'x' })).status).toBe(409);
    await A.j.post(`/customers/${c}/status`, { status: 'active' });
  });
  it('les routes archive / reactivate historiques restent compatibles', async () => {
    const id = (await A.j.post('/customers', { name: 'Compat' })).body.id;
    expect((await A.j.post(`/customers/${id}/archive`)).body.status).toBe('archived');
    expect((await A.j.post(`/customers/${id}/reactivate`)).body.status).toBe('active');
  });
  it('suppression refusée avec un solde non nul ou des documents ; autorisée sinon (documents et activités nettoyés)', async () => {
    expect((await A.j.del(`/customers/${c}`)).status).toBe(409);
    const free = (await A.j.post('/customers', { name: 'À supprimer' })).body.id;
    await upload(A.token, free, PDF, 'rc.pdf', 'registry_extract');
    expect((await A.j.del(`/customers/${free}`)).status).toBe(204);
    expect(await CustomerDocument.countDocuments({ customerId: free })).toBe(0); expect(await CustomerActivity.countDocuments({ customerId: free })).toBe(0);
  });
});

describe('fiche client — transactions, indicateurs, paiements (chiffres exacts)', () => {
  let cust = ''; let inv1 = ''; let inv2 = ''; let cn = '';
  it('prépare : 2 factures validées (TTC 119 000 et 59 500), 1 paiement partiel, 1 avoir partiel, 1 devis, 1 BL', async () => {
    cust = (await A.j.post('/customers', { name: 'Client Chiffres', creditLimitMinor: 1_000_000 })).body.id;
    const mk = async (lines: object[]) => { const d = await A.j.post('/invoices', invBody(cust, lines)); const v = await A.j.post(`/invoices/${d.body.id}/validate`); expect(v.status).toBe(200); return v.body; };
    const i1 = await mk([line(A.products.a19, 1)]); // 100 000 HT → TTC 119 000 (TVA 19 %)
    const i2 = await mk([line(A.products.b13, 1)]); // 50 000 HT → 56 500 (TVA 13 %)
    inv1 = i1.id; inv2 = i2.id;
    expect(i1.totals.totalTtcMinor).toBe(119_000); expect(i2.totals.totalTtcMinor).toBe(56_500);
    expect((await A.j.post(`/invoices/${inv1}/payments`, { amountMinor: 50_000, method: 'transfer', reference: 'V1' })).status).toBe(201);
    const c = await A.j.post(`/invoices/${inv2}/credit-note`, { reason: 'Retour', lines: [{ sourceLineId: i2.lines[0].id, quantity: 1 }] });
    cn = (await A.j.post(`/invoices/${c.body.id}/validate`)).body.id; // avoir total de la 2e facture : 56 500
    await A.j.post('/quotations', quoteBody({ ...A, customerId: cust } as Ctx, [line(A.products.c7, 2)]));
    const d = await A.j.post('/delivery-notes', { customerId: cust, lines: [line(A.products.svc, 1)] }); expect(d.status).toBe(201);
  });
  it('indicateurs du résumé : CA net (factures − avoirs), impayés, dernière vente, crédit disponible', async () => {
    const s = (await A.j.get(`/customers/${cust}/summary`)).body;
    expect(s.finance).toMatchObject({ revenueHtMinor: 100_000, revenueTtcMinor: 119_000, billedMinor: 175_500, creditNotesMinor: 56_500, paidMinor: 50_000, invoiceCount: 2 });
    expect(s.finance.balanceMinor).toBe(175_500 - 56_500 - 50_000); // 69 000
    expect(s.finance.consistent).toBe(true);
    expect(s.finance.unpaidMinor).toBe(69_000); // facture 1 : 119 000 − 50 000 ; facture 2 : 56 500 − avoir 56 500
    expect(s.finance.unpaidCount).toBe(1);
    expect(s.finance.availableCreditMinor).toBe(1_000_000 - 69_000);
    expect(new Date(s.finance.lastSaleDate).toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(s.recent.documents.length).toBeGreaterThanOrEqual(5); expect(s.recent.payments).toHaveLength(1);
    expect(s.recent.documents[0]).toHaveProperty('pdfPath');
  });
  it('transactions : tous les types, filtres type / statut / période / référence, pagination, liens PDF', async () => {
    const all = (await A.j.get(`/customers/${cust}/transactions?limit=50`)).body;
    expect(all.total).toBe(5); expect(new Set(all.items.map((r: { kind: string }) => r.kind))).toEqual(new Set(['quotation', 'invoice', 'credit_note', 'delivery_note']));
    expect((await A.j.get(`/customers/${cust}/transactions?type=invoice`)).body.total).toBe(2);
    expect((await A.j.get(`/customers/${cust}/transactions?type=credit_note`)).body.items[0].id).toBe(cn);
    expect((await A.j.get(`/customers/${cust}/transactions?type=invoice&status=partial`)).body.total).toBe(1);
    expect((await A.j.get(`/customers/${cust}/transactions?type=quotation&status=pending`)).body.total).toBe(1);
    expect((await A.j.get(`/customers/${cust}/transactions?status=pending`)).body.items.every((r: { kind: string }) => ['quotation', 'proforma'].includes(r.kind))).toBe(true);
    const n1 = (await A.j.get(`/invoices/${inv1}`)).body.number as string;
    const q = (await A.j.get(`/customers/${cust}/transactions?q=${n1}`)).body; expect(q.items.map((r: { id: string }) => r.id)).toEqual([inv1]);
    const page2 = (await A.j.get(`/customers/${cust}/transactions?limit=4&page=2`)).body; expect(page2.items).toHaveLength(1); expect(page2.total).toBe(5);
    const future = (await A.j.get(`/customers/${cust}/transactions?from=${plusDays(5)}`)).body; expect(future.total).toBe(0);
    const pdf = await api().get(`/api/v1${all.items.find((r: { kind: string }) => r.kind === 'invoice').pdfPath}`).set(authed(A.token)).buffer().parse(binaryParser);
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect((await A.j.get(`/customers/${cust}/transactions?type=nimporte`)).status).toBe(422);
  });
  it('paiements : situation financière, historique, factures impayées, échéances, relevé', async () => {
    const p = (await A.j.get(`/customers/${cust}/payments`)).body;
    expect(p.finance).toMatchObject({ billedMinor: 175_500, creditNotesMinor: 56_500, paidMinor: 50_000, balanceMinor: 69_000 });
    expect(p.items).toHaveLength(1); expect(p.items[0]).toMatchObject({ amountMinor: 50_000, method: 'transfer', reference: 'V1', status: 'active' });
    expect(p.unpaidInvoices).toHaveLength(1); expect(p.unpaidInvoices[0]).toMatchObject({ id: inv1, remainingMinor: 69_000, paymentStatus: 'partial' });
    expect(p.unpaidInvoices[0].nextDueDate).toBeTruthy();
    // paiement via le service d'encaissement existant ; le solde suit
    expect((await A.j.post(`/invoices/${inv1}/payments`, { amountMinor: 69_000, method: 'cash' })).status).toBe(201);
    const after = (await A.j.get(`/customers/${cust}/payments`)).body;
    expect(after.finance).toMatchObject({ paidMinor: 119_000, balanceMinor: 0, unpaidMinor: 0, excessMinor: 0, consistent: true }); expect(after.unpaidInvoices).toHaveLength(0);
    expect((await A.j.get(`/customers/${cust}/balance-check`)).body.consistent).toBe(true);
    const st = (await A.j.get(`/customers/${cust}/statement?format=csv`));
    expect(st.status).toBe(200); expect(st.headers['content-type']).toMatch(/csv/); expect(st.text).toContain('Reste dû');
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'customer-statement' })).toBe(1);
  });
  it('le solde n’est modifiable qu’à travers les opérations : refus direct, annulation d’un paiement le rétablit', async () => {
    expect((await A.j.put(`/customers/${cust}`, { balanceMinor: 0 })).status).toBe(422);
    const pay = (await A.j.get(`/customers/${cust}/payments`)).body.items[0];
    expect((await A.j.post(`/invoices/payments/${pay.id}/cancel`, { reason: 'Erreur de saisie' })).status).toBe(200);
    expect((await A.j.get(`/customers/${cust}/payments`)).body.finance).toMatchObject({ balanceMinor: 69_000, paidMinor: 50_000, consistent: true });
  });
});

describe('fiche client — documents', () => {
  let id = ''; let docId = '';
  it('ajout (PDF, PNG), liste avec taille / auteur / type, métadonnées modifiables', async () => {
    id = (await A.j.post('/customers', { name: 'Avec documents' })).body.id;
    const r = await upload(A.token, id, PDF, 'Extrait RC 2026.pdf', 'registry_extract', 'Extrait officiel');
    expect(r.status).toBe(201); docId = r.body.id;
    expect(r.body).toMatchObject({ type: 'registry_extract', typeLabel: 'Extrait du registre de commerce', name: 'Extrait RC 2026.pdf', description: 'Extrait officiel', mime: 'application/pdf', size: PDF.length });
    expect(r.body.uploadedBy).toBeTruthy();
    expect((await upload(A.token, id, PNG, 'carte.png', 'tax_card')).status).toBe(201);
    const list = (await A.j.get(`/customers/${id}/documents`)).body; expect(list).toHaveLength(2);
    const u = await A.j.put(`/customers/${id}/documents/${docId}`, { type: 'contract', description: 'Contrat cadre' }); expect(u.body).toMatchObject({ type: 'contract', description: 'Contrat cadre' });
    expect((await A.j.put(`/customers/${id}/documents/${docId}`, { type: 'virus' })).status).toBe(422);
  });
  it('téléchargement (en-têtes sûrs) et consultation en ligne ; contenu identique', async () => {
    const dl = await api().get(`/api/v1/customers/${id}/documents/${docId}/file`).set(authed(A.token)).buffer().parse(binaryParser);
    expect(dl.status).toBe(200); expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="Extrait RC 2026\.pdf"/); expect(dl.headers['x-content-type-options']).toBe('nosniff'); expect(dl.headers['content-security-policy']).toContain('sandbox');
    const view = await api().get(`/api/v1/customers/${id}/documents/${docId}/file?disposition=inline`).set(authed(A.token)).buffer().parse(binaryParser);
    expect(view.headers['content-disposition']).toMatch(/^inline/);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, action: 'document-download' })).toBe(2);
  });
  it('sécurité : extensions dangereuses, faux contenus, fichier vide, trop gros, sans jeton', async () => {
    for (const [buf, name] of [[Buffer.from('MZ\x90\x00'), 'setup.exe'], [PDF, 'contrat.pdf.exe'], [Buffer.from('<?php echo 1;'), 'a.php'], [Buffer.from('<svg onload=alert(1)>'), 'a.svg'], [Buffer.from('<html></html>'), 'a.html'], [PDF, 'noext']] as [Buffer, string][]) {
      const r = await upload(A.token, id, buf, name); expect(r.status, name).toBe(400);
    }
    expect((await upload(A.token, id, Buffer.from('ceci n’est pas un pdf'), 'faux.pdf')).status).toBe(400); // extension pdf, contenu texte
    expect((await upload(A.token, id, PNG, 'image.pdf')).status).toBe(400); // contenu PNG sous extension PDF
    expect((await upload(A.token, id, Buffer.alloc(0), 'vide.pdf')).status).toBe(400);
    const big = await upload(A.token, id, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'gros.pdf'); expect(big.status).toBe(413);
    expect((await api().post(`/api/v1/customers/${id}/documents`).field('type', 'other').attach('file', PDF, 'x.pdf')).status).toBe(401);
    expect((await api().post(`/api/v1/customers/${id}/documents`).set(authed(A.token)).field('type', 'other')).status).toBe(400); // fichier manquant
    expect((await api().post(`/api/v1/customers/${id}/documents`).set(authed(A.token)).field('type', 'nimporte').attach('file', PDF, 'x.pdf')).status).toBe(422);
    expect(await CustomerDocument.countDocuments({ customerId: id })).toBe(2); // aucun refus n'a laissé de document
  });
  it('isolation : une autre société ne voit, ne télécharge, ne modifie ni ne supprime rien', async () => {
    const bid = (await B.j.get('/customers')).body.items[0].id;
    for (const r of [await B.j.get(`/customers/${id}/documents`), await B.j.put(`/customers/${id}/documents/${docId}`, { description: 'x' }), await B.j.del(`/customers/${id}/documents/${docId}`),
      await api().get(`/api/v1/customers/${id}/documents/${docId}/file`).set(authed(B.token)), await upload(B.token, id, PDF, 'x.pdf')]) expect(r.status).toBe(404);
    // un document de A ne se lit pas non plus en passant par un client de B
    expect((await api().get(`/api/v1/customers/${bid}/documents/${docId}/file`).set(authed(B.token))).status).toBe(404);
  });
  it('suppression : fichier et métadonnées retirés, trace dans la chronologie', async () => {
    expect((await A.j.del(`/customers/${id}/documents/${docId}`)).status).toBe(204);
    expect((await A.j.get(`/customers/${id}/documents`)).body).toHaveLength(1);
    expect((await api().get(`/api/v1/customers/${id}/documents/${docId}/file`).set(authed(A.token))).status).toBe(404);
    const files = await mongoose.connection.db!.collection('customerFiles.files').countDocuments({ 'metadata.customerId': new mongoose.Types.ObjectId(id) });
    expect(files).toBe(1); // le fichier supprimé a disparu de GridFS
    const kinds = (await A.j.get(`/customers/${id}/activities?limit=50`)).body.items.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['document_added', 'document_removed']));
  });
});

describe('fiche client — activités', () => {
  let id = ''; let manual = '';
  it('activités manuelles : ajout, modification, suppression ; événements automatiques non modifiables', async () => {
    id = (await A.j.post('/customers', { name: 'Activités' })).body.id;
    const a = await A.j.post(`/customers/${id}/activities`, { kind: 'call', title: 'Appel de suivi', description: 'Discussion commerciale', occurredAt: '2026-11-15T10:00:00Z' });
    expect(a.status).toBe(201); manual = a.body.id; expect(a.body).toMatchObject({ kind: 'call', kindLabel: 'Appel téléphonique', auto: false, editable: true, user: expect.any(String) });
    expect((await A.j.put(`/customers/${id}/activities/${manual}`, { title: 'Appel avec le directeur' })).body.title).toBe('Appel avec le directeur');
    const items = (await A.j.get(`/customers/${id}/activities`)).body.items as { id: string; auto: boolean; kind: string; occurredAt: string }[];
    const created = items.find((x) => x.kind === 'customer_created')!;
    expect(created.auto).toBe(true);
    expect((await A.j.put(`/customers/${id}/activities/${created.id}`, { title: 'xx' })).status).toBe(409);
    expect((await A.j.del(`/customers/${id}/activities/${created.id}`)).status).toBe(409);
    expect((await A.j.post(`/customers/${id}/activities`, { kind: 'customer_created', title: 'Faux événement' })).status).toBe(422);
    expect((await A.j.post(`/customers/${id}/activities`, { kind: 'call', title: 'x' })).status).toBe(422);
    expect(items.map((x) => x.occurredAt)).toEqual([...items.map((x) => x.occurredAt)].sort().reverse()); // ordre chronologique inverse
  });
  it('événements issus des documents réels : devis créé, facture validée, paiement — jamais dupliqués', async () => {
    const q = await A.j.post('/quotations', quoteBody({ ...A, customerId: id } as Ctx, [line(A.products.a19)]));
    const d = await A.j.post('/invoices', invBody(id, [line(A.products.a19)])); const v = await A.j.post(`/invoices/${d.body.id}/validate`);
    await A.j.post(`/invoices/${v.body.id}/payments`, { amountMinor: 1_000, method: 'cash' });
    const first = (await A.j.get(`/customers/${id}/activities?limit=100`)).body;
    const kinds = first.items.map((a: { kind: string }) => a.kind);
    for (const k of ['quotation_created', 'invoice_validated', 'payment_recorded', 'customer_created', 'call']) expect(kinds, k).toContain(k);
    const again = (await A.j.get(`/customers/${id}/activities?limit=100`)).body; // relecture : mêmes événements, pas de doublon
    expect(again.items.map((a: { id: string }) => a.id)).toEqual(first.items.map((a: { id: string }) => a.id)); expect(again.total).toBe(first.total);
    expect(first.items.find((a: { kind: string }) => a.kind === 'quotation_created').ref.id).toBe(q.body.id);
    expect((await A.j.del(`/customers/${id}/activities/${manual}`)).status).toBe(204);
  });
  it('les activités commerciales sont distinctes du journal d’audit', async () => {
    const audit = await AuditLog.countDocuments({ companyId: A.companyId, resource: 'customer-activity' });
    expect(audit).toBe(0); // aucune activité n'est écrite dans l'audit : deux journaux, deux usages
  });
});

describe('fiche client — permissions par onglet et isolation', () => {
  it('chaque onglet exige la permission de son module source ; la fiche seule ne donne pas accès aux montants', async () => {
    await makeUser(A.companyId, 'lecteur@a.test', ['customers:view']);
    await makeUser(A.companyId, 'facture@a.test', ['customers:view', 'invoices:view']);
    await makeUser(A.companyId, 'compta@a.test', ['customers:view', 'invoices:view', 'accounting:view', 'treasury:view']);
    await makeUser(A.companyId, 'ecriture@a.test', ['customers:view', 'customers:update']);
    const id = (await A.j.get('/customers?q=Chiffres')).body.items[0].id as string;
    const R = J((await login('lecteur@a.test')).token), F = J((await login('facture@a.test')).token), C = J((await login('compta@a.test')).token), W = J((await login('ecriture@a.test')).token);
    // lecteur : fiche et résumé sans finance ni opérations
    const s = (await R.get(`/customers/${id}/summary`)).body; expect(s.finance).toBeNull(); expect(s.recent.documents).toEqual([]); expect(s.recent.payments).toEqual([]); expect(s.allowedKinds).toEqual([]);
    expect((await R.get(`/customers/${id}/payments`)).status).toBe(403);
    expect((await R.get(`/customers/${id}/statement`)).status).toBe(403);
    expect((await R.get(`/customers/${id}/transactions`)).body.total).toBe(0); expect((await R.get(`/customers/${id}/transactions?type=invoice`)).status).toBe(403);
    expect((await R.get(`/customers/${id}/balance-check`)).status).toBe(403);
    // facturation : factures / avoirs / paiements mais ni devis ni BL ; pas de compte de trésorerie ; pas de relevé
    const ft = (await F.get(`/customers/${id}/transactions?limit=50`)).body; expect(new Set(ft.items.map((r: { kind: string }) => r.kind))).toEqual(new Set(['invoice', 'credit_note']));
    expect((await F.get(`/customers/${id}/transactions?type=quotation`)).status).toBe(403);
    const fp = (await F.get(`/customers/${id}/payments`)).body; expect(fp.canSeeAccounts).toBe(false); expect(fp.items.every((p: { account: unknown }) => p.account === null)).toBe(true);
    expect((await F.get(`/customers/${id}/statement`)).status).toBe(403);
    expect((await C.get(`/customers/${id}/payments`)).body.canSeeAccounts).toBe(true);
    expect((await C.get(`/customers/${id}/statement?format=xlsx`)).status).toBe(200);
    // activités : événements financiers masqués sans la permission du module
    const ra = (await R.get(`/customers/${id}/activities?limit=100`)).body.items.map((a: { kind: string }) => a.kind); expect(ra).not.toContain('invoice_validated'); expect(ra).not.toContain('payment_recorded'); expect(ra).not.toContain('quotation_created');
    // écriture : contacts / documents / activités / statut exigent customers:update
    expect((await R.post(`/customers/${id}/contacts`, { name: 'Intrus' })).status).toBe(403);
    expect((await R.post(`/customers/${id}/status`, { status: 'blocked' })).status).toBe(403);
    expect((await R.post(`/customers/${id}/activities`, { kind: 'note', title: 'Note interdite' })).status).toBe(403);
    expect((await upload((await login('lecteur@a.test')).token, id, PDF, 'x.pdf')).status).toBe(403);
    expect((await W.post(`/customers/${id}/activities`, { kind: 'note', title: 'Note autorisée' })).status).toBe(201);
    expect((await W.post(`/customers/${id}`, {})).status).toBe(404); // aucune route de création via cet identifiant
    expect((await W.del(`/customers/${id}`)).status).toBe(403); // suppression : customers:delete
  });
  it('isolation multi-société sur tous les onglets', async () => {
    const id = (await A.j.get('/customers?q=Chiffres')).body.items[0].id as string;
    for (const path of ['', '/summary', '/transactions', '/payments', '/statement?format=csv', '/documents', '/activities', '/balance-check', '/pdf']) {
      expect((await B.j.get(`/customers/${id}${path}`)).status, path).toBe(404);
    }
    expect((await B.j.post(`/customers/${id}/contacts`, { name: 'x' })).status).toBe(404);
    expect((await B.j.post(`/customers/${id}/activities`, { kind: 'note', title: 'Intrusion' })).status).toBe(404);
    expect((await B.j.post(`/customers/${id}/status`, { status: 'blocked' })).status).toBe(404);
    expect((await B.j.put(`/customers/${id}`, { notes: 'x' })).status).toBe(404);
    expect((await B.j.get('/customers/pas-un-id/summary')).status).toBe(422);
  });
  it('fiche PDF : contient tous les champs de la fiche ; journalisée', async () => {
    const id = (await A.j.get('/customers?q=CL-00002')).body.items[0].id as string;
    const r = await api().get(`/api/v1/customers/${id}/pdf`).set(authed(A.token)).buffer().parse(binaryParser);
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/pdf/); expect(r.headers['content-disposition']).toContain('CL-00002');
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(await AuditLog.countDocuments({ companyId: A.companyId, resource: 'customer', action: 'print' })).toBeGreaterThan(0);
  });
});

describe('migration des anciens clients', () => {
  it('codes attribués dans l’ordre de création, statuts dérivés, données conservées ; idempotente ; simulation sans écriture', async () => {
    const col = mongoose.connection.db!.collection('customers');
    const company = new mongoose.Types.ObjectId();
    const t = (d: number) => new Date(Date.UTC(2026, 0, d));
    // Clients « anciens » : insérés tels qu'avant la fiche détaillée (ni code, ni statut, ni type)
    const old = await col.insertMany([
      { companyId: company, name: 'Ancien 3', taxId: 'ANC3', phone: '+21670000003', isArchived: false, balanceMinor: 500, contacts: [], createdAt: t(3), updatedAt: t(3), __v: 0 },
      { companyId: company, name: 'Ancien 1', taxId: 'ANC1', address: { city: 'Sfax' }, isArchived: true, archivedAt: t(9), balanceMinor: 0, contacts: [], createdAt: t(1), updatedAt: t(1), __v: 0 },
      { companyId: company, name: 'Ancien 2', isArchived: false, balanceMinor: 0, contacts: [{ _id: new mongoose.Types.ObjectId(), name: 'Contact', isPrimary: true }], createdAt: t(2), updatedAt: t(2), __v: 0 },
    ]);
    const ids = Object.values(old.insertedIds);
    const dry = await migrateCustomers({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, coded: 3 });
    expect((await col.findOne({ _id: ids[0] }))!.code).toBeUndefined(); // simulation : aucune écriture
    const r = await migrateCustomers();
    expect(r).toMatchObject({ coded: 3, statusSet: 3, activitiesCreated: 3, dryRun: false });
    const byName = async (name: string) => (await col.findOne({ companyId: company, name }))!;
    expect((await byName('Ancien 1')).code).toBe('CL-00001'); expect((await byName('Ancien 2')).code).toBe('CL-00002'); expect((await byName('Ancien 3')).code).toBe('CL-00003');
    expect((await byName('Ancien 1'))).toMatchObject({ status: 'archived', isArchived: true, type: 'company', shippingSameAsBilling: true, discountPct: 0, taxId: 'ANC1' });
    expect((await byName('Ancien 3'))).toMatchObject({ status: 'active', phone: '+21670000003', balanceMinor: 500 });
    expect((await byName('Ancien 2')).contacts).toHaveLength(1);
    expect((await col.findOne({ _id: ids[0] }))!._id.toString()).toBe(ids[0]!.toString()); // identifiants conservés
    // idempotence : aucune modification, aucun doublon d'activité
    const before = JSON.stringify(await col.find({ companyId: company }).sort({ _id: 1 }).toArray());
    const again = await migrateCustomers();
    expect(again).toMatchObject({ coded: 0, statusSet: 0, defaulted: 0, activitiesCreated: 0 });
    expect(JSON.stringify(await col.find({ companyId: company }).sort({ _id: 1 }).toArray())).toBe(before);
    expect(await CustomerActivity.countDocuments({ companyId: company })).toBe(3);
    // un nouveau client créé ensuite continue la numérotation sans trou
    const next = await Customer.create({ companyId: company, name: 'Nouveau' }); expect(next.code).toBeUndefined();
    expect((await migrateCustomers()).coded).toBe(1); expect((await Customer.findById(next._id).lean())!.code).toBe('CL-00004');
    // les clients migrés (archivé) se retrouvent par les filtres de la liste
    expect(await Customer.countDocuments({ companyId: company, status: 'archived' })).toBe(1);
  });
});
