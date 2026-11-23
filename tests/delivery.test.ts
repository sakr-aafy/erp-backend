import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, line, plusDays, quoteBody, salesCompany, api, type Ctx } from './sales.helpers.js';
import { Customer } from '../src/models/customer.model.js';
import { Counter } from '../src/models/counter.model.js';
import { Quotation } from '../src/models/sales.model.js';
import { clearDomainHandlers, onDomainEvent } from '../src/services/domain-events.js';

let A: Ctx, B: Ctx;
const Y = new Date().getUTCFullYear();
const events: string[] = [];

const acceptedQuote = async (ctx: Ctx, qty = 10) => {
  const q = (await ctx.j.post('/quotations', quoteBody(ctx, [line(ctx.products.a19, qty), line(ctx.products.svc, 1)]))).body;
  await ctx.j.post(`/quotations/${q.id}/accept`); return (await ctx.j.get(`/quotations/${q.id}`)).body;
};
const bl = (ctx: Ctx, quote: { id: string; lines: { id: string }[] }, qty: number, lineIdx = 0) =>
  ctx.j.post('/delivery-notes', { source: { type: 'quotation', id: quote.id }, lines: [{ sourceLineId: quote.lines[lineIdx]!.id, quantity: qty }], carrier: 'Transporteur X' });
const delivered = async (id: string) => (await Quotation.findById(id))!.lines[0]!.deliveredQty;

beforeAll(async () => {
  await setupDb(); A = await salesCompany('Alpha', 'admin@a.test'); B = await salesCompany('Beta', 'admin@b.test');
  clearDomainHandlers(); // ces tests isolent le module Ventes : le module Stock est couvert par stock.test.ts
  for (const e of ['deliveryNote.validated', 'deliveryNote.cancelled'] as const) onDomainEvent(e, async (ctx) => { events.push(`${e}:${ctx.documentId}`); });
});
afterAll(async () => { clearDomainHandlers(); await teardownDb(); });

describe('bons de livraison : création et règles', () => {
  it('depuis un devis accepté : lignes livrables (services exclus) avec reste à livrer', async () => {
    const q = await acceptedQuote(A);
    const s = (await A.j.get(`/delivery-notes/source-lines?type=quotation&id=${q.id}`)).body;
    expect(s.lines).toHaveLength(1); expect(s.lines[0]).toMatchObject({ designation: 'Article A19', quantity: 10, deliveredQty: 0, remainingQty: 10 });
    const r = await bl(A, q, 4);
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ number: `BL-${Y}-000001`, status: 'draft', carrier: 'Transporteur X', source: { type: 'quotation', id: q.id } });
    expect(r.body.lines[0]).toMatchObject({ quantity: 4, sourceLineId: q.lines[0].id, unitPriceMinor: 100_000 }); expect(r.body.totals.totalHtMinor).toBe(400_000);
    expect(await delivered(q.id)).toBe(0); // un brouillon ne livre rien
  });
  it('refuse : devis non accepté, ligne de service, ligne étrangère, quantité > reste', async () => {
    const pending = (await A.j.post('/quotations', quoteBody(A, [line(A.products.a19, 3)]))).body;
    expect((await A.j.post('/delivery-notes', { source: { type: 'quotation', id: pending.id }, lines: [{ sourceLineId: pending.lines[0].id, quantity: 1 }] })).status).toBe(409);
    const q = await acceptedQuote(A);
    expect((await bl(A, q, 1, 1)).status).toBe(400);   // service non livrable
    expect((await bl(A, q, 11)).status).toBe(409);      // > quantité commandée
    expect((await A.j.post('/delivery-notes', { source: { type: 'quotation', id: q.id }, lines: [{ sourceLineId: '0'.repeat(24), quantity: 1 }] })).status).toBe(400);
    expect((await A.j.post('/delivery-notes', { source: { type: 'quotation', id: q.id }, lines: [line(A.products.a19, 1)] })).status).toBe(422); // sourceLineId manquant
    expect((await B.j.post('/delivery-notes', { source: { type: 'quotation', id: q.id }, lines: [{ sourceLineId: q.lines[0].id, quantity: 1 }] })).status).toBe(404); // autre société
  });
  it('livraison manuelle (sans source) et numérotation BL sans doublon sous concurrence', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => A.j.post('/delivery-notes', { customerId: A.customerId, lines: [line(A.products.b13, 2)] })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => Number(r.body.number.split('-')[2])).sort((a, b) => a - b); expect(new Set(nums).size).toBe(8);
    expect(nums[7]! - nums[0]!).toBe(7); // contigus
    expect((await Counter.findOne({ companyId: A.companyId, key: `deliveryNote:${Y}` }))!.seq).toBe(nums[7]);
  });
});

describe('livraisons partielles et complètes', () => {
  it('validation successive : quantités livrées cumulées, reste, refus de sur-livraison', async () => {
    const q = await acceptedQuote(A, 10);
    const b1 = (await bl(A, q, 6)).body; const b2 = (await bl(A, q, 4)).body;
    const v1 = await A.j.post(`/delivery-notes/${b1.id}/validate`); expect(v1.status).toBe(200); expect(v1.body.status).toBe('validated');
    expect(await delivered(q.id)).toBe(6);
    expect((await A.j.get(`/delivery-notes/source-lines?type=quotation&id=${q.id}`)).body.lines[0].remainingQty).toBe(4);
    expect((await bl(A, q, 5)).status).toBe(409);                                   // 6 + 5 > 10
    expect((await A.j.post(`/delivery-notes/${b2.id}/validate`)).status).toBe(200); // livraison complète
    expect(await delivered(q.id)).toBe(10);
    expect((await A.j.get(`/delivery-notes/source-lines?type=quotation&id=${q.id}`)).body.lines[0].remainingQty).toBe(0);
    expect((await bl(A, q, 1)).status).toBe(409);
  });
  it('deux BL brouillons sur la même quantité : le second ne peut plus être validé', async () => {
    const q = await acceptedQuote(A, 10);
    const b1 = (await bl(A, q, 7)).body; const b2 = (await bl(A, q, 7)).body;
    expect((await A.j.post(`/delivery-notes/${b1.id}/validate`)).status).toBe(200);
    const r = await A.j.post(`/delivery-notes/${b2.id}/validate`); expect(r.status).toBe(409);
    expect(await delivered(q.id)).toBe(7); expect((await A.j.get(`/delivery-notes/${b2.id}`)).body.status).toBe('draft');
  });
  it('validations simultanées : jamais plus que la quantité commandée', async () => {
    const q = await acceptedQuote(A, 10);
    const bls = await Promise.all(Array.from({ length: 4 }, () => bl(A, q, 4)));
    const rs = await Promise.all(bls.map((b) => A.j.post(`/delivery-notes/${b.body.id}/validate`)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2); expect(await delivered(q.id)).toBe(8);
  });
  it('BL depuis une proforma et depuis une facture validée', async () => {
    const p = (await A.j.post('/proformas', quoteBody(A, [line(A.products.a19, 5)]))).body;
    const bp = await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 5 }] }); expect(bp.status).toBe(201);
    expect((await A.j.post(`/delivery-notes/${bp.body.id}/validate`)).status).toBe(200);
    const d = (await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19, 3)] })).body;
    expect((await A.j.post('/delivery-notes', { source: { type: 'invoice', id: d.id }, lines: [{ sourceLineId: d.lines[0].id, quantity: 1 }] })).status).toBe(409); // brouillon : pas livrable
    const v = (await A.j.post(`/invoices/${d.id}/validate`)).body;
    const bi = await A.j.post('/delivery-notes', { source: { type: 'invoice', id: v.id }, lines: [{ sourceLineId: v.lines[0].id, quantity: 3 }] }); expect(bi.status).toBe(201);
  });
  it('devis converti : livraison depuis la proforma/facture ; BL existants : conversion en facture refusée', async () => {
    const q = await acceptedQuote(A, 5); const b = (await bl(A, q, 2)).body;
    expect((await A.j.post(`/quotations/${q.id}/convert-invoice`)).status).toBe(409); expect((await A.j.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(409);
    expect((await A.j.del(`/quotations/${q.id}`)).status).toBe(409);
    await A.j.del(`/delivery-notes/${b.id}`);
    const q2 = await acceptedQuote(A, 5); await A.j.post(`/quotations/${q2.id}/convert-invoice`);
    expect((await bl(A, q2, 1)).status).toBe(409); // converti en facture : livrer depuis la facture
  });
});

describe('validation, immuabilité, annulation, événements', () => {
  it('BL validé : non modifiable ni supprimable ; brouillon modifiable / supprimable', async () => {
    const q = await acceptedQuote(A); const b = (await bl(A, q, 2)).body;
    const upd = await A.j.put(`/delivery-notes/${b.id}`, { source: { type: 'quotation', id: q.id }, lines: [{ sourceLineId: q.lines[0].id, quantity: 3 }], carrier: 'Autre' });
    expect(upd.status).toBe(200); expect(upd.body.lines[0].quantity).toBe(3); expect(upd.body.carrier).toBe('Autre');
    await A.j.post(`/delivery-notes/${b.id}/validate`);
    expect((await A.j.put(`/delivery-notes/${b.id}`, { source: { type: 'quotation', id: q.id }, lines: [{ sourceLineId: q.lines[0].id, quantity: 1 }] })).status).toBe(409);
    expect((await A.j.del(`/delivery-notes/${b.id}`)).status).toBe(409);
    expect((await A.j.post(`/delivery-notes/${b.id}/validate`)).status).toBe(409);
    const d = (await bl(A, q, 1)).body; expect((await A.j.del(`/delivery-notes/${d.id}`)).status).toBe(204);
  });
  it('la validation et l’annulation notifient les modules (stock, Phase 5) dans la même transaction', async () => {
    const q = await acceptedQuote(A); const b = (await bl(A, q, 5)).body; events.length = 0;
    await A.j.post(`/delivery-notes/${b.id}/validate`); expect(events).toEqual([`deliveryNote.validated:${b.id}`]);
    const c = await A.j.post(`/delivery-notes/${b.id}/cancel`, { reason: 'Erreur de saisie' });
    expect(c.status).toBe(200); expect(c.body.status).toBe('cancelled'); expect(events[1]).toBe(`deliveryNote.cancelled:${b.id}`);
    expect(await delivered(q.id)).toBe(0); // quantités restituées
    expect((await A.j.post(`/delivery-notes/${b.id}/cancel`, { reason: 'Encore une fois' })).status).toBe(409);
    expect((await A.j.post(`/delivery-notes/${b.id}/validate`)).status).toBe(409);
  });
  it('si un module abonné échoue (ex. stock insuffisant), la validation est ANNULÉE en entier', async () => {
    const q = await acceptedQuote(A); const b = (await bl(A, q, 5)).body;
    onDomainEvent('deliveryNote.validated', async () => { throw new Error('Stock insuffisant'); });
    const r = await A.j.post(`/delivery-notes/${b.id}/validate`); expect(r.status).toBe(500);
    expect(await delivered(q.id)).toBe(0); expect((await A.j.get(`/delivery-notes/${b.id}`)).body.status).toBe('draft');
    clearDomainHandlers(); for (const e of ['deliveryNote.validated', 'deliveryNote.cancelled'] as const) onDomainEvent(e, async (c) => { events.push(`${e}:${c.documentId}`); });
  });
  it('limite de crédit : un BL ne peut pas être validé si la vente est bloquée', async () => {
    const c = (await A.j.post('/customers', { name: 'Crédit court', creditLimitMinor: 1_000 })).body.id as string;
    const b = (await A.j.post('/delivery-notes', { customerId: c, lines: [line(A.products.a19, 1)] })).body;
    const r = await A.j.post(`/delivery-notes/${b.id}/validate`); expect(r.status).toBe(409); expect(r.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
  });
  it('PDF du BL : quantités sans prix', async () => {
    const q = await acceptedQuote(A); const b = (await bl(A, q, 2)).body;
    const pdf = await api().get(`/api/v1/delivery-notes/${b.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    const t = pdfText(pdf.body as Buffer); expect(t).toContain('BON DE LIVRAISON'); expect(t).toContain(b.number); expect(t).toContain('Article A19'); expect(t).not.toContain('Total HT');
  });
});

describe('facturation des BL', () => {
  it('BL validés → facture brouillon ; BL liés, non annulables, non refacturables ; solde client modifié seulement à la validation', async () => {
    const q = await acceptedQuote(A, 10);
    const b1 = (await bl(A, q, 3)).body; const b2 = (await bl(A, q, 2)).body;
    expect((await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b1.id] })).status).toBe(409); // BL brouillon non facturable
    await A.j.post(`/delivery-notes/${b1.id}/validate`); await A.j.post(`/delivery-notes/${b2.id}/validate`);
    expect((await A.j.get('/delivery-notes?status=validated&invoiced=false')).body.items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([b1.id, b2.id])); // rapport : BL non facturés
    const bal = (await Customer.findById(A.customerId))!.balanceMinor;
    const inv = await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b1.id, b2.id] });
    expect(inv.status).toBe(201); expect(inv.body).toMatchObject({ status: 'draft', deliveryNoteIds: [b1.id, b2.id] }); expect(inv.body.totals.totalHtMinor).toBe(500_000);
    expect(inv.body.lines.every((l: { deliveredQty: number; quantity: number }) => l.deliveredQty === l.quantity)).toBe(true); // déjà livré : pas de nouveau BL
    expect((await Customer.findById(A.customerId))!.balanceMinor).toBe(bal);
    expect((await A.j.get(`/delivery-notes/${b1.id}`)).body).toMatchObject({ invoiced: true, invoiceId: inv.body.id, cancellable: false });
    expect((await A.j.post(`/delivery-notes/${b1.id}/cancel`, { reason: 'Trop tard' })).status).toBe(409);
    expect((await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b2.id] })).status).toBe(409);
    expect((await A.j.post(`/invoices/${inv.body.id}/validate`)).status).toBe(200); expect((await Customer.findById(A.customerId))!.balanceMinor).toBe(bal + 595_000);
    expect((await A.j.get('/delivery-notes?invoiced=false&status=validated')).body.items.map((x: { id: string }) => x.id)).not.toContain(b1.id);
  });
  it('supprimer la facture brouillon libère les BL', async () => {
    const q = await acceptedQuote(A, 10); const b = (await bl(A, q, 3)).body; await A.j.post(`/delivery-notes/${b.id}/validate`);
    const inv = (await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b.id] })).body;
    expect((await A.j.del(`/invoices/${inv.id}`)).status).toBe(204);
    expect((await A.j.get(`/delivery-notes/${b.id}`)).body).toMatchObject({ invoiced: false, cancellable: true });
  });
  it('BL de clients différents, introuvables ou d’une autre société : refusés', async () => {
    const c2 = (await A.j.post('/customers', { name: 'Autre client' })).body.id as string;
    const x = (await A.j.post('/delivery-notes', { customerId: A.customerId, lines: [line(A.products.b13, 1)] })).body; const y = (await A.j.post('/delivery-notes', { customerId: c2, lines: [line(A.products.b13, 1)] })).body;
    await A.j.post(`/delivery-notes/${x.id}/validate`); await A.j.post(`/delivery-notes/${y.id}/validate`);
    expect((await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [x.id, y.id] })).status).toBe(400);
    expect((await A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: ['0'.repeat(24)] })).status).toBe(400);
    expect((await B.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [x.id] })).status).toBe(400);
  });
  it('permissions BL : valider/annuler exigent deliveryNotes:validate', async () => {
    await makeUser(A.companyId, 'bl-c@a.test', ['deliveryNotes:create', 'deliveryNotes:update', 'deliveryNotes:view']); const c = J((await login('bl-c@a.test')).token);
    const b = await c.post('/delivery-notes', { customerId: A.customerId, lines: [line(A.products.b13, 1)] }); expect(b.status).toBe(201);
    expect((await c.post(`/delivery-notes/${b.body.id}/validate`)).status).toBe(403);
    expect((await c.del(`/delivery-notes/${b.body.id}`)).status).toBe(403);
    await makeUser(A.companyId, 'bl-v@a.test', ['deliveryNotes:validate']); const v = J((await login('bl-v@a.test')).token);
    expect((await v.post(`/delivery-notes/${b.body.id}/validate`)).status).toBe(200);
    expect((await B.j.get(`/delivery-notes/${b.body.id}`)).status).toBe(404);
    void plusDays;
  });
});
