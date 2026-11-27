import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, line, plusDays, quoteBody, salesCompany, api, type Ctx, acceptQuote, refuseQuote, sendQuote } from './sales.helpers.js';
import { Counter } from '../src/models/counter.model.js';
import { Customer } from '../src/models/customer.model.js';
import { FiscalRule } from '../src/models/fiscal-rule.model.js';
import { Invoice, Quotation } from '../src/models/sales.model.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { setMailTransport } from '../src/services/mail.service.js';

let A: Ctx, B: Ctx;
const Y = new Date().getUTCFullYear();
const balance = async (ctx: Ctx, id = ctx.customerId) => (await Customer.findById(id))!.balanceMinor;
const q1 = (ctx: Ctx, qty = 1) => ctx.j.post('/quotations', quoteBody(ctx, [line(ctx.products.a19, qty)]));
const draftInvoice = async (ctx: Ctx, lines = [line(ctx.products.a19, 1)], extra: object = {}) => (await ctx.j.post('/invoices', { customerId: ctx.customerId, lines, ...extra })).body;
const validated = async (ctx: Ctx, lines = [line(ctx.products.a19, 1)], extra: object = {}) => { const d = await draftInvoice(ctx, lines, extra); const r = await ctx.j.post(`/invoices/${d.id}/validate`); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };

beforeAll(async () => { await setupDb(); A = await salesCompany('Alpha', 'admin@a.test'); B = await salesCompany('Beta', 'admin@b.test'); });
afterAll(async () => { setMailTransport(null); await teardownDb(); });

describe('devis', () => {
  it('numérotation DEV-AAAA-000001 séquentielle, calculs HT/TVA/TTC côté serveur', async () => {
    const r = await q1(A, 2);
    expect(r.status).toBe(201); expect(r.body.number).toBe(`DEV-${Y}-000001`); expect(r.body.status).toBe('draft');
    expect(r.body.totals).toMatchObject({ totalHtMinor: 200_000, totalVatMinor: 38_000, totalTtcMinor: 238_000 });
    expect(r.body.lines[0]).toMatchObject({ reference: 'A19', unit: 'PC', vat: { code: 'T19', ratePct: 19, regime: 'taxable' } });
    expect((await q1(A)).body.number).toBe(`DEV-${Y}-000002`);
    expect((await q1(B)).body.number).toBe(`DEV-${Y}-000001`); // série propre à chaque société
  });
  it('numérotation sans doublon ni trou sous appels concurrents', async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, () => q1(A)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => Number(r.body.number.split('-')[2])).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(15); expect(nums).toEqual(Array.from({ length: 15 }, (_, i) => i + 3)); // 3..17 contigus
    expect((await Counter.findOne({ companyId: A.companyId, key: `quotation:${Y}` }))!.seq).toBe(17);
  });
  it('un échec de création n’en consomme pas le numéro (pas de trou)', async () => {
    const before = (await Counter.findOne({ companyId: A.companyId, key: `quotation:${Y}` }))!.seq;
    expect((await A.j.post('/quotations', quoteBody(A, [{ designation: 'x', quantity: 1, unitPriceMinor: 1, vatCode: 'INCONNU' }]))).status).toBe(400);
    expect((await Counter.findOne({ companyId: A.companyId, key: `quotation:${Y}` }))!.seq).toBe(before);
  });
  it('valide les entrées : validité, client d’une autre société/archivé, article inconnu/désactivé, lignes vides', async () => {
    const bad = async (b: object, status: number) => expect((await A.j.post('/quotations', b as never)).status, JSON.stringify(b)).toBe(status);
    await bad(quoteBody(A, [line(A.products.a19)], { validUntil: '2000-01-01' }), 422);
    await bad(quoteBody(A, []), 422);
    await bad({ ...quoteBody(A, [line(A.products.a19)]), customerId: B.customerId }, 400);
    await bad(quoteBody(A, [line(B.products.a19)]), 400);
    await bad(quoteBody(A, [line(A.products.a19, 0)]), 422);
    await bad(quoteBody(A, [line(A.products.a19, 1, { discountPct: 120 })]), 422);
    await bad(quoteBody(A, [line(A.products.a19, 1.2345)]), 422);
    await bad({ ...quoteBody(A, [line(A.products.a19)]), number: 'DEV-FAKE' }, 422); // numéro non imposable par le client
  });
  it('statuts : brouillon modifiable ; accepter / refuser un devis envoyé seulement', async () => {
    const q = (await q1(A)).body; expect(q.status).toBe('draft');
    expect((await A.j.put(`/quotations/${q.id}`, quoteBody(A, [line(A.products.a19, 3)]))).body.totals.totalHtMinor).toBe(300_000);
    expect((await A.j.post(`/quotations/${q.id}/accept`)).status).toBe(409); // jamais envoyé
    expect((await acceptQuote(A.j, q.id)).body.status).toBe('accepted');
    expect((await A.j.post(`/quotations/${q.id}/refuse`)).status).toBe(409);
    expect((await A.j.put(`/quotations/${q.id}`, quoteBody(A, [line(A.products.a19, 1)]))).status).toBe(409);
    const r = (await q1(A)).body; expect((await refuseQuote(A.j, r.id)).body.status).toBe('refused');
    expect((await A.j.post(`/quotations/${r.id}/convert-proforma`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${r.id}/accept`)).status).toBe(409);
  });
  it('expiration automatique d’un devis envoyé après la date de validité (persistée)', async () => {
    const q = (await q1(A)).body; await sendQuote(A.j, q.id);
    await Quotation.updateOne({ _id: q.id }, { validUntil: new Date(Date.now() - 3 * 86400000) });
    expect((await A.j.get(`/quotations/${q.id}`)).body.status).toBe('expired');
    expect((await Quotation.findById(q.id))!.status).toBe('expired'); // écrit en base, pas seulement affiché
    expect((await A.j.post(`/quotations/${q.id}/accept`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(409);
    expect((await A.j.get('/quotations?status=expired')).body.items.map((x: { id: string }) => x.id)).toContain(q.id);
  });
  it('duplication : nouveau numéro, brouillon version 1, lignes et remises copiées', async () => {
    const src = (await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 2, { discountPct: 10 })], { globalDiscountMinor: 5_000 }))).body;
    await refuseQuote(A.j, src.id);
    const d = await A.j.post(`/quotations/${src.id}/duplicate`);
    expect(d.status).toBe(201); expect(d.body.number).not.toBe(src.number); expect(d.body).toMatchObject({ status: 'draft', version: 1, duplicatedFromId: src.id });
    expect(d.body.totals.totalHtMinor).toBe(src.totals.totalHtMinor); expect(d.body.globalDiscountMinor).toBe(5_000);
  });
  it('conversion : devis accepté uniquement, vers une proforma (série PRO distincte) ; double conversion refusée', async () => {
    const q = (await q1(A, 2)).body;
    expect((await A.j.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(409);
    await acceptQuote(A.j, q.id);
    const c = await A.j.post(`/quotations/${q.id}/convert-proforma`);
    expect(c.status).toBe(201); expect(c.body).toMatchObject({ quotationVersion: 1 }); expect(c.body.number).toMatch(new RegExp(`^PRO-${Y}-\\d{6}$`));
    const after = (await A.j.get(`/quotations/${q.id}`)).body;
    expect(after).toMatchObject({ status: 'accepted', proformaId: c.body.proformaId, editable: false });
    expect((await A.j.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(409);
    expect((await A.j.post(`/quotations/${q.id}/convert-invoice`)).status).toBe(410); // conversion supprimée
    const p = (await A.j.get(`/proformas/${c.body.proformaId}`)).body;
    expect(p).toMatchObject({ status: 'pending', quotationId: q.id, quotationVersion: 1 }); expect(p.totals.totalTtcMinor).toBe(238_000);
  });
  it('suppression : brouillon jamais envoyé seulement', async () => {
    const q = (await q1(A)).body; expect((await A.j.del(`/quotations/${q.id}`)).status).toBe(204);
    const a = (await q1(A)).body; await sendQuote(A.j, a.id); expect((await A.j.del(`/quotations/${a.id}`)).status).toBe(409);
  });
  it('statistiques : compteurs par statut et taux de transformation', async () => {
    const s = (await A.j.get('/quotations/stats')).body;
    expect(s.total).toBeGreaterThan(5); expect(s.draft).toBeGreaterThan(0); expect(s.converted).toBe(1);
    const q = (await q1(A)).body; await acceptQuote(A.j, q.id); await A.j.post(`/quotations/${q.id}/convert-proforma`);
    expect((await A.j.get('/quotations/stats')).body.converted).toBe(2);
  });
  it('PDF et envoi par e-mail (SMTP simulé) ; 503 sans SMTP', async () => {
    const q = (await q1(A)).body;
    const pdf = await api().get(`/api/v1/quotations/${q.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    expect(pdf.status).toBe(200); expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await A.j.post(`/quotations/${q.id}/send`)).status).toBe(503);
    const sent: { to: string; attachments: { filename: string }[] }[] = []; const t = nodemailer.createTransport({ jsonTransport: true });
    t.sendMail = (async (m: never) => { sent.push(m); return {}; }) as never; setMailTransport(t);
    const r = await A.j.post(`/quotations/${q.id}/send`, {}); expect(r.status).toBe(200); expect(r.body.to).toBe('client@test.tn');
    expect(sent[0]!.attachments[0]!.filename).toBe(`${q.number}.pdf`); expect((await Quotation.findById(q.id))!.sentAt).toBeTruthy();
    setMailTransport(null);
  });
});

describe('factures proforma', () => {
  it('création manuelle, mention « PROFORMA » sur le PDF, numérotation distincte des factures', async () => {
    const p = await A.j.post('/proformas', quoteBody(A, [line(A.products.a19), line(A.products.b13)]));
    expect(p.status).toBe(201); expect(p.body.number).toMatch(new RegExp(`^PRO-${Y}-`)); expect(p.body.totals.totalTtcMinor).toBe(119_000 + 56_500);
    const pdf = await api().get(`/api/v1/proformas/${p.body.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    const txt = pdfText(pdf.body as Buffer);
    expect(txt).toContain('FACTURE PROFORMA'); expect(txt.split('\n')).toContain('PROFORMA'); // mention obligatoire sur le document édité
    expect(txt).toContain(p.body.number);
  });
  it('aucune conversion directe en facture : la proforma se livre, puis le BL se facture', async () => {
    const p = (await A.j.post('/proformas', quoteBody(A, [line(A.products.a19, 2)]))).body;
    const c = await A.j.post(`/proformas/${p.id}/convert-invoice`); expect(c.status).toBe(410); expect(c.body.error.code).toBe('CONVERSION_REMOVED');
    expect((await A.j.get(`/proformas/${p.id}`)).body).toMatchObject({ status: 'pending', invoiceId: null, editable: true, deliveryState: 'none', billingState: 'none' });
    const bl = (await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 2 }] })).body;
    expect((await A.j.get(`/proformas/${p.id}`)).body.editable).toBe(false); // un BL en préparation fige la proforma
    expect((await A.j.put(`/proformas/${p.id}`, quoteBody(A, [line(A.products.a19)]))).status).toBe(409);
    expect((await A.j.del(`/proformas/${p.id}`)).status).toBe(409);
    expect((await A.j.del(`/delivery-notes/${bl.id}`)).status).toBe(204);
    expect((await A.j.get(`/proformas/${p.id}`)).body.editable).toBe(true);
  });
  it('annulation, expiration, statistiques', async () => {
    const p = (await A.j.post('/proformas', quoteBody(A, [line(A.products.a19)]))).body;
    expect((await A.j.post(`/proformas/${p.id}/cancel`)).status).toBe(422); // motif obligatoire
    expect((await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Commande annulée' })).body).toMatchObject({ status: 'cancelled', cancelReason: 'Commande annulée' });
    const refused = await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1 }] }); expect(refused.status).toBe(409);
    const e = (await A.j.post('/proformas', quoteBody(A, [line(A.products.a19)]))).body;
    const { Proforma } = await import('../src/models/sales.model.js'); await Proforma.updateOne({ _id: e.id }, { validUntil: new Date(Date.now() - 2 * 86400000) });
    expect((await A.j.get(`/proformas/${e.id}`)).body.status).toBe('expired'); expect((await A.j.post('/delivery-notes', { source: { type: 'proforma', id: e.id }, lines: [{ sourceLineId: e.lines[0].id, quantity: 1 }] })).status).toBe(409);
    const s = (await A.j.get('/proformas/stats')).body; expect(s.cancelled).toBe(1); expect(s.expired).toBe(1); expect(s.converted).toBe(0);
  });
});

describe('factures de vente : validation et immuabilité', () => {
  it('brouillon sans numéro ; validation : numéro légal FAC-AAAA-000001, totaux recalculés, solde client mis à jour', async () => {
    const d = await draftInvoice(A, [line(A.products.a19, 2), line(A.products.c7, 5)]);
    expect(d).toMatchObject({ status: 'draft', number: null, editable: true }); expect(await balance(A)).toBe(0); // brouillon : aucun effet sur le solde
    expect((await A.j.put(`/invoices/${d.id}`, { customerId: A.customerId, lines: [line(A.products.a19, 1)] })).body.totals.totalHtMinor).toBe(100_000);
    const v = await A.j.post(`/invoices/${d.id}/validate`);
    expect(v.status).toBe(200); expect(v.body).toMatchObject({ status: 'validated', number: `FAC-${Y}-000001`, paymentStatus: 'unpaid', balanceDueMinor: 119_000 });
    expect(await balance(A)).toBe(119_000);
    expect(v.body.schedule).toHaveLength(1); // échéance à +30 jours (délai de paiement du client)
    expect(v.body.schedule[0].dueDate.slice(0, 10)).toBe(plusDays(30)); expect(v.body.schedule[0].amountMinor).toBe(119_000);
    expect(await AuditLog.countDocuments({ resource: 'invoice', action: 'validate', 'meta.number': `FAC-${Y}-000001` })).toBe(1);
  });
  it('facture validée IMMUABLE : modification, suppression, re-validation refusées → avoir', async () => {
    const v = await validated(A);
    const put = await A.j.put(`/invoices/${v.id}`, { customerId: A.customerId, lines: [line(A.products.a19, 9)] });
    expect(put.status).toBe(409); expect(put.body.error.message).toMatch(/avoir/i);
    const del = await A.j.del(`/invoices/${v.id}`); expect(del.status).toBe(409); expect(del.body.error.message).toMatch(/avoir/i);
    expect((await A.j.post(`/invoices/${v.id}/validate`)).status).toBe(409);
    const after = (await A.j.get(`/invoices/${v.id}`)).body; expect(after.totals.totalHtMinor).toBe(100_000); expect(after.number).toBe(v.number);
    // aucun endpoint ne permet de forcer numéro/statut/totaux
    for (const k of [{ number: 'FAC-X' }, { status: 'draft' }, { totals: {} }, { paidMinor: 5 }]) expect((await A.j.put(`/invoices/${v.id}`, { customerId: A.customerId, lines: [line(A.products.a19)], ...k })).status).toBe(422);
  });
  it('numérotation des factures : séquentielle sans trou sous validations concurrentes', async () => {
    const drafts = await Promise.all(Array.from({ length: 10 }, () => draftInvoice(A)));
    const before = (await Counter.findOne({ companyId: A.companyId, key: `invoice:${Y}` }))!.seq;
    const rs = await Promise.all(drafts.map((d) => A.j.post(`/invoices/${d.id}/validate`)));
    expect(rs.every((r) => r.status === 200), JSON.stringify(rs.find((r) => r.status !== 200)?.body)).toBe(true);
    const nums = rs.map((r) => Number(r.body.number.split('-')[2])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 10 }, (_, i) => before + i + 1));
  });
  it('un échec de validation annule TOUT : ni numéro consommé, ni solde modifié', async () => {
    const d = await draftInvoice(A, [{ designation: 'Prestation', quantity: 1, unitPriceMinor: 100_000, vatCode: 'T7' } as never]);
    const seq = (await Counter.findOne({ companyId: A.companyId, key: `invoice:${Y}` }))!.seq; const bal = await balance(A);
    await FiscalRule.create({ companyId: A.companyId, kind: 'vat', code: 'T7', status: 'validated', active: false, effectiveFrom: new Date(Date.now() - 86400000), vat: { regime: 'taxable', ratePct: 7 } }); // règle retirée entre-temps
    const r = await A.j.post(`/invoices/${d.id}/validate`); expect(r.status).toBe(400);
    expect((await Counter.findOne({ companyId: A.companyId, key: `invoice:${Y}` }))!.seq).toBe(seq); expect(await balance(A)).toBe(bal);
    expect((await A.j.get(`/invoices/${d.id}`)).body).toMatchObject({ status: 'draft', number: null });
    await FiscalRule.deleteOne({ companyId: A.companyId, code: 'T7', active: false });
    expect((await A.j.post(`/invoices/${d.id}/validate`)).status).toBe(200); // fonctionne une fois la règle rétablie
  });
  it('limite de crédit : la validation est BLOQUÉE (assertCanSell), sans numéro consommé', async () => {
    const c = (await A.j.post('/customers', { name: 'Petit crédit', creditLimitMinor: 150_000 })).body.id as string;
    const mk = async () => (await A.j.post('/invoices', { customerId: c, lines: [line(A.products.a19, 1)] })).body;
    const d1 = await mk(); const d2 = await mk();
    expect((await A.j.post(`/invoices/${d1.id}/validate`)).status).toBe(200); expect(await balance(A, c)).toBe(119_000);
    const seq = (await Counter.findOne({ companyId: A.companyId, key: `invoice:${Y}` }))!.seq;
    const r = await A.j.post(`/invoices/${d2.id}/validate`);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect((await Counter.findOne({ companyId: A.companyId, key: `invoice:${Y}` }))!.seq).toBe(seq); expect(await balance(A, c)).toBe(119_000);
    // client archivé : plus de création de document
    await A.j.post(`/customers/${c}/archive`); expect((await A.j.post('/invoices', { customerId: c, lines: [line(A.products.a19)] })).status).toBe(409);
  });
  it('retenue à la source et timbre : net à payer et solde client calculés sur le net', async () => {
    const w = (await A.j.post('/fiscal/rules', { kind: 'withholding', code: 'SERV', effectiveFrom: '2000-01-01', withholding: { ratePct: 1.5, base: 'ttc' } })).body; await A.j.post(`/fiscal/rules/${w.id}/validate`);
    const s = (await A.j.post('/fiscal/rules', { kind: 'stamp', code: 'TS', effectiveFrom: '2000-01-01', stamp: { amountMinor: 1_000, docTypes: ['invoice'] } })).body; await A.j.post(`/fiscal/rules/${s.id}/validate`);
    const c = (await A.j.post('/customers', { name: 'Assujetti', subjectToWithholding: true })).body.id as string;
    const bal0 = await balance(A, c);
    const d = (await A.j.post('/invoices', { customerId: c, withholdingOperationType: 'SERV', lines: [line(A.products.a19, 1)] })).body;
    expect(d.totals).toMatchObject({ totalTtcMinor: 119_000, stampMinor: 1_000, withholdingMinor: 1_785, totalPayableMinor: 118_215 });
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body;
    expect(v.withholding).toMatchObject({ code: 'SERV', amountMinor: 1_785 }); expect(v.stamp).toMatchObject({ code: 'TS', amountMinor: 1_000 }); expect(v.balanceDueMinor).toBe(118_215);
    expect(await balance(A, c)).toBe(bal0 + 118_215);
    await FiscalRule.deleteMany({ companyId: A.companyId, code: { $in: ['SERV', 'TS'] } }); // nettoyage pour les tests suivants
  });
  it('échéancier : pourcentages 30/70, dernier solde absorbe l’arrondi ; total ≠ 100 % refusé', async () => {
    expect((await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19)], schedule: [{ dueDate: plusDays(10), percent: 30 }, { dueDate: plusDays(40), percent: 60 }] })).status).toBe(422);
    const d = (await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19, 1, { unitPriceMinor: 33_333 })], schedule: [{ dueDate: plusDays(10), percent: 33.33 }, { dueDate: plusDays(40), percent: 66.67 }] })).body;
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body;
    expect(v.schedule.reduce((s: number, x: { amountMinor: number }) => s + x.amountMinor, 0)).toBe(v.totals.totalPayableMinor);
    expect(v.schedule[0].amountMinor).toBe(Math.round(v.totals.totalPayableMinor * 0.3333));
  });
  it('date de facture : pas dans le futur ni antérieure à la dernière facture validée', async () => {
    const f = await draftInvoice(A, [line(A.products.a19)], { issueDate: plusDays(5) });
    expect((await A.j.post(`/invoices/${f.id}/validate`)).status).toBe(409);
    const old = await draftInvoice(A, [line(A.products.a19)], { issueDate: '2020-01-01' });
    const r = await A.j.post(`/invoices/${old.id}/validate`); expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/chronologie/);
  });
  it('PDF : brouillon vs facture numérotée', async () => {
    const v = await validated(A);
    const pdf = await api().get(`/api/v1/invoices/${v.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    const txt = pdfText(pdf.body as Buffer); expect(txt).toContain(v.number); expect(txt).toContain('FACTURE'); expect(txt).not.toContain('PROFORMA');
  });
});

describe('encaissements et suivi des règlements', () => {
  it('encaissement partiel puis total : statuts, échéances, solde client', async () => {
    const d = (await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19, 1)], schedule: [{ dueDate: plusDays(-5), percent: 50 }, { dueDate: plusDays(30), percent: 50 }] })).body;
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body; const bal = await balance(A);
    expect((await A.j.get(`/invoices/${v.id}`)).body.overdue).toBe(true); // 1re échéance dépassée
    const p1 = await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 40_000, method: 'transfer', reference: 'VIR-1' });
    expect(p1.status).toBe(201); expect(p1.body.invoice).toMatchObject({ paidMinor: 40_000, balanceDueMinor: 79_000, paymentStatus: 'partial' });
    expect(await balance(A)).toBe(bal - 40_000);
    expect(p1.body.invoice.schedule.map((s: { paidMinor: number }) => s.paidMinor)).toEqual([40_000, 0]); // affecté à l'échéance la plus ancienne
    expect((await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 79_001, method: 'cash' })).status).toBe(409); // sur-paiement
    const p2 = await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 79_000, method: 'cash' });
    expect(p2.body.invoice).toMatchObject({ paymentStatus: 'paid', balanceDueMinor: 0, overdue: false }); expect(await balance(A)).toBe(bal - 119_000);
    expect((await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 1, method: 'cash' })).status).toBe(409);
    expect((await A.j.get(`/invoices/${v.id}/payments`)).body.total).toBe(2);
    expect((await A.j.get('/invoices?paymentStatus=paid')).body.items.map((i: { id: string }) => i.id)).toContain(v.id);
  });
  it('annulation d’un encaissement : tout est restauré, trace conservée', async () => {
    const v = await validated(A); const bal = await balance(A);
    const p = (await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 119_000, method: 'check' })).body.payment;
    expect((await A.j.post(`/invoices/payments/${p.id}/cancel`, { reason: 'x' })).status).toBe(422);
    expect((await A.j.post(`/invoices/payments/${p.id}/cancel`, { reason: 'Chèque impayé' })).body.status).toBe('cancelled');
    expect((await A.j.get(`/invoices/${v.id}`)).body).toMatchObject({ paidMinor: 0, paymentStatus: 'unpaid', balanceDueMinor: 119_000 }); expect(await balance(A)).toBe(bal);
    expect((await A.j.post(`/invoices/payments/${p.id}/cancel`, { reason: 'Encore' })).status).toBe(409);
    expect((await A.j.get(`/invoices/payments?invoiceId=${v.id}&status=cancelled`)).body.total).toBe(1);
  });
  it('encaissements simultanés : jamais de dépassement du reste à payer', async () => {
    const v = await validated(A);
    const rs = await Promise.all(Array.from({ length: 6 }, () => A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 30_000, method: 'cash' })));
    const ok = rs.filter((r) => r.status === 201).length;
    const inv = (await A.j.get(`/invoices/${v.id}`)).body; expect(inv.paidMinor).toBe(ok * 30_000); expect(inv.paidMinor).toBeLessThanOrEqual(119_000); expect(ok).toBeLessThanOrEqual(3);
  });
  it('impossible d’encaisser un brouillon, d’encaisser sans permission', async () => {
    const d = await draftInvoice(A); expect((await A.j.post(`/invoices/${d.id}/payments`, { amountMinor: 1, method: 'cash' })).status).toBe(409);
    await makeUser(A.companyId, 'vue@a.test', ['invoices:view']); const t = J((await login('vue@a.test')).token); const v = await validated(A);
    expect((await t.post(`/invoices/${v.id}/payments`, { amountMinor: 1, method: 'cash' })).status).toBe(403);
  });
});

describe('avoirs', () => {
  it('avoir total : numéro AV-AAAA-000001, solde client crédité, facture soldée, avoir immuable', async () => {
    const v = await validated(A, [line(A.products.a19, 2)]); const bal = await balance(A);
    const c = await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'Retour marchandise' });
    expect(c.status).toBe(201); expect(c.body).toMatchObject({ type: 'credit_note', status: 'draft', creditedInvoiceId: v.id, creditReason: 'Retour marchandise' });
    expect(await balance(A)).toBe(bal); // brouillon : sans effet
    const cv = await A.j.post(`/invoices/${c.body.id}/validate`);
    expect(cv.status).toBe(200); expect(cv.body.number).toBe(`AV-${Y}-000001`); expect(await balance(A)).toBe(bal - 238_000);
    expect((await A.j.get(`/invoices/${v.id}`)).body).toMatchObject({ creditedMinor: 238_000, balanceDueMinor: 0, paymentStatus: 'paid' });
    expect((await A.j.del(`/invoices/${cv.body.id}`)).status).toBe(409);
    expect((await A.j.post(`/invoices/${cv.body.id}/credit-note`, { reason: 'avoir sur avoir' })).status).toBe(409);
    expect((await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'déjà crédité' })).status).toBe(409); // intégralement crédité
  });
  it('avoir partiel par ligne : quantités créditables contrôlées, TVA d’origine conservée', async () => {
    const v = await validated(A, [line(A.products.a19, 10), line(A.products.b13, 2)]); const l0 = v.lines[0].id;
    const over = await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'trop', lines: [{ sourceLineId: l0, quantity: 11 }] }); expect(over.status).toBe(409);
    const c1 = (await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'Casse', lines: [{ sourceLineId: l0, quantity: 4 }] })).body;
    expect(c1.totals).toMatchObject({ totalHtMinor: 400_000, totalVatMinor: 76_000 });
    const c2 = (await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'Casse 2', lines: [{ sourceLineId: l0, quantity: 7 }] })).body; // 4 + 7 > 10 au total
    expect((await A.j.post(`/invoices/${c1.id}/validate`)).status).toBe(200);
    expect((await A.j.post(`/invoices/${c2.id}/validate`)).status).toBe(409); // dépasse le reliquat à la validation
    const c3 = (await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'Reste' })).body; // « total » = quantités restantes
    expect(c3.lines.find((l: { sourceLineId: string }) => l.sourceLineId === l0).quantity).toBe(6);
    expect((await A.j.post('/invoices/000000000000000000000000/credit-note', { reason: 'inconnue' })).status).toBe(404);
  });
  it('un avoir ne s’émet que sur une facture validée', async () => {
    const d = await draftInvoice(A); expect((await A.j.post(`/invoices/${d.id}/credit-note`, { reason: 'brouillon' })).status).toBe(409);
  });
  it('avoir après encaissement : le crédit revient au client (solde négatif), sans exiger de remboursement', async () => {
    const v = await validated(A); await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 119_000, method: 'cash' });
    const bal = await balance(A);
    const c = (await A.j.post(`/invoices/${v.id}/credit-note`, { reason: 'Erreur de prix' })).body; await A.j.post(`/invoices/${c.id}/validate`);
    expect(await balance(A)).toBe(bal - 119_000); // créance client en sa faveur
  });
});

describe('isolation, permissions, intégrité', () => {
  it('une société ne voit ni ne manipule les documents d’une autre', async () => {
    const q = (await q1(A)).body; const v = await validated(A);
    for (const url of [`/quotations/${q.id}`, `/invoices/${v.id}`, `/quotations/${q.id}/pdf`, `/invoices/${v.id}/pdf`]) expect((await B.j.get(url)).status, url).toBe(404);
    expect((await B.j.post(`/quotations/${q.id}/accept`)).status).toBe(404);
    expect((await B.j.post(`/invoices/${v.id}/payments`, { amountMinor: 1, method: 'cash' })).status).toBe(404);
    expect((await B.j.post(`/invoices/${v.id}/credit-note`, { reason: 'intrus' })).status).toBe(404);
    expect((await B.j.get('/invoices?limit=100')).body.items.every((i: { customer: { name: string } }) => i.customer.name === 'Client Test')).toBe(true);
    expect((await B.j.get('/invoices')).body.total).toBe(0);
  });
  it('permissions séparées : consulter / créer / modifier / valider / supprimer', async () => {
    const mk = async (email: string, perms: string[]) => { await makeUser(A.companyId, email, perms); return J((await login(email)).token); };
    const view = await mk('iv@a.test', ['invoices:view']); const create = await mk('ic@a.test', ['invoices:create']); const val = await mk('ival@a.test', ['invoices:validate']); const del = await mk('id@a.test', ['invoices:delete']);
    const d = await draftInvoice(A);
    expect((await view.get('/invoices')).status).toBe(200); expect((await view.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19)] })).status).toBe(403);
    expect((await create.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19)] })).status).toBe(201); expect((await create.get('/invoices')).status).toBe(403);
    expect((await create.post(`/invoices/${d.id}/validate`)).status).toBe(403);
    expect((await view.put(`/invoices/${d.id}`, { customerId: A.customerId, lines: [line(A.products.a19)] })).status).toBe(403);
    expect((await del.del(`/invoices/${d.id}`)).status).toBe(204);
    const d2 = await draftInvoice(A); expect((await val.post(`/invoices/${d2.id}/validate`)).status).toBe(200);
    const qv = await mk('qv@a.test', ['quotations:view']); expect((await qv.post('/quotations', quoteBody(A, [line(A.products.a19)]))).status).toBe(403);
    const q = (await q1(A)).body; expect((await qv.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(403);
    const qu = await mk('qu@a.test', ['quotations:update']); expect((await qu.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(403); // exige aussi proformas:create
  });
  it('clients et articles référencés par des documents ne sont pas supprimables (reference-guard)', async () => {
    const c = (await A.j.post('/customers', { name: 'À protéger' })).body.id as string; await A.j.post('/quotations', { customerId: c, validUntil: plusDays(5), lines: [line(A.products.c7)] });
    const r = await A.j.del(`/customers/${c}`); expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/devis/);
    const p = (await A.j.del(`/products/${A.products.c7}`)); expect(p.status).toBe(409); expect(p.body.error.message).toMatch(/documents commerciaux/);
  });
  it('synthèse : chiffre d’affaires, TVA collectée et impayés (factures − avoirs)', async () => {
    const s = (await A.j.get('/invoices/summary')).body;
    expect(s.invoiceCount).toBeGreaterThan(5); expect(s.creditNoteCount).toBeGreaterThan(1);
    expect(s.revenueTtcMinor).toBe(s.revenueHtMinor + s.vatCollectedMinor); expect(s.unpaidMinor).toBeGreaterThan(0);
    const inv = await Invoice.aggregate([{ $match: { companyId: A.companyId, status: 'validated', type: 'invoice' } }, { $group: { _id: null, ht: { $sum: '$totals.totalHtMinor' } } }]);
    expect(s.revenueHtMinor).toBeLessThan(inv[0].ht + 1);
  });
});
