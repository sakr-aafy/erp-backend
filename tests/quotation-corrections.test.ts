/**
 * Gestion des devis : cinq statuts et transitions, positions et identifiants des lignes, PDF (remise conditionnelle),
 * historique des activités (immuable, sans doublon), conversions, isolation, permissions et migration.
 */
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, api, line, plusDays, quoteBody, salesCompany, type Ctx } from './sales.helpers.js';
import { Quotation, QuotationActivity } from '../src/models/sales.model.js';
import { Product } from '../src/models/product.model.js';
import { setMailTransport } from '../src/services/mail.service.js';
import { expireOverdue } from '../src/modules/quotations/quotation.service.js';
import { migrateQuotations } from '../src/modules/quotations/quotation.migration.js';

let A: Ctx, B: Ctx;
beforeAll(async () => { await setupDb(); A = await salesCompany('Alpha', 'admin@qa.test'); B = await salesCompany('Beta', 'admin@qb.test'); });
afterAll(async () => { setMailTransport(null); await teardownDb(); });

const sent: { to: string; attachments: { filename: string; content: Buffer }[] }[] = [];
const smtp = (fail = false) => { const t = nodemailer.createTransport({ jsonTransport: true }); t.sendMail = (async (m: never) => { if (fail) throw new Error('ECONNREFUSED'); sent.push(m); return {}; }) as never; setMailTransport(t); };
const mk = async (lines: object[] = [line(A.products.a19, 1)], extra: object = {}, c: Ctx = A) => { const r = await c.j.post('/quotations', quoteBody(c, lines, extra)); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
type Act = { kind: string; title: string; user: string | null; system: boolean; oldValue: unknown; newValue: unknown; valueType: string | null; line: { reference: string; designation: string; position: number } | null; description: string | null; related: { type: string; id: string; number: string | null } | null; occurredAt: string; id: string };
const events = async (id: string, c: Ctx = A) => { const r = await c.j.get(`/quotations/${id}/activities?limit=100`); expect(r.status).toBe(200); return r.body.items as Act[]; };
const kinds = async (id: string) => (await events(id)).map((e) => e.kind).reverse();
/** Corps d'une modification à partir du devis enregistré (comme le formulaire). */
const edit = (q: { customerId: string; validUntil: string; lines: Record<string, unknown>[]; paymentTerms: string | null }, lines?: object[], extra: object = {}) => ({
  customerId: q.customerId, validUntil: q.validUntil.slice(0, 10), ...(q.paymentTerms !== null && { paymentTerms: q.paymentTerms }),
  lines: lines ?? q.lines.map((l) => asInput(l)), ...extra,
});
const asInput = (l: Record<string, unknown>, patch: object = {}) => ({ id: l['id'], productId: l['productId'], designation: l['designation'], quantity: l['quantity'], unitPriceMinor: l['unitPriceMinor'], discountPct: l['discountPct'], vatCode: (l['vat'] as { code: string }).code, ...patch });
const pdfOfQuote = async (id: string, c: Ctx = A) => { const r = await api().get(`/api/v1/quotations/${id}/pdf`).set('Authorization', `Bearer ${c.token}`).buffer().parse(binaryParser); expect(r.status).toBe(200); return r.body as Buffer; };
const columns = ['Pos.', 'Référence', 'Désignation', 'Qté', 'P.U. HT', 'Rem.%', 'TVA', 'Total HT'];

describe('statuts et transitions', () => {
  it('création « En attente » ; marquage manuel « Envoyé » avec date, utilisateur, mode et destinataire', async () => {
    const q = await mk(); expect(q).toMatchObject({ status: 'pending', statusLabel: 'En attente', editable: true, sentAt: null });
    expect((await A.j.post(`/quotations/${q.id}/mark-sent`, {})).status).toBe(422);
    expect((await A.j.post(`/quotations/${q.id}/mark-sent`, { method: 'email' })).status).toBe(422); // l’e-mail passe par un envoi réel
    const r = await A.j.post(`/quotations/${q.id}/mark-sent`, { method: 'hand', recipient: 'M. Salah', note: 'En agence' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ status: 'sent', statusLabel: 'Envoyé', sentMethod: 'hand', sentMethodLabel: 'Remise en main propre', sentTo: 'M. Salah', sentBy: 'Admin Alpha', editable: false });
    expect(r.body.sentAt).toBeTruthy();
    expect((await A.j.post(`/quotations/${q.id}/mark-sent`, { method: 'post' })).status).toBe(409);
    expect((await A.j.put(`/quotations/${q.id}`, edit(r.body))).status).toBe(409); // un devis envoyé ne se modifie plus silencieusement
    expect((await events(q.id))[0]).toMatchObject({ kind: 'marked_sent', user: 'Admin Alpha', oldValue: 'En attente', newValue: 'Envoyé' });
  });
  it('envoi par e-mail réussi → Envoyé ; échec SMTP ou SMTP absent → aucun changement, aucune activité', async () => {
    setMailTransport(null); const q = await mk();
    expect((await A.j.post(`/quotations/${q.id}/send`, {})).status).toBe(503);
    smtp(true); const fail = await A.j.post(`/quotations/${q.id}/send`, {}); expect(fail.status).toBe(502); expect(fail.body.error.code).toBe('MAIL_FAILED');
    expect((await A.j.get(`/quotations/${q.id}`)).body).toMatchObject({ status: 'pending', sentAt: null }); expect(await kinds(q.id)).toEqual(['created']);
    smtp(); const ok = await A.j.post(`/quotations/${q.id}/send`, { to: 'achats@client.tn' }); expect(ok.status).toBe(200);
    expect(sent.at(-1)!).toMatchObject({ to: 'achats@client.tn' }); expect(sent.at(-1)!.attachments[0]!.content.subarray(0, 4).toString()).toBe('%PDF');
    expect((await A.j.get(`/quotations/${q.id}`)).body).toMatchObject({ status: 'sent', sentMethod: 'email', sentTo: 'achats@client.tn', sentBy: 'Admin Alpha' });
    expect(await kinds(q.id)).toEqual(['created', 'email_sent']);
    await A.j.post(`/quotations/${q.id}/accept`); expect((await A.j.post(`/quotations/${q.id}/send`, {})).status).toBe(200);
    expect((await A.j.get(`/quotations/${q.id}`)).body.status).toBe('accepted'); // un renvoi ne change pas la décision
  });
  it('acceptation et refus depuis En attente ou Envoyé, avec commentaire / motif ; transitions incohérentes refusées', async () => {
    const a = await mk(); const ok = await A.j.post(`/quotations/${a.id}/accept`, { comment: 'Bon pour accord par téléphone' });
    expect(ok.body).toMatchObject({ status: 'accepted', acceptedBy: 'Admin Alpha', acceptanceNote: 'Bon pour accord par téléphone', editable: false });
    const b = await mk(); await A.j.post(`/quotations/${b.id}/mark-sent`, { method: 'post' });
    const ko = await A.j.post(`/quotations/${b.id}/refuse`, { reason: 'Prix trop élevé' }); expect(ko.body).toMatchObject({ status: 'refused', refusalReason: 'Prix trop élevé', refusedBy: 'Admin Alpha' });
    expect((await A.j.post(`/quotations/${(await mk()).id}/refuse`)).body.status).toBe('refused'); // motif facultatif
    for (const q of [a, b]) for (const [action, body] of [['accept', {}], ['refuse', {}], ['mark-sent', { method: 'hand' }]] as const) {
      const r = await A.j.post(`/quotations/${q.id}/${action}`, body); expect(r.status, `${q.number} ${action}`).toBe(409); expect(r.body.error.message).toMatch(/Transition impossible/);
    }
    expect((await A.j.put(`/quotations/${a.id}`, edit(ok.body))).status).toBe(409);
    for (const q of [a, b]) expect((await A.j.del(`/quotations/${q.id}`)).status).toBe(409); // conservés avec leur historique
    expect(await kinds(b.id)).toEqual(['created', 'marked_sent', 'refused']);
    expect((await A.j.post(`/quotations/${b.id}/convert-invoice`)).status).toBe(409);
  });
  it('expiration automatique persistée (en attente et envoyé), jamais pour accepté ou refusé, historisée une seule fois', async () => {
    const [p, s, a, r] = [await mk(), await mk(), await mk(), await mk()];
    await A.j.post(`/quotations/${s.id}/mark-sent`, { method: 'phone' }); await A.j.post(`/quotations/${a.id}/accept`); await A.j.post(`/quotations/${r.id}/refuse`);
    await Quotation.updateMany({ _id: { $in: [p.id, s.id, a.id, r.id] } }, { validUntil: new Date(plusDays(-1)), issueDate: new Date(plusDays(-10)) });
    await Promise.all([expireOverdue(), expireOverdue(), expireOverdue()]); await expireOverdue();
    const status = async (id: string) => (await Quotation.findById(id).lean())!.status;
    expect([await status(p.id), await status(s.id), await status(a.id), await status(r.id)]).toEqual(['expired', 'expired', 'accepted', 'refused']);
    for (const id of [p.id, s.id]) { const e = (await events(id)).filter((x) => x.kind === 'expired'); expect(e).toHaveLength(1); expect(e[0]).toMatchObject({ system: true, user: 'Système', newValue: 'Expiré' }); }
    expect((await events(a.id)).some((e) => e.kind === 'expired')).toBe(false);
    for (const action of ['accept', 'refuse']) expect((await A.j.post(`/quotations/${p.id}/${action}`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${p.id}/convert-proforma`, {})).status).toBe(409);
  });
  it('rapport, fiche client et fiche article reflètent l’expiration sans attendre le contrôle horaire', async () => {
    const overdue = async () => { const q = await mk(); await Quotation.updateOne({ _id: q.id }, { validUntil: new Date(plusDays(-1)), issueDate: new Date(plusDays(-10)) }); return q; };
    const statusInDb = async (id: string) => (await Quotation.findById(id).lean())!.status;
    for (const url of ['/reports/quotations', `/customers/${A.customerId}/transactions?type=quotation`, `/products/${A.products.a19}/transactions?type=quotation`]) {
      const q = await overdue(); expect((await A.j.get(url)).status, url).toBe(200); expect(await statusInDb(q.id), url).toBe('expired');
    }
  });
  it('filtre par statut, compteurs réels, tri et recherche', async () => {
    const stats = (await A.j.get('/quotations/stats')).body;
    for (const st of ['pending', 'sent', 'accepted', 'refused', 'expired']) {
      const l = (await A.j.get(`/quotations?status=${st}&limit=100`)).body; expect(l.total, st).toBe(stats[st]); expect(l.items.every((q: { status: string }) => q.status === st)).toBe(true);
    }
    expect(stats.total).toBe(stats.pending + stats.sent + stats.accepted + stats.refused + stats.expired);
    for (const sort of ['totalTtcMinor', '-totalHtMinor', 'customer', 'validUntil', '-number']) expect((await A.j.get(`/quotations?sort=${sort}`)).status, sort).toBe(200);
    const one = (await A.j.get('/quotations?limit=1')).body.items[0]; expect((await A.j.get(`/quotations?q=${one.number}`)).body.total).toBe(1);
    expect((await A.j.get(`/quotations?from=${plusDays(1)}`)).body.total).toBe(0);
    const rep = (await A.j.get(`/reports/quotations`)).body; expect(rep.rows.map((x: { statusKey: string }) => x.statusKey)).toEqual(['pending', 'sent', 'accepted', 'refused', 'expired']);
  });
});

describe('lignes : positions, références, calculs', () => {
  it('positions 10, 20, 30, 40 ; exemples du document (180, 150, 4 940) ; multi-taux', async () => {
    const q = await mk([line(A.products.a19, 1, { unitPriceMinor: 200_000, discountPct: 10 }), line(A.products.c7, 1, { unitPriceMinor: 150_000 }), line(A.products.c7, 1, { unitPriceMinor: 5_200_000, discountPct: 5 }), line(A.products.b13, 3, { unitPriceMinor: 5_600_000 })]);
    expect(q.lines.map((l: { position: number }) => l.position)).toEqual([10, 20, 30, 40]);
    expect(q.lines.map((l: { netHtMinor: number }) => l.netHtMinor)).toEqual([180_000, 150_000, 4_940_000, 16_800_000]);
    expect(q.totals.totalHtMinor).toBe(22_070_000);
    expect(q.totals.vatGroups.map((g: { ratePct: number; vatMinor: number }) => [g.ratePct, g.vatMinor])).toEqual([[19, 34_200], [7, 356_300], [13, 2_184_000]]);
    expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 0)]))).status).toBe(422); // quantité nulle toujours refusée
    expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1, { discountPct: 101 })]))).status).toBe(422);
  });
  it('identifiants stables : réorganisation, suppression, ajout ; positions recalculées ; référence historique conservée', async () => {
    const q = await mk([line(A.products.a19, 1), line(A.products.b13, 2), line(A.products.c7, 3)]);
    const [l1, l2, l3] = q.lines;
    await Product.updateOne({ _id: A.products.a19 }, { reference: 'A19-NOUVEAU' });
    const r = await A.j.put(`/quotations/${q.id}`, edit(q, [asInput(l3), asInput(l1, { designation: 'Désignation adaptée' }), { productId: A.products.b13, quantity: 1 }]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lines.map((l: { position: number }) => l.position)).toEqual([10, 20, 30]);
    expect(r.body.lines[0].id).toBe(l3.id); expect(r.body.lines[1].id).toBe(l1.id); expect([l1.id, l2.id, l3.id]).not.toContain(r.body.lines[2].id);
    expect(r.body.lines[1]).toMatchObject({ reference: 'A19', designation: 'Désignation adaptée' });
    expect((await Product.findById(A.products.a19).lean())!.name).toBe('Article A19'); // le référentiel n'est pas modifié
    await Product.updateOne({ _id: A.products.a19 }, { reference: 'A19' });
    // sans identifiant (API) : la ligne est reconnue par l'article et la désignation
    const again = await A.j.put(`/quotations/${q.id}`, edit(r.body, r.body.lines.map((l: Record<string, unknown>) => asInput(l, { id: undefined }))));
    expect(again.body.lines.map((l: { id: string }) => l.id)).toEqual(r.body.lines.map((l: { id: string }) => l.id));
  });
});

describe('historique des activités', () => {
  it('chaque changement réel, avec anciennes et nouvelles valeurs ; aucun événement sans changement', async () => {
    const q = await mk([line(A.products.a19, 1, { unitPriceMinor: 200_000 }), line(A.products.b13, 1, { unitPriceMinor: 50_000 })], { paymentTerms: 'Comptant' });
    expect(await kinds(q.id)).toEqual(['created']);
    expect((await A.j.put(`/quotations/${q.id}`, edit(q))).status).toBe(200); expect(await kinds(q.id)).toEqual(['created']); // rien n'a changé
    const [l1] = q.lines;
    const r = await A.j.put(`/quotations/${q.id}`, edit(q, [asInput(l1, { unitPriceMinor: 185_000, discountPct: 5, quantity: 2 }), { productId: A.products.c7, quantity: 1 }], { paymentTerms: '60 jours', validUntil: plusDays(45), globalDiscountPct: 2, notes: 'Livraison incluse' }));
    expect(r.status).toBe(200);
    const list = await events(q.id); const of = (k: string) => list.find((e) => e.kind === k)!;
    expect(list.map((e) => e.kind).sort()).toEqual(['created', 'discount_changed', 'global_discount_changed', 'line_added', 'line_removed', 'notes_changed', 'payment_terms_changed', 'price_changed', 'quantity_changed', 'validity_changed']);
    expect(of('price_changed')).toMatchObject({ oldValue: 200_000, newValue: 185_000, valueType: 'money', user: 'Admin Alpha', line: { reference: 'A19', position: 10 } });
    expect(of('discount_changed')).toMatchObject({ oldValue: 0, newValue: 5, valueType: 'percent' });
    expect(of('payment_terms_changed')).toMatchObject({ oldValue: 'Comptant', newValue: '60 jours' });
    expect(of('line_added').line).toMatchObject({ reference: 'C7' }); expect(of('line_removed').line).toMatchObject({ reference: 'B13' });
    expect((await events(q.id)).length).toBe(list.length); // persistance sans doublon
    const filtered = (await A.j.get(`/quotations/${q.id}/activities?kind=price_changed`)).body; expect(filtered.total).toBe(1); expect(filtered.kinds.map((k: { value: string }) => k.value)).toContain('created');
    const page = (await A.j.get(`/quotations/${q.id}/activities?limit=3&page=2`)).body; expect(page.items).toHaveLength(3); expect(page.total).toBe(list.length);
    const d = await A.j.put(`/quotations/${q.id}`, edit(r.body, [asInput(r.body.lines[1]), asInput(r.body.lines[0])], { paymentTerms: '60 jours', globalDiscountPct: 2, notes: 'Livraison incluse' }));
    expect(d.status).toBe(200); expect((await events(q.id))[0]!.kind).toBe('lines_reordered');
  });
  it('échec : aucune activité ; l’historique ne se modifie ni ne se supprime', async () => {
    const q = await mk(); const before = await kinds(q.id);
    expect((await A.j.put(`/quotations/${q.id}`, edit(q, [asInput(q.lines[0], { vatCode: 'INCONNU' })]))).status).toBeGreaterThanOrEqual(400);
    expect(await kinds(q.id)).toEqual(before);
    const n = await QuotationActivity.countDocuments();
    expect((await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 1)], { customerId: B.customerId }))).status).toBe(400); expect(await QuotationActivity.countDocuments()).toBe(n);
    const id = (await events(q.id))[0]!.id;
    expect((await A.j.put(`/quotations/${q.id}/activities/${id}`, { title: 'x' })).status).toBe(404); expect((await A.j.del(`/quotations/${q.id}/activities/${id}`)).status).toBe(404);
    await expect(QuotationActivity.updateOne({ _id: id }, { title: 'Falsifié' })).rejects.toThrow(/ne se modifie/);
    await expect(QuotationActivity.deleteOne({ _id: id })).rejects.toThrow(/ne se modifie/);
  });
  it('duplication et conversions : événements, documents liés, double conversion refusée, facture brouillon supprimée', async () => {
    const q = await mk(); await A.j.post(`/quotations/${q.id}/mark-sent`, { method: 'hand' });
    const copy = (await A.j.post(`/quotations/${q.id}/duplicate`)).body; expect(copy).toMatchObject({ status: 'pending', duplicatedFromId: q.id }); expect(copy.lines[0].id).not.toBe(q.lines[0].id);
    expect((await events(q.id))[0]).toMatchObject({ kind: 'duplicated', related: { type: 'quotation', id: copy.id, number: copy.number } });
    expect((await events(copy.id))[0]).toMatchObject({ kind: 'created', related: { id: q.id, number: q.number } });
    const inv = await A.j.post(`/quotations/${q.id}/convert-invoice`); expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(await kinds(q.id)).toEqual(['created', 'marked_sent', 'duplicated', 'accepted', 'converted_invoice']);
    expect((await events(q.id))[0]!.related).toMatchObject({ type: 'invoice', id: inv.body.invoiceId });
    expect((await A.j.post(`/quotations/${q.id}/convert-invoice`)).status).toBe(409); expect((await A.j.post(`/quotations/${q.id}/convert-proforma`, {})).status).toBe(409);
    expect((await A.j.del(`/invoices/${inv.body.invoiceId}`)).status).toBe(204);
    expect((await events(q.id))[0]!.kind).toBe('invoice_unlinked'); expect((await A.j.get(`/quotations/${q.id}`)).body).toMatchObject({ status: 'accepted', invoiceId: null });
    const pf = await A.j.post(`/quotations/${copy.id}/convert-proforma`, {}); expect(pf.status).toBe(201);
    expect((await events(copy.id))[0]).toMatchObject({ kind: 'converted_proforma', related: { type: 'proforma', number: pf.body.number } });
    expect(await kinds(copy.id)).toEqual(['created', 'accepted', 'converted_proforma']);
  });
  it('isolation multi-société et permissions', async () => {
    const q = await mk();
    expect((await B.j.get(`/quotations/${q.id}/activities`)).status).toBe(404);
    for (const [u, b] of [['mark-sent', { method: 'hand' }], ['accept', {}], ['refuse', {}], ['duplicate', {}]] as const) expect((await B.j.post(`/quotations/${q.id}/${u}`, b)).status, u).toBe(404);
    await makeUser(A.companyId, 'lecteur@qa.test', ['quotations:view']); const v = J((await login('lecteur@qa.test')).token);
    expect((await v.get(`/quotations/${q.id}/activities`)).status).toBe(200);
    for (const [u, b] of [['mark-sent', { method: 'hand' }], ['accept', {}], ['refuse', {}], ['send', {}], ['duplicate', {}], ['convert-invoice', {}]] as const) expect((await v.post(`/quotations/${q.id}/${u}`, b)).status, u).toBe(403);
    expect((await v.put(`/quotations/${q.id}`, edit(q))).status).toBe(403);
    await makeUser(A.companyId, 'sans@qa.test', ['customers:view']); expect((await J((await login('sans@qa.test')).token).get(`/quotations/${q.id}/activities`)).status).toBe(403);
  });
});

describe('PDF : affichage conditionnel de la remise', () => {
  const header = (txt: string) => { const t = txt.split('\n'); const i = t.indexOf('Pos.'); return t.slice(i, i + 8); };
  it('cas A — aucune remise : colonne entièrement absente', async () => {
    const q = await mk([line(A.products.a19, 1), line(A.products.b13, 2)]); const txt = pdfText(await pdfOfQuote(q.id));
    expect(header(txt).slice(0, 7)).toEqual(columns.filter((c) => c !== 'Rem.%')); expect(txt).not.toContain('Rem.'); expect(txt).not.toContain('0 %\n');
    expect(txt.split('\n')).toEqual(expect.arrayContaining(['10', '20', 'A19', 'B13', 'DEVIS']));
  });
  it('cas B — toutes les lignes remisées', async () => {
    const q = await mk([line(A.products.a19, 1, { discountPct: 10 }), line(A.products.b13, 1, { discountPct: 7.5 })]); const txt = pdfText(await pdfOfQuote(q.id)).split('\n');
    expect(header(txt.join('\n'))).toEqual(columns); expect(txt).toContain('10 %'); expect(txt).toContain('7,5 %'); expect(txt).not.toContain('\x97');
  });
  it('cas C — mélange : pourcentages réels et tiret cadratin, jamais 0 %', async () => {
    const q = await mk([line(A.products.a19, 1, { unitPriceMinor: 200_000, discountPct: 10 }), line(A.products.c7, 1, { unitPriceMinor: 150_000 }), line(A.products.b13, 1, { unitPriceMinor: 5_200_000, discountPct: 5 })]);
    const txt = pdfText(await pdfOfQuote(q.id)).split('\n'); expect(header(txt.join('\n'))).toEqual(columns);
    const row = (ref: string) => { const i = txt.indexOf(ref); return txt.slice(i, i + 7); };
    expect(row('A19')[4]).toBe('10 %'); expect(row('C7')[4]).toBe('\x97'); expect(row('B13')[4]).toBe('5 %'); expect(txt).not.toContain('0 %');
    for (const amount of ['180,000', '150,000', '4\xa0940,000']) expect(txt.some((t) => t.replace(/\u00a0/g, '\xa0') === amount), amount).toBe(true);
  });
  it('remise globale ou en montant seule : récapitulatif uniquement, pas de colonne ; totaux identiques au serveur', async () => {
    for (const extra of [{ globalDiscountPct: 10 }, { globalDiscountMinor: 5_000 }]) {
      const q = await mk([line(A.products.a19, 2)], extra); const txt = pdfText(await pdfOfQuote(q.id)).split('\n');
      expect(txt).not.toContain('Rem.%'); expect(txt).toContain('Remises');
      const ttc = (q.totals.totalTtcMinor / 1000).toFixed(3).replace('.', ','); expect(txt.map((t) => t.replace(/\s/g, ''))).toContain(ttc.replace(/\s/g, ''));
    }
  });
  it('multipage et désignations longues : en-têtes répétés, pages numérotées, aucune ligne perdue', async () => {
    const long = 'Machine-outil à commande numérique avec table élargie, lubrification centralisée, capotage intégral et armoire électrique ventilée';
    const q = await mk(Array.from({ length: 60 }, (_, i) => line(A.products.a19, 1, { designation: `${long} n° ${i + 1}`, ...(i % 7 === 0 && { discountPct: 3 }) })), { terms: 'Garantie 12 mois.', notes: 'Offre soumise à nos conditions générales.' });
    const pdf = await pdfOfQuote(q.id); const txt = pdfText(pdf); const lines = txt.split('\n');
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length; expect(pages).toBeGreaterThan(2);
    expect(lines.filter((t) => t === 'Désignation').length).toBeGreaterThanOrEqual(pages - 1); expect(txt).toContain('(suite)'); expect(txt).toContain(`page ${pages} / ${pages}`);
    expect(lines).toContain('600'); expect(txt).toContain('Total TTC'); expect(txt).toContain('Garantie 12 mois.');
  });
});

describe('migration des devis (simulation, exécution, idempotence)', () => {
  it('positions et statut « envoyé » ; montants, dates et liens inchangés ; aucun historique inventé', async () => {
    const company = new mongoose.Types.ObjectId(); const raw = mongoose.connection.db!.collection('quotations');
    const common = { companyId: company, customerId: new mongoose.Types.ObjectId(), issueDate: new Date('2025-01-10'), validUntil: new Date('2025-02-10'), totals: { totalHtMinor: 123, totalTtcMinor: 146 } };
    await raw.insertMany([
      { ...common, number: 'DEV-OLD-1', status: 'pending', sentAt: new Date('2025-01-11'), lines: [{ designation: 'a', quantity: 1 }, { designation: 'b', quantity: 2 }] },
      { ...common, number: 'DEV-OLD-2', status: 'accepted', sentAt: new Date('2025-01-11'), invoiceId: new mongoose.Types.ObjectId(), lines: [{ designation: 'c', quantity: 1 }] },
      { ...common, number: 'DEV-OLD-3', status: 'pending', lines: [{ designation: 'd', quantity: 1, position: 10 }] },
    ]);
    const state = async () => JSON.stringify(await raw.find({ companyId: company }).sort({ number: 1 }).toArray());
    const s0 = await state(); const activities = await QuotationActivity.countDocuments();
    const dry = await migrateQuotations({ dryRun: true }); expect(dry.positionsInitialised).toBe(2); expect(dry.markedSent).toBe(1); expect(await state()).toBe(s0);
    const real = await migrateQuotations(); expect(real).toMatchObject({ positionsInitialised: 2, markedSent: 1 });
    const rows = await raw.find({ companyId: company }).sort({ number: 1 }).toArray();
    expect(rows.map((r) => r.status)).toEqual(['sent', 'accepted', 'pending']); expect(rows[0]!.lines.map((l: { position: number }) => l.position)).toEqual([10, 20]);
    expect(rows[0]).toMatchObject({ sentMethod: 'email', totals: { totalHtMinor: 123, totalTtcMinor: 146 } }); expect(rows[1]!.invoiceId).toBeTruthy();
    expect(await QuotationActivity.countDocuments()).toBe(activities);
    const s1 = await state(); expect(await migrateQuotations()).toMatchObject({ positionsInitialised: 0, markedSent: 0 }); expect(await state()).toBe(s1);
  });
});
