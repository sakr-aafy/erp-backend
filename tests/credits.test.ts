import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupDb, teardownDb } from './helpers.js';
import { line, plusDays, salesCompany, type Ctx } from './sales.helpers.js';
import { Customer } from '../src/models/customer.model.js';

let A: Ctx;
beforeAll(async () => { await setupDb(); A = await salesCompany('Alpha', 'admin@a.test'); });
afterAll(teardownDb);

const mkInvoice = async (ctx: Ctx, body: object) => { const d = (await ctx.j.post('/invoices', { customerId: ctx.customerId, ...body })).body; const v = await ctx.j.post(`/invoices/${d.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); return v.body; };
const credit = async (ctx: Ctx, invId: string, lines?: { sourceLineId: string; quantity: number }[], validate = true) => {
  const c = await ctx.j.post(`/invoices/${invId}/credit-note`, { reason: 'Test avoir', ...(lines && { lines }) }); if (c.status !== 201) return c;
  return validate ? ctx.j.post(`/invoices/${c.body.id}/validate`) : c;
};
const bal = async (ctx: Ctx) => (await Customer.findById(ctx.customerId))!.balanceMinor;
const sum = (docs: { totals: Record<string, number> }[], k: string) => docs.reduce((s, d) => s + d.totals[k]!, 0);
const consistent = async (ctx: Ctx, invId: string) => {
  expect((await ctx.j.get(`/customers/${ctx.customerId}/balance-check`)).body).toMatchObject({ consistent: true });
  const c = (await ctx.j.get(`/invoices/${invId}/consistency`)).body; expect(c.consistent, JSON.stringify(c)).toBe(true);
};

describe('avoirs partiels avec remise globale', () => {
  it('remise globale EN MONTANT : avoirs successifs = facture au millime (HT, TVA par taux, TTC)', async () => {
    const v = await mkInvoice(A, { globalDiscountMinor: 10_001, lines: [line(A.products.a19, 3), line(A.products.b13, 2), line(A.products.c7, 5)] });
    expect(v.totals.globalDiscountMinor).toBe(10_001); const [l1, l2, l3] = v.lines.map((l: { id: string }) => l.id);
    expect(v.lines.reduce((s: number, l: { globalShareMinor: number }) => s + l.globalShareMinor, 0)).toBe(10_001); // la remise est imputée aux lignes, somme exacte
    const notes = [];
    for (const lines of [[{ sourceLineId: l1, quantity: 1 }], [{ sourceLineId: l1, quantity: 1 }, { sourceLineId: l3, quantity: 2 }], [{ sourceLineId: l2, quantity: 1 }, { sourceLineId: l3, quantity: 3 }, { sourceLineId: l1, quantity: 1 }], [{ sourceLineId: l2, quantity: 1 }]]) {
      const r = await credit(A, v.id, lines); expect(r.status, JSON.stringify(r.body)).toBe(200); notes.push(r.body);
    }
    expect(sum(notes, 'totalHtMinor')).toBe(v.totals.totalHtMinor); expect(sum(notes, 'totalVatMinor')).toBe(v.totals.totalVatMinor);
    expect(sum(notes, 'totalTtcMinor')).toBe(v.totals.totalTtcMinor); expect(sum(notes, 'totalPayableMinor')).toBe(v.totals.totalPayableMinor);
    for (const g of v.totals.vatGroups) {
      const sb = notes.flatMap((n) => n.totals.vatGroups).filter((x: { vatCode: string }) => x.vatCode === g.vatCode);
      expect(sb.reduce((s: number, x: { baseMinor: number }) => s + x.baseMinor, 0)).toBe(g.baseMinor); expect(sb.reduce((s: number, x: { vatMinor: number }) => s + x.vatMinor, 0)).toBe(g.vatMinor);
    }
    const after = (await A.j.get(`/invoices/${v.id}`)).body; expect(after).toMatchObject({ creditedMinor: v.totals.totalPayableMinor, balanceDueMinor: 0, paymentStatus: 'paid' });
    await consistent(A, v.id);
    expect((await credit(A, v.id)).status).toBe(409); // plus rien à créditer
  });
  it('un avoir partiel est proportionnel : base HT = net après remise × quantité créditée / quantité facturée', async () => {
    const v = await mkInvoice(A, { globalDiscountMinor: 20_000, lines: [line(A.products.a19, 4)] }); // 400 000 − 20 000 = 380 000 HT
    const c = await credit(A, v.id, [{ sourceLineId: v.lines[0].id, quantity: 1 }]); expect(c.body.totals).toMatchObject({ totalHtMinor: 95_000, totalVatMinor: 18_050, totalTtcMinor: 113_050 });
    await consistent(A, v.id);
  });
  it('remise globale EN % : mêmes garanties', async () => {
    const v = await mkInvoice(A, { globalDiscountPct: 7.5, lines: [line(A.products.a19, 3, { discountPct: 3.3 }), line(A.products.b13, 7), line(A.products.c7, 1)] });
    const ids = v.lines.map((l: { id: string; quantity: number }) => ({ id: l.id, q: l.quantity })); const notes = [];
    for (const [i, q] of [[0, 2], [1, 3], [1, 4], [2, 1], [0, 1]] as [number, number][]) { const r = await credit(A, v.id, [{ sourceLineId: ids[i].id, quantity: q }]); expect(r.status, JSON.stringify(r.body)).toBe(200); notes.push(r.body); }
    expect(sum(notes, 'totalHtMinor')).toBe(v.totals.totalHtMinor); expect(sum(notes, 'totalVatMinor')).toBe(v.totals.totalVatMinor); expect(sum(notes, 'totalTtcMinor')).toBe(v.totals.totalTtcMinor);
    await consistent(A, v.id);
  });
  it('retenue à la source et remise globale : la retenue cumulée des avoirs égale celle de la facture', async () => {
    const w = (await A.j.post('/fiscal/rules', { kind: 'withholding', code: 'SERV', effectiveFrom: '2000-01-01', withholding: { ratePct: 1.5, base: 'ttc' } })).body; await A.j.post(`/fiscal/rules/${w.id}/validate`);
    await Customer.updateOne({ _id: A.customerId }, { subjectToWithholding: true });
    const v = await mkInvoice(A, { withholdingOperationType: 'SERV', globalDiscountMinor: 3_333, lines: [line(A.products.a19, 3), line(A.products.b13, 3)] });
    expect(v.totals.withholdingMinor).toBeGreaterThan(0);
    const notes = []; for (const [i, q] of [[0, 1], [1, 1], [0, 2], [1, 2]] as [number, number][]) { const r = await credit(A, v.id, [{ sourceLineId: v.lines[i].id, quantity: q }]); expect(r.status).toBe(200); notes.push(r.body); }
    expect(sum(notes, 'withholdingMinor')).toBe(v.totals.withholdingMinor); expect(sum(notes, 'totalPayableMinor')).toBe(v.totals.totalPayableMinor); expect(notes[0].withholding.ratePct).toBe(1.5);
    await consistent(A, v.id);
    await Customer.updateOne({ _id: A.customerId }, { subjectToWithholding: false });
  });
  it('interdit tout avoir au-delà des quantités ou montants disponibles', async () => {
    const v = await mkInvoice(A, { globalDiscountMinor: 5_000, lines: [line(A.products.a19, 2)] }); const id = v.lines[0].id;
    expect((await credit(A, v.id, [{ sourceLineId: id, quantity: 2.001 }], false)).status).toBe(409);
    const d1 = await credit(A, v.id, [{ sourceLineId: id, quantity: 1.5 }], false); const d2 = await credit(A, v.id, [{ sourceLineId: id, quantity: 1.5 }], false); // deux brouillons concurrents
    expect((await A.j.post(`/invoices/${d1.body.id}/validate`)).status).toBe(200);
    const r = await A.j.post(`/invoices/${d2.body.id}/validate`); expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/restante|créditable/);
    expect((await credit(A, v.id, [{ sourceLineId: id, quantity: 0.6 }], false)).status).toBe(409);
    const last = await credit(A, v.id, [{ sourceLineId: id, quantity: 0.5 }]); expect(last.status).toBe(200);
    expect((await credit(A, v.id, [{ sourceLineId: id, quantity: 0.001 }], false)).status).toBe(409);
    await consistent(A, v.id); expect((await A.j.get(`/invoices/${v.id}`)).body.creditedMinor).toBe(v.totals.totalPayableMinor);
  });
});

describe('avoirs, échéancier, paiements et soldes clients', () => {
  const plan = (n: number) => Array.from({ length: n }, (_, i) => ({ dueDate: plusDays(10 + 30 * i), percent: 100 / n }));
  it('avoir sur facture impayée : imputé sur les échéances les plus lointaines, reste dû et solde client mis à jour', async () => {
    const v = await mkInvoice(A, { lines: [line(A.products.a19, 4)], schedule: plan(2) }); // 476 000 TTC : 2 × 238 000
    const before = await bal(A);
    const c = await credit(A, v.id, [{ sourceLineId: v.lines[0].id, quantity: 1.5 }]); const cr = c.body.totals.totalPayableMinor; // 178 500
    const inv = (await A.j.get(`/invoices/${v.id}`)).body;
    expect(inv.creditedMinor).toBe(cr); expect(inv.balanceDueMinor).toBe(476_000 - cr); expect(inv.paymentStatus).toBe('partial');
    expect(inv.schedule.map((s: { creditedMinor: number }) => s.creditedMinor)).toEqual([0, cr]); expect(inv.schedule.map((s: { openMinor: number }) => s.openMinor)).toEqual([238_000, 238_000 - cr]);
    expect(await bal(A)).toBe(before - cr); await consistent(A, v.id);
    // un second avoir déborde sur l'échéance précédente
    const c2 = await credit(A, v.id, [{ sourceLineId: v.lines[0].id, quantity: 1.5 }]); const cr2 = c2.body.totals.totalPayableMinor;
    const inv2 = (await A.j.get(`/invoices/${v.id}`)).body; expect(inv2.schedule[1].openMinor).toBe(0); expect(inv2.schedule[0].openMinor).toBe(238_000 - (cr + cr2 - 238_000)); await consistent(A, v.id);
  });
  it('le paiement s’impute sur le reste dû des échéances (après avoir) et jamais au-delà', async () => {
    const v = await mkInvoice(A, { lines: [line(A.products.a19, 2)], schedule: plan(2) }); // 2 × 119 000
    await credit(A, v.id, [{ sourceLineId: v.lines[0].id, quantity: 1 }]); // 119 000 crédités : échéance 2 soldée
    const inv = (await A.j.get(`/invoices/${v.id}`)).body; expect(inv.balanceDueMinor).toBe(119_000);
    expect((await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 119_001, method: 'cash' })).status).toBe(409);
    const p = await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 119_000, method: 'cash' }); expect(p.body.invoice).toMatchObject({ paymentStatus: 'paid', balanceDueMinor: 0 });
    expect(p.body.invoice.schedule.map((s: { paidMinor: number }) => s.paidMinor)).toEqual([119_000, 0]); await consistent(A, v.id);
  });
  it('avoir après encaissement : excédent = créance client (solde négatif), sans double comptage', async () => {
    const v = await mkInvoice(A, { lines: [line(A.products.a19, 1)], schedule: plan(2) }); const before = await bal(A);
    await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 119_000, method: 'transfer' });
    const c = await credit(A, v.id); expect(c.status).toBe(200);
    const inv = (await A.j.get(`/invoices/${v.id}`)).body; expect(inv).toMatchObject({ balanceDueMinor: 0, paymentStatus: 'paid', overpaidMinor: 119_000 });
    expect(await bal(A)).toBe(before - 238_000); // (facture déjà comptée dans « before ») paiement −119 000 et avoir −119 000 : créance client
    await consistent(A, v.id);
  });
  it('annulation d’un encaissement après avoir : le reste dû est recalculé, tout reste cohérent', async () => {
    const v = await mkInvoice(A, { lines: [line(A.products.a19, 2)], schedule: plan(2) });
    const pay = (await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: 150_000, method: 'check' })).body.payment;
    await credit(A, v.id, [{ sourceLineId: v.lines[0].id, quantity: 1 }]); // crédité 119 000
    expect((await A.j.get(`/invoices/${v.id}`)).body.balanceDueMinor).toBe(0); // 238 000 − 150 000 − 119 000 < 0 → 0, excédent
    await A.j.post(`/invoices/payments/${pay.id}/cancel`, { reason: 'Chèque rejeté' });
    const inv = (await A.j.get(`/invoices/${v.id}`)).body; expect(inv).toMatchObject({ paidMinor: 0, balanceDueMinor: 119_000, paymentStatus: 'partial' }); await consistent(A, v.id);
  });
  it('propriété : suites aléatoires de factures, encaissements, annulations et avoirs → soldes et factures toujours cohérents', async () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 6; n++) {
      const v = await mkInvoice(A, { ...(rnd() < 0.5 && { globalDiscountMinor: Math.floor(rnd() * 20_000) }), lines: [line(A.products.a19, 1 + Math.floor(rnd() * 5)), line(A.products.b13, 1 + Math.floor(rnd() * 5))], schedule: plan(1 + Math.floor(rnd() * 3)) });
      const pays: string[] = [];
      for (let k = 0; k < 8; k++) {
        const cur = (await A.j.get(`/invoices/${v.id}`)).body; const r = rnd();
        if (r < 0.4 && cur.balanceDueMinor > 0) { const amt = Math.max(1, Math.floor(cur.balanceDueMinor * (0.2 + rnd() * 0.8))); const p = await A.j.post(`/invoices/${v.id}/payments`, { amountMinor: amt, method: 'cash' }); expect(p.status).toBe(201); pays.push(p.body.payment.id); }
        else if (r < 0.6 && pays.length) await A.j.post(`/invoices/payments/${pays.splice(Math.floor(rnd() * pays.length), 1)[0]}/cancel`, { reason: 'annulation test' });
        else { const l = v.lines[Math.floor(rnd() * 2)]; const q = Math.round((0.2 + rnd() * 1.5) * 1000) / 1000; const c = await credit(A, v.id, [{ sourceLineId: l.id, quantity: q }]); expect([200, 409]).toContain(c.status); }
        await consistent(A, v.id);
      }
    }
  });
});
