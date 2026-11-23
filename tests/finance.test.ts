import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app, authed, binaryParser, login, makeUser, parseXlsx, setupDb, teardownDb } from './helpers.js';
import { J, logisticsCompany, line, plusDays, today, type LCtx } from './sales.helpers.js';
import { EventLog } from '../src/models/logistics.model.js';
import { Customer } from '../src/models/customer.model.js';
import { Supplier } from '../src/models/supplier.model.js';
import { JournalEntry, TreasuryAccount, TreasuryMovement } from '../src/models/finance.model.js';
import { emitDomainEvent } from '../src/services/domain-events.js';
import { withTransaction } from '../src/utils/transaction.js';

let A: LCtx, B: LCtx; let bank: string, cash: string, bankB: string;
const Y = new Date().getUTCFullYear(); const D = plusDays(-2); const ST = plusDays(-1);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Alpha', 'admin@a.test'); B = await logisticsCompany('Beta', 'admin@b.test');
  bank = (await A.j.post('/treasury/accounts', { code: 'BNK1', name: 'Banque principale', type: 'bank', openingBalanceMinor: 1_000_000, iban: 'TN59 0000' })).body.id;
  cash = (await A.j.post('/treasury/accounts', { code: 'CAI1', name: 'Caisse', type: 'cash' })).body.id;
  bankB = (await B.j.post('/treasury/accounts', { code: 'BNK1', name: 'Banque B', type: 'bank', openingBalanceMinor: 500_000 })).body.id;
});
afterAll(teardownDb);

const mkInvoice = async (c: LCtx, lines: object[] = [line(c.products.a19, 1)], extra: object = {}) => { const d = (await c.j.post('/invoices', { customerId: c.customerId, lines, ...extra })).body; const v = await c.j.post(`/invoices/${d.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); return v.body as { id: string; number: string; totals: { totalPayableMinor: number } }; };
const pay = (c: LCtx, id: string, amountMinor: number, account = bank, extra: object = {}) => c.j.post(`/invoices/${id}/payments`, { amountMinor, method: 'transfer', treasuryAccountId: account, ...extra });
const mkPurchase = async (c: LCtx, no: string, qty = 10, price = 10_000, extra: object = {}) => { const d = (await c.j.post('/purchase-invoices', { supplierId: c.supplierId, supplierInvoiceNumber: no, lines: [{ productId: c.products.a19, quantity: qty, unitPriceMinor: price }], ...extra })).body; const v = await c.j.post(`/purchase-invoices/${d.id}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); return v.body as { id: string; number: string; totals: { totalTtcMinor: number } }; };
const supPay = (c: LCtx, allocations: object[], account = bank, extra: object = {}) => c.j.post('/supplier-payments', { supplierId: c.supplierId, treasuryAccountId: account, method: 'transfer', allocations, ...extra });
const balanceOf = async (id: string) => (await TreasuryAccount.findById(id))!.balanceMinor;
const entriesOf = async (c: LCtx, sourceId: string) => (await c.j.get(`/accounting/entries?sourceId=${sourceId}`)).body.items as { journal: string; number: string; totalMinor: number; reversal: boolean; lines: { role: string; debitMinor: number; creditMinor: number; accountCode: string | null }[] }[];
const consistent = async (c: LCtx) => { const r = (await c.j.get('/accounting/consistency')).body; const t = (await c.j.get('/treasury/consistency')).body; return { acc: r, tr: t }; };

describe('comptes de trésorerie', () => {
  it('création, solde d’ouverture, code unique par société, position', async () => {
    expect((await A.j.post('/treasury/accounts', { code: 'BNK1', name: 'Doublon', type: 'bank' })).status).toBe(409);
    const pos = (await A.j.get('/treasury/position')).body; expect(pos).toMatchObject({ bankMinor: 1_000_000, cashMinor: 0, totalMinor: 1_000_000 });
    expect((await A.j.post('/treasury/accounts', { code: 'X', name: 'Mauvais', type: 'bank', openingBalanceMinor: 1.5 })).status).toBe(422);
  });
  it('solde d’ouverture non modifiable une fois le compte mouvementé ; désactivation bloque les mouvements', async () => {
    const acc = (await A.j.post('/treasury/accounts', { code: 'TMP', name: 'Temp', type: 'cash', openingBalanceMinor: 100 })).body.id;
    expect((await A.j.put(`/treasury/accounts/${acc}`, { openingBalanceMinor: 300 })).body.balanceMinor).toBe(300);
    const inv = await mkInvoice(A); expect((await pay(A, inv.id, 1_000, acc)).status).toBe(201);
    expect((await A.j.put(`/treasury/accounts/${acc}`, { openingBalanceMinor: 900 })).status).toBe(409);
    await request(app).patch(`/api/v1/treasury/accounts/${acc}/active`).set(authed(A.token)).send({ isActive: false });
    expect((await pay(A, inv.id, 1_000, acc)).status).toBe(400); // compte inactif
  });
});

describe('comptabilité automatique — factures et avoirs', () => {
  let inv: Awaited<ReturnType<typeof mkInvoice>>;
  it('facture validée → UNE écriture équilibrée au journal des ventes, liée à sa source', async () => {
    inv = await mkInvoice(A);
    const e = await entriesOf(A, inv.id); expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ journal: 'sales', number: expect.stringMatching(/^VTE-\d{6}$/), totalMinor: 119_000, reversal: false });
    const L = Object.fromEntries(e[0]!.lines.map((l) => [l.role, l])); expect(L.customer).toMatchObject({ debitMinor: 119_000 }); expect(L.sales).toMatchObject({ creditMinor: 100_000 }); expect(L.vat_collected).toMatchObject({ creditMinor: 19_000 });
    const sum = e[0]!.lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0); expect(sum).toBe(0);
    const tr = (await A.j.get(`/accounting/trace/${inv.id}`)).body; expect(tr.entries).toHaveLength(1);
  });
  it('TVA multi-taux : une ligne de TVA collectée par groupe ; Σ débit = Σ crédit', async () => {
    const i2 = await mkInvoice(A, [line(A.products.a19, 1), line(A.products.b13, 2), line(A.products.c7, 3)]);
    const e = (await entriesOf(A, i2.id))[0]!; expect(e.lines.filter((l) => l.role === 'vat_collected')).toHaveLength(3);
    expect(e.lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(e.lines.reduce((s, l) => s + l.creditMinor, 0));
    expect(e.totalMinor).toBe(i2.totals.totalPayableMinor);
  });
  it('un brouillon ne génère aucune écriture', async () => {
    const d = (await A.j.post('/invoices', { customerId: A.customerId, lines: [line(A.products.a19, 1)] })).body; expect(await entriesOf(A, d.id)).toHaveLength(0);
  });
  it('avoir validé → écriture inverse ; créance client ajustée ; comptes cohérents', async () => {
    const i = await mkInvoice(A); const before = (await Customer.findById(A.customerId))!.balanceMinor!;
    const cn = await A.j.post(`/invoices/${i.id}/credit-note`, { reason: 'Retour' }); expect(cn.status).toBe(201);
    const v = await A.j.post(`/invoices/${cn.body.id}/validate`); expect(v.status).toBe(200);
    const e = (await entriesOf(A, cn.body.id))[0]!; expect(e).toMatchObject({ journal: 'sales', reversal: true, totalMinor: 119_000 });
    expect(e.lines.find((l) => l.role === 'customer')).toMatchObject({ creditMinor: 119_000, debitMinor: 0 }); expect(e.lines.find((l) => l.role === 'sales')).toMatchObject({ debitMinor: 100_000 });
    expect((await Customer.findById(A.customerId))!.balanceMinor).toBe(before - 119_000);
    const rec = (await A.j.get('/accounting/receivables')).body; expect(rec.totalMinor).toBe(rec.customerBalancesMinor);
    const c = await consistent(A); expect(c.acc.consistent, JSON.stringify(c.acc.issues)).toBe(true);
  });
});

describe('encaissements clients et trésorerie', () => {
  it('encaissements partiels puis total : mouvement + écriture de banque par encaissement, répartition sur échéances, jamais au-delà du dû', async () => {
    const inv = await mkInvoice(A, [line(A.products.a19, 1)], { schedule: [{ dueDate: plusDays(15), percent: 50 }, { dueDate: plusDays(45), percent: 50 }] });
    const b0 = await balanceOf(bank);
    const p1 = await pay(A, inv.id, 40_000); expect(p1.status, JSON.stringify(p1.body)).toBe(201); expect(await balanceOf(bank)).toBe(b0 + 40_000);
    const mv = (await A.j.get(`/treasury/movements?sourceId=${p1.body.payment.id}`)).body.items; expect(mv).toHaveLength(1); expect(mv[0]).toMatchObject({ direction: 'in', amountMinor: 40_000, kind: 'customer_receipt', balanceAfterMinor: b0 + 40_000 });
    const e = (await entriesOf(A, p1.body.payment.id))[0]!; expect(e).toMatchObject({ journal: 'bank', totalMinor: 40_000 }); expect(e.lines.find((l) => l.role === 'bank')).toMatchObject({ debitMinor: 40_000 }); expect(e.lines.find((l) => l.role === 'customer')).toMatchObject({ creditMinor: 40_000 });
    expect(p1.body.invoice).toMatchObject({ paymentStatus: 'partial' });
    const over = await pay(A, inv.id, 80_000); expect(over.status).toBe(409); expect(await balanceOf(bank)).toBe(b0 + 40_000); // refus : aucun mouvement créé
    const p2 = await pay(A, inv.id, 79_000, cash, { method: 'cash' }); expect(p2.body.invoice).toMatchObject({ paymentStatus: 'paid', balanceDueMinor: 0 });
    expect((await entriesOf(A, p2.body.payment.id))[0]!.journal).toBe('cash');
    expect(p2.body.invoice.schedule.map((s: { paidMinor: number }) => s.paidMinor)).toEqual([59_500, 59_500]);
  });
  it('compte de trésorerie obligatoire (société avec comptes) ; compte d’une autre société refusé', async () => {
    const inv = await mkInvoice(A);
    expect((await A.j.post(`/invoices/${inv.id}/payments`, { amountMinor: 1_000, method: 'cash' })).status).toBe(400);
    expect((await pay(A, inv.id, 1_000, bankB)).status).toBe(400);
    expect((await A.j.get(`/invoices/${inv.id}`)).body.paidMinor).toBe(0);
  });
  it('annulation d’un encaissement : mouvement inverse, solde et facture restaurés, écriture d’annulation, une seule fois', async () => {
    const inv = await mkInvoice(A); const b0 = await balanceOf(bank); const cb = (await Customer.findById(A.customerId))!.balanceMinor!;
    const p = (await pay(A, inv.id, 50_000)).body.payment; expect(await balanceOf(bank)).toBe(b0 + 50_000);
    const c = await A.j.post(`/invoices/payments/${p.id}/cancel`, { reason: 'Erreur de saisie' }); expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await balanceOf(bank)).toBe(b0); expect((await Customer.findById(A.customerId))!.balanceMinor).toBe(cb); // cb mesuré avant l'encaissement : retour exact
    expect((await A.j.get(`/invoices/${inv.id}`)).body).toMatchObject({ paidMinor: 0, paymentStatus: 'unpaid' });
    const mv = (await A.j.get(`/treasury/movements?sourceId=${p.id}`)).body.items; expect(mv).toHaveLength(2); expect(mv.find((m: { kind: string }) => m.kind === 'reversal')).toMatchObject({ direction: 'out', amountMinor: 50_000 });
    const es = await entriesOf(A, p.id); expect(es).toHaveLength(2); expect(es.filter((e) => e.reversal)).toHaveLength(1);
    expect((await A.j.post(`/invoices/payments/${p.id}/cancel`, { reason: 'Encore' })).status).toBe(409); expect(await balanceOf(bank)).toBe(b0);
    const cc = await consistent(A); expect(cc.acc.consistent, JSON.stringify(cc.acc.issues)).toBe(true); expect(cc.tr.consistent).toBe(true);
  });
  it('encaissement antidaté dans le futur : refusé ; relevé de compte : ouverture, mouvements, clôture', async () => {
    const st = (await A.j.get(`/treasury/accounts/${bank}/statement`)).body;
    expect(st.openingMinor).toBe(1_000_000); expect(st.closingMinor).toBe(st.account.balanceMinor); expect(st.lines.at(-1).runningMinor).toBe(st.closingMinor);
    expect(st.totalInMinor - st.totalOutMinor).toBe(st.closingMinor - st.openingMinor);
    const x = await request(app).get(`/api/v1/treasury/accounts/${bank}/statement?format=xlsx`).set(authed(A.token)).buffer().parse(binaryParser); expect(x.status).toBe(200); expect((await parseXlsx(x.body as Buffer))[0]).toContain('Libellé');
  });
});

describe('règlements fournisseurs', () => {
  it('facture d’achat validée → écriture au journal des achats (HT + TVA déductible = TTC fournisseur)', async () => {
    const f = await mkPurchase(A, 'F-1001'); expect(f.totals.totalTtcMinor).toBe(119_000);
    const e = (await entriesOf(A, f.id))[0]!; expect(e).toMatchObject({ journal: 'purchases', totalMinor: 119_000, number: expect.stringMatching(/^ACH-/) });
    expect(e.lines.find((l) => l.role === 'purchases')).toMatchObject({ debitMinor: 100_000 }); expect(e.lines.find((l) => l.role === 'vat_deductible')).toMatchObject({ debitMinor: 19_000 }); expect(e.lines.find((l) => l.role === 'supplier')).toMatchObject({ creditMinor: 119_000 });
  });
  it('règlement partiel puis solde ; groupé sur plusieurs factures ; jamais au-delà du reste dû', async () => {
    const f1 = await mkPurchase(A, 'F-2001'); const f2 = await mkPurchase(A, 'F-2002', 5, 10_000); const sb = (await Supplier.findById(A.supplierId))!.balanceMinor!; const b0 = await balanceOf(bank);
    const p1 = await supPay(A, [{ purchaseInvoiceId: f1.id, amountMinor: 50_000 }]); expect(p1.status, JSON.stringify(p1.body)).toBe(201); expect(p1.body.number).toMatch(/^REG-\d{4}-\d{6}$/);
    expect((await A.j.get(`/purchase-invoices/${f1.id}`)).body).toMatchObject({ paidMinor: 50_000, paymentStatus: 'partial', balanceDueMinor: 69_000 });
    expect(await balanceOf(bank)).toBe(b0 - 50_000); expect((await Supplier.findById(A.supplierId))!.balanceMinor).toBe(sb - 50_000);
    expect((await supPay(A, [{ purchaseInvoiceId: f1.id, amountMinor: 69_001 }])).status).toBe(409);
    const p2 = await supPay(A, [{ purchaseInvoiceId: f1.id, amountMinor: 69_000 }, { purchaseInvoiceId: f2.id, amountMinor: 20_000 }]); expect(p2.status).toBe(201); expect(p2.body.amountMinor).toBe(89_000);
    expect((await A.j.get(`/purchase-invoices/${f1.id}`)).body.paymentStatus).toBe('paid'); expect((await A.j.get(`/purchase-invoices/${f2.id}`)).body).toMatchObject({ paymentStatus: 'partial', paidMinor: 20_000 });
    const e = (await entriesOf(A, p2.body.id))[0]!; expect(e).toMatchObject({ journal: 'bank', totalMinor: 89_000 }); expect(e.lines.find((l) => l.role === 'supplier')).toMatchObject({ debitMinor: 89_000 });
    expect((await supPay(A, [{ purchaseInvoiceId: f1.id, amountMinor: 1 }, { purchaseInvoiceId: f1.id, amountMinor: 1 }])).status).toBe(400); // doublon d'affectation
  });
  it('facture non validée / d’un autre fournisseur / d’une autre société : refusées', async () => {
    const d = (await A.j.post('/purchase-invoices', { supplierId: A.supplierId, supplierInvoiceNumber: 'F-DRAFT', lines: [{ productId: A.products.a19, quantity: 1, unitPriceMinor: 1_000 }] })).body;
    expect((await supPay(A, [{ purchaseInvoiceId: d.id, amountMinor: 100 }])).status).toBe(409);
    const fb = await mkPurchase(B, 'FB-1'); expect((await supPay(A, [{ purchaseInvoiceId: fb.id, amountMinor: 100 }])).status).toBe(400);
  });
  it('fonds insuffisants : refus atomique (facture, solde fournisseur et compte inchangés) et événement en échec journalisé', async () => {
    const f = await mkPurchase(A, 'F-3001'); const sb = (await Supplier.findById(A.supplierId))!.balanceMinor!;
    const r = await supPay(A, [{ purchaseInvoiceId: f.id, amountMinor: 100_000 }], cash); expect(r.status).toBe(409); expect(r.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await A.j.get(`/purchase-invoices/${f.id}`)).body.paidMinor).toBe(0); expect((await Supplier.findById(A.supplierId))!.balanceMinor).toBe(sb);
    const failed = (await A.j.get('/accounting/events?status=failed')).body; expect(failed.items.some((e: { event: string; handler: string; error: string }) => e.event === 'supplierPayment.recorded' && e.handler === 'treasury' && /insuffisant/i.test(e.error))).toBe(true);
    const ev = failed.items.find((e: { event: string }) => e.event === 'supplierPayment.recorded'); expect((await A.j.post(`/accounting/events/${ev.id}/retry`)).status).toBe(409); // rollback complet : rien à rejouer
  });
  it('découvert autorisé si le compte le permet', async () => {
    const od = (await A.j.post('/treasury/accounts', { code: 'OD', name: 'Compte à découvert', type: 'bank', allowNegative: true })).body.id; const f = await mkPurchase(A, 'F-4001');
    expect((await supPay(A, [{ purchaseInvoiceId: f.id, amountMinor: 10_000 }], od)).status).toBe(201); expect(await balanceOf(od)).toBe(-10_000);
  });
  it('annulation d’un règlement : facture, solde fournisseur et trésorerie restaurés ; contrôle des soldes fournisseurs', async () => {
    const f = await mkPurchase(A, 'F-5001'); const sb = (await Supplier.findById(A.supplierId))!.balanceMinor!; const b0 = await balanceOf(bank);
    const p = (await supPay(A, [{ purchaseInvoiceId: f.id, amountMinor: 30_000 }])).body;
    const c = await A.j.post(`/supplier-payments/${p.id}/cancel`, { reason: 'Chèque rejeté' }); expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await balanceOf(bank)).toBe(b0); expect((await Supplier.findById(A.supplierId))!.balanceMinor).toBe(sb); expect((await A.j.get(`/purchase-invoices/${f.id}`)).body).toMatchObject({ paidMinor: 0, paymentStatus: 'unpaid' });
    expect((await A.j.post(`/supplier-payments/${p.id}/cancel`, { reason: 'Encore' })).status).toBe(409);
    const pay2 = (await A.j.get('/accounting/payables')).body; expect(pay2.totalMinor).toBe(pay2.supplierBalancesMinor);
    const cc = await consistent(A); expect(cc.acc.consistent, JSON.stringify(cc.acc.issues)).toBe(true);
  });
});

describe('virements internes', () => {
  it('atomique : deux mouvements liés + deux écritures ; soldes mis à jour ; annulation par mouvements inverses', async () => {
    const b0 = await balanceOf(bank); const c0 = await balanceOf(cash);
    const t = await A.j.post('/treasury/transfers', { fromAccountId: bank, toAccountId: cash, amountMinor: 70_000, date: today() }); expect(t.status, JSON.stringify(t.body)).toBe(201); expect(t.body.number).toMatch(/^VIR-/);
    expect(await balanceOf(bank)).toBe(b0 - 70_000); expect(await balanceOf(cash)).toBe(c0 + 70_000);
    expect((await A.j.get(`/treasury/movements?sourceId=${t.body.id}`)).body.items).toHaveLength(2); expect(await entriesOf(A, t.body.id)).toHaveLength(2);
    expect((await A.j.post(`/treasury/transfers/${t.body.id}/cancel`, { reason: 'Erreur' })).status).toBe(200); expect(await balanceOf(bank)).toBe(b0); expect(await balanceOf(cash)).toBe(c0);
    expect((await A.j.post(`/treasury/transfers/${t.body.id}/cancel`, { reason: 'Encore' })).status).toBe(409);
  });
  it('refus : même compte, fonds insuffisants (rien n’est créé), compte d’une autre société', async () => {
    const b0 = await balanceOf(bank); const n = await TreasuryMovement.countDocuments({});
    expect((await A.j.post('/treasury/transfers', { fromAccountId: bank, toAccountId: bank, amountMinor: 1 })).status).toBe(400);
    expect((await A.j.post('/treasury/transfers', { fromAccountId: cash, toAccountId: bank, amountMinor: 9_000_000 })).status).toBe(409);
    expect((await A.j.post('/treasury/transfers', { fromAccountId: bank, toAccountId: bankB, amountMinor: 1 })).status).toBe(404);
    expect(await balanceOf(bank)).toBe(b0); expect(await TreasuryMovement.countDocuments({})).toBe(n);
  });
});

describe('rapprochement bancaire', () => {
  let acc: string; let invId: string; let p1: string, p2: string;
  it('préparation : compte dédié, deux encaissements antérieurs', async () => {
    acc = (await A.j.post('/treasury/accounts', { code: 'RAP', name: 'Compte rapprochement', type: 'bank', openingBalanceMinor: 10_000 })).body.id; invId = (await mkInvoice(A, [line(A.products.a19, 3)])).id;
    p1 = (await pay(A, invId, 100_000, acc, { paidAt: D })).body.payment.id; p2 = (await pay(A, invId, 50_000, acc, { paidAt: D })).body.payment.id; expect(await balanceOf(acc)).toBe(160_000);
  });
  it('écart ≠ 0 : refus 422, rien n’est verrouillé ; solde exact : rapproché', async () => {
    const c = (await A.j.get(`/treasury/reconciliations/candidates/${acc}`)).body; expect(c).toMatchObject({ previousBalanceMinor: 10_000 }); expect(c.items).toHaveLength(2);
    const ids = c.items.map((m: { id: string }) => m.id);
    const bad = await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: ST, statementBalanceMinor: 159_000, movementIds: ids }); expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('RECONCILIATION_DIFFERENCE'); expect(bad.body.error.details).toMatchObject({ differenceMinor: -1000, previousBalanceMinor: 10_000, totalMinor: 150_000 });
    expect((await A.j.get(`/treasury/movements?accountId=${acc}&reconciled=true`)).body.total).toBe(0);
    const partial = await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: ST, statementBalanceMinor: 110_000, movementIds: [ids[0]] }); expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    expect(partial.body).toMatchObject({ number: expect.stringMatching(/^RAP-/), previousBalanceMinor: 10_000, totalMinor: 100_000 });
  });
  it('un mouvement rapproché ne se modifie plus : annulation de l’opération refusée (rien ne change), mouvement non rapproché reste annulable', async () => {
    const mv = (await A.j.get(`/treasury/movements?accountId=${acc}`)).body.items as { id: string; reconciled: boolean; source: { id: string } }[];
    const rec = mv.find((m) => m.reconciled)!; const open = mv.find((m) => !m.reconciled)!; const b0 = await balanceOf(acc);
    const r = await A.j.post(`/invoices/payments/${rec.source.id}/cancel`, { reason: 'Tentative rétroactive' }); expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/rapproch/i);
    expect(await balanceOf(acc)).toBe(b0); expect((await A.j.get(`/invoices/${invId}`)).body.paidMinor).toBe(150_000); // la transaction a tout annulé
    expect(open.reconciled).toBe(false);
  });
  it('période verrouillée : aucun mouvement daté ≤ dernier relevé ; relevé suivant doit être postérieur ; déjà rapproché refusé', async () => {
    const i = await mkInvoice(A); expect((await pay(A, i.id, 1_000, acc, { paidAt: plusDays(-3) })).status).toBe(409);
    expect((await pay(A, i.id, 1_000, acc, { paidAt: ST })).status).toBe(409);
    const ids = ((await A.j.get(`/treasury/reconciliations/candidates/${acc}`)).body.items as { id: string }[]).map((m) => m.id);
    expect((await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: ST, statementBalanceMinor: 160_000, movementIds: ids })).status).toBe(409); // date non postérieure
    const first = (await A.j.get(`/treasury/reconciliations?accountId=${acc}`)).body.items[0]; const det = (await A.j.get(`/treasury/reconciliations/${first.id}`)).body; expect(det.movements).toHaveLength(1);
    expect((await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: today(), statementBalanceMinor: 110_000, movementIds: [det.movements[0].id] })).status).toBe(409); // mouvement déjà rapproché
    expect((await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: plusDays(3), statementBalanceMinor: 1, movementIds: ids })).status).toBe(400);
  });
  it('deuxième rapprochement : part du dernier solde rapproché ; compte caisse refusé ; autre société : 404', async () => {
    const ids = ((await A.j.get(`/treasury/reconciliations/candidates/${acc}`)).body.items as { id: string }[]).map((m) => m.id);
    const r = await A.j.post('/treasury/reconciliations', { accountId: acc, statementDate: today(), statementBalanceMinor: 160_000, movementIds: ids }); expect(r.status, JSON.stringify(r.body)).toBe(201); expect(r.body.previousBalanceMinor).toBe(110_000);
    expect((await A.j.post('/treasury/reconciliations', { accountId: cash, statementDate: today(), statementBalanceMinor: 0, movementIds: [ids[0]!] })).status).toBe(400);
    expect((await B.j.post('/treasury/reconciliations', { accountId: acc, statementDate: today(), statementBalanceMinor: 0, movementIds: [ids[0]!] })).status).toBe(404);
    expect(p1 && p2).toBeTruthy();
  });
});

describe('dépenses', () => {
  let cat: string; let creator: { token: string }; let eid: string;
  const body = (extra: object = {}) => ({ categoryId: cat, amountMinor: 25_000, date: D, beneficiary: 'STEG', method: 'transfer', treasuryAccountId: bank, ...extra });
  it('catégories : création, doublon refusé ; saisie → brouillon numéroté DEP-', async () => {
    cat = (await A.j.post('/expense-categories', { name: 'Électricité', accountCode: '6063' })).body.id; expect((await A.j.post('/expense-categories', { name: 'Électricité' })).status).toBe(409);
    await makeUser(A.companyId, 'saisie@a.test', ['expenses:view', 'expenses:create', 'expenses:update']); creator = await login('saisie@a.test');
    const e = await J(creator.token).post('/expenses', body()); expect(e.status, JSON.stringify(e.body)).toBe(201); expect(e.body).toMatchObject({ number: `DEP-${Y}-000001`, status: 'draft', editable: true }); eid = e.body.id;
    expect((await J(creator.token).post('/expenses', body({ amountMinor: 0 }))).status).toBe(422); expect((await J(creator.token).post('/expenses', body({ date: plusDays(5) }))).status).toBe(400);
  });
  it('workflow : modification du brouillon, justificatif sécurisé, soumission', async () => {
    const c = J(creator.token); expect((await c.put(`/expenses/${eid}`, body({ amountMinor: 30_000 }))).body.amountMinor).toBe(30_000);
    const up = await request(app).post(`/api/v1/expenses/${eid}/attachments`).set(authed(creator.token)).attach('file', pdf, 'facture.pdf'); expect(up.status, JSON.stringify(up.body)).toBe(201); expect(up.body.attachments).toHaveLength(1);
    expect((await request(app).post(`/api/v1/expenses/${eid}/attachments`).set(authed(creator.token)).attach('file', Buffer.from('MZ'), 'virus.exe')).status).toBe(400);
    expect((await request(app).post(`/api/v1/expenses/${eid}/attachments`).set(authed(creator.token)).attach('file', Buffer.from('pas un pdf'), 'faux.pdf')).status).toBe(400);
    const dl = await request(app).get(`/api/v1/expenses/${eid}/attachments/${up.body.attachments[0].id}`).set(authed(creator.token)).buffer().parse(binaryParser); expect(dl.status).toBe(200); expect((dl.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await c.post(`/expenses/${eid}/submit`)).body.status).toBe('submitted'); expect((await c.put(`/expenses/${eid}`, body())).status).toBe(409);
  });
  it('séparation des tâches : le créateur ne valide pas sa dépense ; droit de validation requis', async () => {
    expect((await J(creator.token).post(`/expenses/${eid}/validate`)).status).toBe(403); // pas la permission
    await makeUser(A.companyId, 'self@a.test', ['expenses:view', 'expenses:create', 'expenses:update', 'expenses:validate']); const self = await login('self@a.test');
    const mine = (await J(self.token).post('/expenses', body())).body.id; await J(self.token).post(`/expenses/${mine}/submit`);
    const r = await J(self.token).post(`/expenses/${mine}/validate`); expect(r.status).toBe(403); expect(r.body.error.message).toMatch(/séparation/i);
    expect((await A.j.put('/accounting/settings', { allowExpenseSelfValidation: true })).body.allowExpenseSelfValidation).toBe(true);
    expect((await J(self.token).post(`/expenses/${mine}/validate`)).status).toBe(200); await A.j.put('/accounting/settings', { allowExpenseSelfValidation: false });
  });
  it('validation : mouvement de trésorerie (sortie) + écriture avec le compte de la catégorie ; dépense validée non modifiable', async () => {
    const b0 = await balanceOf(bank); const v = await A.j.post(`/expenses/${eid}/validate`); expect(v.status, JSON.stringify(v.body)).toBe(200); expect(v.body.status).toBe('validated'); expect(await balanceOf(bank)).toBe(b0 - 30_000);
    const mv = (await A.j.get(`/treasury/movements?sourceId=${eid}`)).body.items; expect(mv).toHaveLength(1); expect(mv[0]).toMatchObject({ direction: 'out', kind: 'expense', amountMinor: 30_000 });
    const e = (await entriesOf(A, eid))[0]!; expect(e.journal).toBe('bank'); expect(e.lines.find((l) => l.role === 'expense')).toMatchObject({ debitMinor: 30_000, accountCode: '6063' });
    expect((await A.j.put(`/expenses/${eid}`, body({ amountMinor: 1 }))).status).toBe(409); expect((await A.j.del(`/expenses/${eid}`)).status).toBe(409);
    expect((await request(app).post(`/api/v1/expenses/${eid}/attachments`).set(authed(A.token)).attach('file', pdf, 'x.pdf')).status).toBe(409);
    expect((await A.j.post(`/expenses/${eid}/validate`)).status).toBe(409); expect((await A.j.post(`/expenses/${eid}/reject`, { reason: 'trop tard' })).status).toBe(409);
    expect((await A.j.get(`/expenses/${eid}`)).body.attachments).toHaveLength(1);
  });
  it('compte de trésorerie requis à la validation ; rejet avec motif puis correction et resoumission', async () => {
    const e = (await A.j.post('/expenses', body({ treasuryAccountId: undefined, beneficiary: 'Fournisseur sans compte' }))).body; await A.j.post(`/expenses/${e.id}/submit`);
    const w = await request(app).post(`/api/v1/expenses/${e.id}/validate`).set(authed((await (async () => { await makeUser(A.companyId, 'val@a.test', ['expenses:validate', 'expenses:view']); return login('val@a.test'); })()).token)); expect(w.status).toBe(400);
    expect((await A.j.post(`/expenses/${e.id}/reject`, { reason: 'Compte à préciser' })).body).toMatchObject({ status: 'rejected', rejectReason: 'Compte à préciser', editable: true });
    expect((await A.j.put(`/expenses/${e.id}`, body({ beneficiary: 'Corrigé' }))).body.status).toBe('draft');
  });
  it('annulation d’une dépense validée : mouvement inverse + écriture d’annulation ; fonds insuffisants → validation refusée', async () => {
    const b0 = await balanceOf(bank); const r = await A.j.post(`/expenses/${eid}/cancel`, { reason: 'Doublon' }); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.status).toBe('cancelled'); expect(await balanceOf(bank)).toBe(b0 + 30_000);
    expect((await entriesOf(A, eid)).filter((e) => e.reversal)).toHaveLength(1); expect((await A.j.post(`/expenses/${eid}/cancel`, { reason: 'Encore une fois' })).status).toBe(409);
    const big = (await A.j.post('/expenses', body({ amountMinor: 99_000_000, treasuryAccountId: cash }))).body.id; await A.j.post(`/expenses/${big}/submit`);
    const g = await A.j.post(`/expenses/${big}/validate`); expect([403, 409]).toContain(g.status); // créateur = validateur (403) ou fonds insuffisants (409)
    await A.j.put('/accounting/settings', { allowExpenseSelfValidation: true }); const g2 = await A.j.post(`/expenses/${big}/validate`); expect(g2.status).toBe(409); expect(g2.body.error.code).toBe('INSUFFICIENT_FUNDS'); expect((await A.j.get(`/expenses/${big}`)).body.status).toBe('submitted');
    await A.j.put('/accounting/settings', { allowExpenseSelfValidation: false });
  });
  it('synthèse par catégorie / mois (validées uniquement) et export', async () => {
    const s = (await A.j.get('/expenses/summary')).body; expect(s.byCategory.every((c: { totalMinor: number }) => c.totalMinor >= 0)).toBe(true);
    const x = await request(app).get('/api/v1/expenses/export?format=csv').set(authed(A.token)).buffer().parse(binaryParser); expect(x.status).toBe(200);
  });
});

describe('comptabilité : paramétrage, journaux, créances / dettes', () => {
  it('correspondance rôle → code configurable (aucun code par défaut) ; appliquée aux nouvelles écritures seulement', async () => {
    const before = await mkInvoice(A); expect((await entriesOf(A, before.id))[0]!.lines.every((l) => l.accountCode === null)).toBe(true);
    const s = await A.j.put('/accounting/settings', { accounts: { customer: '411', sales: '707', vat_collected: '4457' } }); expect(s.status).toBe(200); expect(s.body.roles.find((r: { role: string }) => r.role === 'customer').accountCode).toBe('411');
    const after = await mkInvoice(A); expect((await entriesOf(A, after.id))[0]!.lines.find((l) => l.role === 'customer')!.accountCode).toBe('411');
    expect((await entriesOf(A, before.id))[0]!.lines.every((l) => l.accountCode === null)).toBe(true); // écritures passées intactes
    expect((await A.j.put('/accounting/settings', { accounts: { bidon: '1' } })).status).toBe(422);
  });
  it('journaux : filtres, numérotation continue par journal, centralisateur équilibré, export', async () => {
    const sales = (await A.j.get('/accounting/entries?journal=sales&limit=100')).body; expect(sales.items.every((e: { journal: string }) => e.journal === 'sales')).toBe(true);
    const nums = sales.items.map((e: { number: string }) => Number(e.number.slice(4))).sort((a: number, b: number) => a - b); expect(nums).toEqual(nums.map((_: number, i: number) => i + 1)); // pas de trou
    const c = (await A.j.get('/accounting/centralizer')).body; expect(c.debitMinor).toBe(c.creditMinor); expect(c.journals.map((j: { journal: string }) => j.journal)).toEqual(['sales', 'purchases', 'cash', 'bank']);
    const x = await request(app).get('/api/v1/accounting/entries/export?format=xlsx&journal=bank').set(authed(A.token)).buffer().parse(binaryParser); expect(x.status).toBe(200); expect((await parseXlsx(x.body as Buffer))[0]).toContain('Débit');
    const one = (await A.j.get(`/accounting/entries/${sales.items[0].id}`)).body; expect(one.number).toBe(sales.items[0].number);
  });
  it('créances clients : ancienneté par échéance, total = soldes clients ; fiche client', async () => {
    const i = await mkInvoice(A, [line(A.products.a19, 1)], { schedule: [{ dueDate: plusDays(10), percent: 100 }] });
    const now = (await A.j.get('/accounting/receivables')).body; expect(now.totalMinor).toBe(now.customerBalancesMinor); expect(now.buckets.notDue).toBeGreaterThanOrEqual(119_000);
    const late = (await A.j.get(`/accounting/receivables?asOf=${plusDays(80)}`)).body; expect(late.buckets.d61_90).toBeGreaterThanOrEqual(119_000); expect(late.totalMinor).toBe(now.totalMinor);
    const row = late.customers[0].invoices.find((x: { id: string }) => x.id === i.id); expect(row.lateDays).toBe(70);
    expect((await A.j.get(`/accounting/customers/${A.customerId}/statement`)).body.balanceMinor).toBe(now.customerBalancesMinor);
  });
  it('dettes fournisseurs : ancienneté et fiche fournisseur', async () => {
    await mkPurchase(A, 'F-AGE', 1, 10_000, { dueDate: plusDays(-40) });
    const p = (await A.j.get('/accounting/payables')).body; expect(p.buckets.d31_60).toBeGreaterThanOrEqual(11_900); expect(p.totalMinor).toBe(p.supplierBalancesMinor);
    expect((await A.j.get(`/accounting/suppliers/${A.supplierId}/statement`)).body.documents.length).toBeGreaterThan(0);
  });
  it('écritures et mouvements immuables : aucune route de modification ou de suppression', async () => {
    const e = (await A.j.get('/accounting/entries?limit=1')).body.items[0]; const m = (await A.j.get('/treasury/movements?limit=1')).body.items[0];
    for (const [meth, url] of [['put', `/accounting/entries/${e.id}`], ['delete', `/accounting/entries/${e.id}`], ['put', `/treasury/movements/${m.id}`], ['delete', `/treasury/movements/${m.id}`], ['patch', `/treasury/movements/${m.id}`]] as const)
      expect((await request(app)[meth](`/api/v1${url}`).set(authed(A.token)).send({})).status, `${meth} ${url}`).toBe(404);
  });
});

describe('idempotence, reprise et cohérence', () => {
  it('jamais deux écritures pour un même événement : réémission directe (même sans journal d’événements)', async () => {
    const inv = await mkInvoice(A); const n = await JournalEntry.countDocuments({ 'source.id': inv.id });
    await EventLog.deleteMany({ documentId: inv.id }); // pire cas : journal perdu
    await withTransaction((session) => emitDomainEvent('invoice.validated', { companyId: A.companyId, documentId: new mongoose.Types.ObjectId(inv.id), session }));
    await withTransaction((session) => emitDomainEvent('invoice.validated', { companyId: A.companyId, documentId: new mongoose.Types.ObjectId(inv.id), session }));
    expect(await JournalEntry.countDocuments({ 'source.id': inv.id })).toBe(n); expect(n).toBe(1);
  });
  it('réconciliation : document validé sans écriture (antérieur à la Phase 6) → rejoué UNE fois ; second passage : rien', async () => {
    const inv = await mkInvoice(A); await JournalEntry.deleteMany({ 'source.id': inv.id }); await EventLog.deleteMany({ documentId: inv.id });
    expect((await A.j.get('/accounting/consistency')).body.issues.some((i: { type: string }) => i.type === 'missing_entry')).toBe(true);
    const r = (await A.j.post('/accounting/reconcile')).body; expect(r.replayed.some((x: { number: string }) => x.number === inv.number)).toBe(true); expect(r.failed).toEqual([]);
    expect(await JournalEntry.countDocuments({ 'source.id': inv.id })).toBe(1);
    const r2 = (await A.j.post('/accounting/reconcile')).body; expect(r2.replayed).toEqual([]); expect(r2.accounting.consistent, JSON.stringify(r2.accounting.issues)).toBe(true); expect(r2.treasury.consistent).toBe(true);
  });
  it('reprise d’un événement échoué sur document existant : retry → traité, écriture créée une fois', async () => {
    const mv = (await TreasuryMovement.findOne({ companyId: A.companyId, kind: 'customer_receipt' }))!; await JournalEntry.deleteMany({ eventKey: `treasuryMovement.recorded:${mv._id}` }); await EventLog.deleteMany({ documentId: mv._id });
    const log = await EventLog.create({ companyId: A.companyId, event: 'treasuryMovement.recorded', documentId: mv._id, handler: 'accounting', key: `treasuryMovement.recorded:${mv._id}:accounting`, status: 'failed', error: 'simulé', attempts: 1 });
    const r = await A.j.post(`/accounting/events/${log._id}/retry`); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.status).toBe('processed');
    expect(await JournalEntry.countDocuments({ eventKey: `treasuryMovement.recorded:${mv._id}` })).toBe(1);
  });
  it('contrôles détectent une dérive : solde de compte falsifié signalé', async () => {
    await TreasuryAccount.updateOne({ _id: cash }, { $inc: { balanceMinor: 7 } });
    const c = (await A.j.get('/treasury/consistency')).body; expect(c.consistent).toBe(false); expect(c.mismatches[0]).toMatchObject({ code: 'CAI1', balanceMinor: expect.any(Number) });
    await TreasuryAccount.updateOne({ _id: cash }, { $inc: { balanceMinor: -7 } }); expect((await A.j.get('/treasury/consistency')).body.consistent).toBe(true);
  });
  it('cohérence globale : Σ débits = Σ crédits, soldes clients / fournisseurs / comptes = écritures = mouvements', async () => {
    const c = await consistent(A); expect(c.acc.consistent, JSON.stringify(c.acc.issues)).toBe(true); expect(c.tr.consistent).toBe(true);
    const sums = await TreasuryAccount.find({ companyId: A.companyId }).lean(); for (const a of sums) { const mv = await TreasuryMovement.find({ accountId: a._id }).lean(); expect(a.balanceMinor).toBe((a.openingBalanceMinor ?? 0) + mv.reduce((s, m) => s + (m.direction === 'in' ? m.amountMinor : -m.amountMinor), 0)); }
  });
});

describe('concurrence et transactions', () => {
  it('encaissements simultanés sur une facture : jamais plus que le dû ; trésorerie = encaissements acceptés', async () => {
    const inv = await mkInvoice(A); const acc = (await A.j.post('/treasury/accounts', { code: 'CONC', name: 'Concurrence', type: 'bank' })).body.id;
    const rs = await Promise.all(Array.from({ length: 6 }, () => pay(A, inv.id, 30_000, acc))); const ok = rs.filter((r) => r.status === 201).length;
    expect(ok).toBeLessThanOrEqual(3); expect(ok).toBeGreaterThanOrEqual(1); expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect((await A.j.get(`/invoices/${inv.id}`)).body.paidMinor).toBe(ok * 30_000); expect(await balanceOf(acc)).toBe(ok * 30_000);
    expect(await TreasuryMovement.countDocuments({ accountId: acc })).toBe(ok); expect(await JournalEntry.countDocuments({ 'lines.treasuryAccountId': new mongoose.Types.ObjectId(acc) })).toBe(ok);
  });
  it('sorties simultanées : le solde ne devient jamais négatif (compte sans découvert)', async () => {
    const acc = (await A.j.post('/treasury/accounts', { code: 'LIM', name: 'Limité', type: 'bank', openingBalanceMinor: 100_000 })).body.id;
    const rs = await Promise.all(Array.from({ length: 6 }, () => A.j.post('/treasury/transfers', { fromAccountId: acc, toAccountId: cash, amountMinor: 30_000, date: today() }))); const ok = rs.filter((r) => r.status === 201).length;
    expect(ok).toBeLessThanOrEqual(3); expect(await balanceOf(acc)).toBe(100_000 - ok * 30_000); expect(await balanceOf(acc)).toBeGreaterThanOrEqual(0);
    const cc = await consistent(A); expect(cc.tr.consistent).toBe(true); expect(cc.acc.consistent, JSON.stringify(cc.acc.issues)).toBe(true);
  });
  it('règlements fournisseurs simultanés sur une facture : jamais au-delà du reste dû', async () => {
    const f = await mkPurchase(A, 'F-CONC'); const rs = await Promise.all(Array.from({ length: 5 }, () => supPay(A, [{ purchaseInvoiceId: f.id, amountMinor: 40_000 }]))); const ok = rs.filter((r) => r.status === 201).length;
    expect(ok).toBeLessThanOrEqual(2); expect((await A.j.get(`/purchase-invoices/${f.id}`)).body.paidMinor).toBe(ok * 40_000);
    const cc = await consistent(A); expect(cc.acc.consistent, JSON.stringify(cc.acc.issues)).toBe(true);
  });
});

describe('isolation entre sociétés', () => {
  it('B ne voit ni les comptes, mouvements, écritures, dépenses, règlements de A', async () => {
    expect((await B.j.get('/treasury/accounts')).body.map((a: { id: string }) => a.id)).toEqual([bankB]);
    expect((await B.j.get('/treasury/movements')).body.total).toBe(0); const aIds = new Set((await A.j.get('/accounting/entries?limit=100')).body.items.map((x: { id: string }) => x.id)); expect((await B.j.get('/accounting/entries?limit=100')).body.items.some((x: { id: string }) => aIds.has(x.id))).toBe(false); expect((await B.j.get('/expenses')).body.total).toBe(0); expect((await B.j.get('/supplier-payments')).body.total).toBe(0);
    const e = (await A.j.get('/accounting/entries?limit=1')).body.items[0]; expect((await B.j.get(`/accounting/entries/${e.id}`)).status).toBe(404);
    const mv = (await A.j.get('/treasury/movements?limit=1')).body.items[0]; expect((await B.j.get(`/treasury/accounts/${mv.accountId}/statement`)).status).toBe(404);
    const ex = (await A.j.get('/expenses?limit=1')).body.items[0]; expect((await B.j.get(`/expenses/${ex.id}`)).status).toBe(404); expect((await B.j.post(`/expenses/${ex.id}/cancel`, { reason: 'intrus' })).status).toBe(404);
    expect((await A.j.get(`/expenses/${ex.id}`)).body.status).toBe(ex.status);
  });
  it('encaissement / règlement / virement / dépense de B vers un compte de A : refusés ; comptabilité de B indépendante', async () => {
    const inv = await mkInvoice(B); expect((await pay(B, inv.id, 1_000, bank)).status).toBe(400);
    expect((await pay(B, inv.id, 1_000, bankB)).status).toBe(201);
    const cB = await consistent(B); expect(cB.acc.consistent, JSON.stringify(cB.acc.issues)).toBe(true); expect(cB.tr.consistent).toBe(true);
    expect((await B.j.get('/accounting/entries?journal=bank')).body.total).toBe(1);
  });
});

describe('permissions et audit', () => {
  it('sans jeton : 401 ; sans permission : 403 sur chaque famille', async () => {
    expect((await request(app).get('/api/v1/treasury/accounts')).status).toBe(401); expect((await request(app).get('/api/v1/accounting/entries')).status).toBe(401);
    await makeUser(A.companyId, 'ro@a.test', ['treasury:view', 'accounting:view', 'expenses:view']); const ro = J((await login('ro@a.test')).token);
    expect((await ro.get('/treasury/accounts')).status).toBe(200); expect((await ro.get('/accounting/entries')).status).toBe(200); expect((await ro.get('/expenses')).status).toBe(200);
    expect((await ro.post('/treasury/accounts', { code: 'Z', name: 'Zz', type: 'cash' })).status).toBe(403); expect((await ro.post('/treasury/transfers', { fromAccountId: bank, toAccountId: cash, amountMinor: 1 })).status).toBe(403);
    expect((await ro.post('/supplier-payments', {})).status).toBe(403); expect((await ro.post('/treasury/reconciliations', {})).status).toBe(403); expect((await ro.put('/accounting/settings', {})).status).toBe(403);
    expect((await ro.post('/accounting/reconcile')).status).toBe(403); expect((await ro.post('/expenses', {})).status).toBe(403); expect((await ro.post('/expense-categories', { name: 'Nouvelle' })).status).toBe(403);
    await makeUser(A.companyId, 'none@a.test', ['customers:view']); const none = J((await login('none@a.test')).token); expect((await none.get('/treasury/position')).status).toBe(403); expect((await none.get('/accounting/receivables')).status).toBe(403);
    const inv = await mkInvoice(A); await makeUser(A.companyId, 'cash@a.test', ['invoices:view']); const noPay = J((await login('cash@a.test')).token); expect((await pay({ j: noPay } as never, inv.id, 1)).status).toBe(403);
  });
  it('opérations financières sensibles auditées', async () => {
    const { AuditLog } = await import('../src/models/audit-log.model.js'); const actions = (await AuditLog.find({ companyId: A.companyId }).lean()).map((a) => `${a.resource}:${a.action}`);
    for (const k of ['treasury-account:create', 'treasury-transfer:create', 'treasury-transfer:cancel', 'treasury-reconciliation:reconcile', 'supplier-payment:create', 'supplier-payment:cancel', 'expense:create', 'expense:validate', 'expense:cancel', 'expense:submit', 'expense:upload-attachment', 'accounting-settings:update', 'accounting:reconcile']) expect(actions, k).toContain(k);
  });
});
