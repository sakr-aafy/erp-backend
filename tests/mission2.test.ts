/**
 * Mission 2 (« Autres modifications », pages 6 à 8) : cycle Devis accepté → Proforma → Bon(s) de livraison → Facture(s),
 * stock à la validation du BL, créance à la validation de la facture, répartition des remises, annulations, retours, avoirs,
 * numéros de série, documents associés, concurrence, sécurité et migration.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binaryParser, login, makeUser, pdfText, setupDb, teardownDb } from './helpers.js';
import { J, acceptQuote, api, levelOf, line, logisticsCompany, quoteBody, stockIn, type LCtx } from './sales.helpers.js';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Customer } from '../src/models/customer.model.js';
import { JournalEntry } from '../src/models/finance.model.js';
import { StockMovement } from '../src/models/logistics.model.js';
import { ProductSerial } from '../src/models/product.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../src/models/sales.model.js';
import { migrateMission2 } from '../src/modules/migrations/mission2.migration.js';

type Any = Record<string, any>;
let A: LCtx, B: LCtx; let CNC: string, PART: string, TOOL: string, SVC: string;
let seq = 0;

const mkProduct = async (c: LCtx, reference: string, vatRateCode = 'T19', salePriceMinor = 100_000, extra: object = {}) => {
  const r = await c.j.post('/products', { reference, name: `Article ${reference}`, unitId: c.unitId, vatRateCode, purchasePriceMinor: 1000, salePriceMinor, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string;
};
const ok = (r: { status: number; body: Any }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const newCustomer = async (c: LCtx = A) => ok(await c.j.post('/customers', { name: `Client cycle ${++seq}`, subjectToWithholding: false }), 201).id as string;
/** Proforma saisie directement (même parcours qu'issue d'un devis). */
const proforma = async (lines: object[], extra: object = {}, customerId?: string) => ok(await A.j.post('/proformas', quoteBody({ ...A, customerId: customerId ?? A.customerId }, lines, extra)), 201);
/** Devis accepté puis converti. */
const fromQuote = async (lines: object[], extra: object = {}, customerId?: string) => {
  const q = ok(await A.j.post('/quotations', quoteBody({ ...A, customerId: customerId ?? A.customerId }, lines, extra)), 201);
  await acceptQuote(A.j, q.id); const c = ok(await A.j.post(`/quotations/${q.id}/convert-proforma`), 201);
  return { quote: q, proforma: ok(await A.j.get(`/proformas/${c.proformaId}`)) };
};
const draftBl = (p: Any, quantities: number[], extra: object = {}) => A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, warehouseId: A.w1, ...extra,
  lines: quantities.map((q, i) => ({ sourceLineId: p.lines[i].id, quantity: q })).filter((l) => l.quantity > 0) });
const validateBl = (id: string, body: object = {}) => A.j.post(`/delivery-notes/${id}/validate`, body);
const delivered = async (p: Any, quantities: number[], extra: object = {}) => { const b = ok(await draftBl(p, quantities, extra), 201); return ok(await validateBl(b.id)); };
const billing = (ids: string[], extra: object = {}) => A.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: ids, ...extra });
const billed = async (ids: string[], extra: object = {}) => ok(await billing(ids, extra), 201);
const validateInv = async (id: string) => ok(await A.j.post(`/invoices/${id}/validate`));
const tracking = async (id: string) => ok(await A.j.get(`/proformas/${id}/tracking`));
const credit = async (invoiceId: string, effect: string, lines?: { sourceLineId: string; quantity: number }[]) => {
  const c = ok(await A.j.post(`/invoices/${invoiceId}/credit-note`, { reason: `Avoir ${effect}`, effect, ...(lines && { lines }) }), 201);
  return validateInv(c.id);
};
const giveBack = (blId: string, lines: Any[], extra: object = {}) => A.j.post(`/delivery-notes/${blId}/returns`, { reason: 'Retour constaté au magasin', returnConfirmed: true, warehouseId: A.w1, lines, ...extra });
const balance = async (id: string) => (await Customer.findById(id))!.balanceMinor;
const stockQty = async (p: string) => (await levelOf(A, p)).qty;
const sum = (list: Any[], pick: (t: Any) => number) => list.reduce((s, i) => s + pick(i.totals), 0);
const vatBy = (docs: Any[]) => docs.flatMap((d) => d.totals.vatGroups).reduce((m: Record<string, number>, g: Any) => { m[g.vatCode] = (m[g.vatCode] ?? 0) + g.vatMinor; return m; }, {});
/** La somme des factures égale exactement les montants convenus sur la proforma. */
const expectAgreed = (p: Any, invoices: Any[]) => {
  for (const k of ['grossMinor', 'lineDiscountsMinor', 'globalDiscountMinor', 'totalHtMinor', 'totalVatMinor', 'totalTtcMinor']) expect(sum(invoices, (t) => t[k]), k).toBe(p.totals[k]);
  expect(vatBy(invoices)).toEqual(vatBy([p]));
};
/** Cohérences globales : stock = Σ mouvements ; solde client = factures − avoirs − encaissements ; jamais plus livré ni facturé que commandé. */
const consistency = async () => {
  expect(ok(await A.j.get('/stock/consistency')).consistent).toBe(true);
  for (const p of await Proforma.find({ companyId: A.companyId }).lean()) for (const l of p.lines) {
    expect(l.deliveredQty ?? 0, `${p.number} livré`).toBeLessThanOrEqual(l.quantity); expect(l.allocatedQty ?? 0, `${p.number} facturé`).toBeLessThanOrEqual(l.quantity);
    expect(l.invoicedQty ?? 0).toBeLessThanOrEqual(l.allocatedQty ?? 0);
  }
  for (const d of await DeliveryNote.find({ companyId: A.companyId, status: 'validated' }).lean()) for (const l of d.lines) {
    expect(l.allocatedQty ?? 0, `${d.number} : jamais facturé au-delà du livré net`).toBeLessThanOrEqual(l.quantity - (l.returnedQty ?? 0)); expect(l.invoicedQty ?? 0).toBeLessThanOrEqual(l.allocatedQty ?? 0);
  }
  // Livré enregistré sur la proforma = Σ BL validés, retours déduits
  for (const p of await Proforma.find({ companyId: A.companyId }).lean()) for (const l of p.lines) {
    const notes = await DeliveryNote.find({ companyId: A.companyId, 'source.id': p._id, status: 'validated' }).lean();
    expect(l.deliveredQty ?? 0, p.number).toBeCloseTo(notes.flatMap((d) => d.lines).filter((x) => String(x.sourceLineId) === String(l._id)).reduce((s, x) => s + x.quantity - (x.returnedQty ?? 0), 0), 6);
  }
  const c = await Invoice.aggregate([{ $match: { companyId: A.companyId, status: 'validated' } }, { $group: { _id: '$customerId', t: { $sum: { $multiply: [{ $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] }, '$totals.totalPayableMinor'] } } } }]);
  for (const row of c) { const cust = await Customer.findById(row._id); const paid = (await mongoose.connection.collection('payments').aggregate([{ $match: { customerId: row._id, status: 'active' } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]).toArray())[0]?.t ?? 0; expect(cust!.balanceMinor, cust!.name).toBe(row.t - paid); }
};

beforeAll(async () => {
  await setupDb(); A = await logisticsCompany('Cycle', 'admin@cycle.test'); B = await logisticsCompany('Autre', 'admin@autre.test');
  CNC = await mkProduct(A, 'CNC', 'T19', 10_000_000); PART = await mkProduct(A, 'PART', 'T13', 333_333); TOOL = await mkProduct(A, 'TOOL', 'T7', 1_001); SVC = await mkProduct(A, 'POSE', 'T19', 90_000, { kind: 'service' });
  for (const p of [PART, TOOL]) ok(await stockIn(A, p, 5000, 500), 201);
});
afterAll(teardownDb);

describe('scénario principal : devis → proforma → 3 BL → facture groupée', () => {
  let customer: string, q: Any, p: Any, invoice: Any; const notes: Any[] = [];
  it('conversion : copie de la version acceptée, sans relecture des tarifs ; ni stock ni créance', async () => {
    ok(await stockIn(A, CNC, 10, 6_000_000), 201); customer = await newCustomer();
    q = ok(await A.j.post('/quotations', quoteBody({ ...A, customerId: customer }, [line(CNC, 3, { discountPct: 5 })], { globalDiscountMinor: 100_000, deliveryTime: '4 semaines', paymentTerms: '30 jours' })), 201);
    await acceptQuote(A.j, q.id);
    ok(await A.j.put(`/products/${CNC}`, { salePriceMinor: 12_000_000, name: 'Nom changé depuis le devis' }));
    const c = ok(await A.j.post(`/quotations/${q.id}/convert-proforma`), 201); p = ok(await A.j.get(`/proformas/${c.proformaId}`));
    expect(p).toMatchObject({ quotationId: q.id, quotationNumber: q.number, quotationVersion: 1, deliveryTime: '4 semaines', paymentTerms: '30 jours', globalDiscountMinor: 100_000, status: 'pending', statusLabel: 'En attente', deliveryState: 'none', billingState: 'none' });
    expect(p.totals).toEqual(q.totals); expect(p.lines[0]).toMatchObject({ designation: 'Article CNC', unitPriceMinor: 10_000_000, quantity: 3, discountPct: 5, unit: 'PC', sourceLineId: q.lines[0].id, deliveredQty: 0 });
    expect(p.customer).toMatchObject(q.customer);
    ok(await A.j.put(`/products/${CNC}`, { salePriceMinor: 10_000_000, name: 'Article CNC' }));
    expect(await stockQty(CNC)).toBe(10); expect(await balance(customer)).toBe(0); expect(await Invoice.countDocuments({ customerId: customer })).toBe(0);
    expect((await A.j.post(`/quotations/${q.id}/convert-proforma`)).status).toBe(409); // rejeu : aucune seconde proforma
    expect(await Proforma.countDocuments({ quotationId: q.id })).toBe(1);
  });
  it('BL brouillon sans effet ; chaque validation sort une machine ; quatrième livraison refusée', async () => {
    const first = ok(await draftBl(p, [1]), 201); expect(await stockQty(CNC)).toBe(10); expect((await tracking(p.id)).lines[0]).toMatchObject({ delivered: 0, inDraftDeliveries: 1, remainingToDeliver: 3 });
    notes.push(ok(await validateBl(first.id))); expect(await stockQty(CNC)).toBe(9);
    expect((await tracking(p.id)).lines[0]).toMatchObject({ ordered: 3, delivered: 1, remainingToDeliver: 2, invoiced: 0, deliveredNotInvoiced: 1, remainingToBill: 3 });
    expect((await tracking(p.id)).delivery).toMatchObject({ state: 'partial', pct: 33, label: 'Partiellement livrée' });
    notes.push(await delivered(p, [1])); expect(await stockQty(CNC)).toBe(8); expect((await tracking(p.id)).lines[0]).toMatchObject({ delivered: 2, remainingToDeliver: 1 });
    notes.push(await delivered(p, [1])); expect(await stockQty(CNC)).toBe(7);
    const t = await tracking(p.id); expect(t.lines[0]).toMatchObject({ delivered: 3, remainingToDeliver: 0 }); expect(t.delivery).toMatchObject({ state: 'full', pct: 100, count: 3 }); expect(t.billableDeliveries).toBe(3);
    const fourth = await draftBl(p, [1]); expect(fourth.status).toBe(409); expect(fourth.body.error.code).toBe('DELIVERY_EXCEEDED');
    expect(notes[0]!).toMatchObject({ validatedByName: 'Admin Cycle' }); expect(notes[0]!.validatedAt).toBeTruthy();
    expect(await StockMovement.countDocuments({ companyId: A.companyId, productId: CNC, reason: 'delivery' })).toBe(3);
    expect((await A.j.get(`/delivery-notes/source-lines?type=proforma&id=${p.id}`)).body.lines).toHaveLength(0);
    // la proforma envoyée reste « Envoyée » quel que soit l'avancement
    const sent = ok(await A.j.post(`/proformas/${p.id}/mark-sent`, { method: 'hand' })); expect(sent).toMatchObject({ status: 'pending', statusLabel: 'Envoyée', deliveryState: 'full', billingState: 'none', editable: false });
  });
  it('les trois BL dans une facture : brouillon sans créance ; validation = une créance, stock inchangé', async () => {
    const preview = ok(await A.j.post('/invoices/from-delivery-notes/preview', { deliveryNoteIds: notes.map((n) => n.id) })); expect(preview.totals).toEqual(p.totals); expect(await Invoice.countDocuments({ customerId: customer })).toBe(0);
    const list = ok(await A.j.get(`/invoices/billable-deliveries?customerId=${customer}`)).items; expect(list).toHaveLength(3); expect(list[0]).toMatchObject({ status: 'validated', billing: 'none', source: { type: 'proforma', number: p.number } }); expect(list.reduce((s: number, x: Any) => s + x.totalHtMinor, 0)).toBeGreaterThan(0);
    invoice = await billed(notes.map((n) => n.id));
    expect(invoice).toMatchObject({ status: 'draft', number: null, origin: 'delivery', linesLocked: true, proformaId: p.id, quotationId: q.id, sourceRefs: { proformaNumber: p.number, quotationNumber: q.number, quotationVersion: 1 } });
    expect(invoice.lines).toHaveLength(3); expect(invoice.lines.map((l: Any) => l.delivery.noteNumber)).toEqual(notes.map((n) => n.number)); expect(invoice.lines.every((l: Any) => l.sourceLineId === p.lines[0].id)).toBe(true);
    expectAgreed(p, [invoice]);
    expect(await balance(customer)).toBe(0); expect(await JournalEntry.countDocuments({ 'source.id': invoice.id })).toBe(0);
    expect((await tracking(p.id)).lines[0]).toMatchObject({ invoiced: 0, inDraftInvoices: 3, remainingToBill: 3 });
    const v = await validateInv(invoice.id); expect(v.number).toMatch(/^FAC-/); expect(v.validatedByName).toBe('Admin Cycle');
    expect(await stockQty(CNC)).toBe(7); expect(await balance(customer)).toBe(p.totals.totalPayableMinor); expect(v.schedule).toHaveLength(1);
    expect(await JournalEntry.countDocuments({ companyId: A.companyId, 'source.id': invoice.id })).toBe(1);
    expect((await A.j.post(`/invoices/${invoice.id}/validate`)).status).toBe(409); expect(await balance(customer)).toBe(p.totals.totalPayableMinor);
    const t = await tracking(p.id); expect(t.lines[0]).toMatchObject({ invoiced: 3, remainingToBill: 0, deliveredNotInvoiced: 0 }); expect(t.billing).toMatchObject({ state: 'full', pct: 100 });
    for (const n of notes) { const r = await billing([n.id]); expect(r.status).toBe(409); expect(r.body.error.code).toBe('ALREADY_BILLED'); }
    expect((await billing(notes.map((n) => n.id))).status).toBe(409); expect(await Invoice.countDocuments({ customerId: customer })).toBe(1);
  });
  it('documents associés, chronologie, soldes et rapports', async () => {
    for (const [type, id] of [['quotation', q.id], ['proforma', p.id], ['deliveryNote', notes[1]!.id], ['invoice', invoice.id]] as const) {
      const c = ok(await A.j.get(`/sales/chain?type=${type}&id=${id}`));
      expect(c.items.map((x: Any) => x.type)).toEqual(['quotation', 'proforma', 'deliveryNote', 'deliveryNote', 'deliveryNote', 'invoice']);
      expect(c.items.find((x: Any) => x.current).id).toBe(id);
    }
    const items = ok(await A.j.get(`/sales/chain?type=proforma&id=${p.id}`)).items; expect(items[0]).toMatchObject({ number: q.number, detail: 'Version 1 acceptée', route: `/quotations/${q.id}` }); expect(items[5]).toMatchObject({ label: 'Facture', statusLabel: 'Validée', amountMinor: p.totals.totalPayableMinor });
    const events = ok(await A.j.get(`/sales/chain/activities?type=proforma&id=${p.id}`)).items.map((e: Any) => e.action);
    for (const a of ['quote_converted', 'proforma_created', 'delivery_created', 'delivery_validated', 'stock_out', 'delivery_partial', 'delivery_complete', 'invoice_grouped', 'invoice_validated', 'receivable_created', 'proforma_sent']) expect(events, a).toContain(a);
    const s = ok(await A.j.get(`/customers/${customer}/summary`)); expect(s.finance).toMatchObject({ consistent: true, balanceMinor: p.totals.totalPayableMinor, unpaidMinor: p.totals.totalPayableMinor });
    await consistency();
    const pdf = await api().get(`/api/v1/invoices/${invoice.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser);
    const txt = pdfText(pdf.body as Buffer); for (const n of notes) expect(txt).toContain(n.number); expect(txt).toContain(p.number); expect(txt).toContain(q.number);
  });
});

describe('facturation individuelle', () => {
  it('un BL → une facture, au fur et à mesure : stock, créances, remise répartie une seule fois, TVA à plusieurs taux', async () => {
    const customer = await newCustomer();
    const { proforma: p } = await fromQuote([line(PART, 3), line(TOOL, 3, { discountPct: 2.5 }), line(SVC, 1)], { globalDiscountMinor: 100_000 }, customer);
    const invoices: Any[] = []; let due = 0;
    for (let i = 0; i < 3; i++) {
      const before = await stockQty(PART);
      const bl = await delivered(p, [1, 1, i === 2 ? 1 : 0]);
      const v = await validateInv((await billed([bl.id])).id); invoices.push(v); due += v.totals.totalPayableMinor;
      expect(await stockQty(PART)).toBe(before - 1); expect(await balance(customer)).toBe(due);
      expect(v.totals.globalDiscountMinor).toBeGreaterThan(0); expect(v.totals.globalDiscountMinor).toBeLessThan(100_000);
      expect((await billing([bl.id])).status).toBe(409);
    }
    expect(invoices.reduce((s, i) => s + i.totals.globalDiscountMinor, 0)).toBe(100_000);
    expectAgreed(p, invoices);
    const t = await tracking(p.id); expect(t.billing.state).toBe('full'); expect(t.delivery.state).toBe('full'); expect(t.billing.count).toBe(3);
    expect(await StockMovement.countDocuments({ companyId: A.companyId, reason: 'delivery', productId: SVC })).toBe(0); // service : aucun mouvement
    await consistency();
  });
  it('mode « individuel » : une facture par BL, tout ou rien', async () => {
    const p = await proforma([line(PART, 2)]); const a = await delivered(p, [1]); const b = await delivered(p, [1]);
    const r = ok(await billing([a.id, b.id], { mode: 'individual' }), 201); expect(r.items).toHaveLength(2); expect(r.items.map((i: Any) => i.deliveryNoteIds)).toEqual([[a.id], [b.id]]);
    // l'écart d'arrondi de TVA est repris par la facture qui solde le taux, à sa validation
    expectAgreed(p, [await validateInv(r.items[0].id), await validateInv(r.items[1].id)]);
    const p2 = await proforma([line(PART, 2)]); const c = await delivered(p2, [1]); const draft = ok(await draftBl(p2, [1]), 201);
    const bad = await billing([c.id, draft.id], { mode: 'individual' }); expect(bad.status).toBe(409); expect(bad.body.error.code).toBe('DELIVERY_NOT_VALIDATED');
    expect((await DeliveryNote.findById(c.id))!.invoiceIds ?? []).toHaveLength(0);
  });
  it('sans attendre la livraison totale ; quantité partielle d’un BL ; dépassement refusé', async () => {
    const p = await proforma([line(PART, 5)], { globalDiscountMinor: 10_001 }); const a = await delivered(p, [3]);
    const sel = (q: number) => ({ lines: [{ deliveryNoteId: a.id, lineId: a.lines[0].id, quantity: q }] });
    expect((await billing([a.id], sel(4))).body.error.code).toBe('BILLING_EXCEEDED');
    const first = await validateInv((await billed([a.id], sel(2))).id);
    expect((await A.j.get(`/delivery-notes/${a.id}`)).body).toMatchObject({ billing: 'partial', invoiced: false, cancellable: false });
    expect((await billing([a.id], sel(2))).status).toBe(409);
    const second = await validateInv((await billed([a.id])).id); expect(second.lines[0].quantity).toBe(1);
    const b = await delivered(p, [2]); const third = await validateInv((await billed([b.id])).id);
    expectAgreed(p, [first, second, third]);
  });
});

describe('remises, TVA et arrondis', () => {
  it('remise globale en pourcentage et remises individuelles : montants identiques groupés ou séparés', async () => {
    for (const extra of [{ syncDiscountPct: 5 }, {}]) {
      const lines = [line(PART, 4, { discountPct: 3.3 }), line(TOOL, 7, { discountPct: 10 })];
      const g = await proforma(lines, extra); const s = await proforma(lines, extra);
      const grouped = await validateInv((await billed([(await delivered(g, [1, 3])).id, (await delivered(g, [3, 4])).id])).id);
      const first = await validateInv((await billed([(await delivered(s, [1, 3])).id])).id); const second = await validateInv((await billed([(await delivered(s, [3, 4])).id])).id);
      expectAgreed(g, [grouped]); expectAgreed(s, [first, second]);
    }
  });
  it('suppression d’un brouillon : réservation libérée, la répartition reste exacte', async () => {
    const p = await proforma([line(PART, 3)], { globalDiscountMinor: 100_000 }); const notes = [await delivered(p, [1]), await delivered(p, [1]), await delivered(p, [1])];
    const d1 = await billed([notes[0]!.id]); const d2 = await billed([notes[1]!.id]);
    ok(await A.j.del(`/invoices/${d1.id}`), 204);
    expect((await DeliveryNote.findById(notes[0]!.id))!.lines[0]!.allocatedQty).toBe(0); expect((await DeliveryNote.findById(notes[0]!.id))!.invoiceIds).toHaveLength(0);
    const d3 = await billed([notes[2]!.id]); const d4 = await billed([notes[0]!.id]);
    const all = []; for (const d of [d4, d2, d3]) all.push(await validateInv(d.id)); expectAgreed(p, all);
  });
  it('propriété : livraisons et facturations aléatoires → la somme des factures égale toujours la proforma au millime', async () => {
    let seed = 20261127; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }; const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    for (let round = 0; round < 12; round++) {
      const lines = [PART, TOOL, SVC].slice(0, int(1, 3)).map((id) => line(id, id === SVC ? 1 : int(1, 7), { unitPriceMinor: int(1, 9_999), discountPct: int(0, 300) / 10 }));
      const sync = rnd() < 0.3 ? int(1, 150) / 10 : 0;
      const p = await proforma(lines, { ...(sync && { syncDiscountPct: sync }), ...(rnd() < 0.8 && { globalDiscountMinor: int(1, 900) % 997 }) }).catch(async () => proforma(lines));
      const left: number[] = p.lines.map((l: Any) => l.quantity); const notes: Any[] = [];
      while (left.some((q) => q > 0)) {
        const take = left.map((q) => (q ? int(0, q) : 0)); if (!take.some((q) => q > 0)) continue;
        take.forEach((q, i) => { left[i]! -= q; }); notes.push(await delivered(p, take));
      }
      const invoices: Any[] = []; const queue = [...notes].sort(() => rnd() - 0.5);
      while (queue.length) {
        const group = queue.splice(0, int(1, 3)).map((n) => n.id); const d = await billed(group);
        if (rnd() < 0.2) { ok(await A.j.del(`/invoices/${d.id}`), 204); queue.push(...notes.filter((n) => group.includes(n.id))); } else invoices.push(d);
      }
      const validated: Any[] = []; for (const d of invoices.sort(() => rnd() - 0.5)) validated.push(await validateInv(d.id));
      expectAgreed(p, validated);
    }
    await consistency();
  });
  it('facture issue de BL : montants et quantités verrouillés ; dates et échéancier modifiables', async () => {
    const p = await proforma([line(PART, 2)], { globalDiscountMinor: 1_000, paymentTerms: 'Acompte et solde', paymentTermsCustom: true }); const bl = await delivered(p, [2]); const d = await billed([bl.id]);
    const body = (extra: object = {}, lineExtra: object = {}) => ({ customerId: d.customerId, lines: d.lines.map((l: Any) => ({ productId: l.productId, designation: l.designation, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct, vatCode: l.vat.code, ...lineExtra })), ...extra });
    for (const bad of [body({}, { unitPriceMinor: 1 }), body({}, { quantity: 1 }), body({}, { discountPct: 50 }), body({ globalDiscountMinor: 5 }), body({ syncDiscountPct: 10 })]) { const r = await A.j.put(`/invoices/${d.id}`, bad); expect(r.status).toBe(422); expect(r.body.error.code).toBe('DELIVERY_LINES_LOCKED'); }
    expect((await A.j.post(`/invoices/${d.id}/validate`)).body.error.code).toBe('PAYMENT_SCHEDULE_REQUIRED');
    const u = ok(await A.j.put(`/invoices/${d.id}`, body({ schedule: [{ dueDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), percent: 30 }, { dueDate: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10), percent: 70 }], notes: 'Échéancier convenu' })));
    expect(u.totals).toEqual(d.totals); expect((await validateInv(d.id)).schedule).toHaveLength(2);
  });
});

describe('regroupement : compatibilité', () => {
  it('proformas différentes, clients différents, sources mêlées : refusés ; BL sans source regroupables entre eux', async () => {
    const p1 = await proforma([line(PART, 1)]); const p2 = await proforma([line(PART, 1)]); const a = await delivered(p1, [1]); const b = await delivered(p2, [1]);
    const r = await billing([a.id, b.id]); expect(r.status).toBe(409); expect(r.body.error.code).toBe('INCOMPATIBLE_DELIVERIES');
    const manual = async (customerId = A.customerId) => { const n = ok(await A.j.post('/delivery-notes', { customerId, warehouseId: A.w1, lines: [line(PART, 2, { discountPct: 5 })] }), 201); return ok(await validateBl(n.id)); };
    const m1 = await manual(); const m2 = await manual();
    expect((await billing([a.id, m1.id])).body.error.code).toBe('INCOMPATIBLE_DELIVERIES');
    expect((await billing([m1.id, (await manual(await newCustomer())).id])).status).toBe(400);
    const g = await billed([m1.id, m2.id]); expect(g.totals.totalHtMinor).toBe(m1.totals.totalHtMinor + m2.totals.totalHtMinor); expect(g.proformaId).toBeNull();
  });
});

describe('annulation de la proforma', () => {
  it('avant toute livraison : devis « Annulé », aucune sortie ni créance, motif et auteur conservés', async () => {
    const customer = await newCustomer(); const { quote, proforma: p } = await fromQuote([line(PART, 2)], {}, customer);
    const draft = ok(await draftBl(p, [1]), 201); const before = await stockQty(PART);
    const check = ok(await A.j.get(`/proformas/${p.id}/cancellation`)); expect(check).toMatchObject({ allowed: true, draftDeliveries: [{ number: draft.number }], quotation: { number: quote.number, willCancel: true } });
    const c = ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Commande annulée par le client' }));
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Commande annulée par le client', cancelledByName: 'Admin Cycle' }); expect(c.cancelledAt).toBeTruthy();
    expect((await A.j.get(`/delivery-notes/${draft.id}`)).body.status).toBe('cancelled');
    const q = ok(await A.j.get(`/quotations/${quote.id}`)); expect(q).toMatchObject({ status: 'cancelled' }); expect(q.actions).toMatchObject({ duplicate: true, edit: false, convertProforma: false });
    expect(ok(await A.j.get(`/quotations/${quote.id}/versions`)).items[0].status).toBe('cancelled');
    expect(ok(await A.j.get(`/quotations/${quote.id}/activities?kind=cancelled`)).items).toHaveLength(1);
    expect(await stockQty(PART)).toBe(before); expect(await balance(customer)).toBe(0);
    const actions = ok(await A.j.get(`/sales/chain/activities?type=quotation&id=${quote.id}`)).items.map((e: Any) => e.action); expect(actions).toEqual(expect.arrayContaining(['proforma_cancelled', 'quote_cancelled', 'delivery_cancelled']));
    expect((await validateBl(draft.id)).status).toBe(409); expect((await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Encore' })).status).toBe(409);
  });
  it('après livraison : refusée ; l’annulation du BL non facturé (retour confirmé) la rend possible', async () => {
    const { quote, proforma: p } = await fromQuote([line(PART, 2)]); const bl = await delivered(p, [2]); const before = await stockQty(PART);
    const r = await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Annulation' }); expect(r.status).toBe(409); expect(r.body.error.code).toBe('PROFORMA_CANCEL_BLOCKED'); expect(r.body.error.details.blockers[0]).toMatchObject({ type: 'deliveryNote', number: bl.number });
    expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('accepted');
    expect((await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Sans confirmation' })).status).toBe(422);
    expect((await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Sans confirmation', returnConfirmed: false })).status).toBe(422);
    expect(await stockQty(PART)).toBe(before);
    ok(await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Marchandise reprise', returnConfirmed: true })); expect(await stockQty(PART)).toBe(before + 2);
    ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Annulation' })); expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('cancelled');
    expect((await DeliveryNote.findById(bl.id))!.status).toBe('cancelled'); // conservé
  });
  it('après facturation : avoir financier sans retour (stock inchangé, toujours bloquée) ; avoir « retour » puis retour physique : annulation possible', async () => {
    const customer = await newCustomer(); const { proforma: p, quote } = await fromQuote([line(PART, 3)], { globalDiscountMinor: 100_000 }, customer);
    const bl = await delivered(p, [3]); const inv = await validateInv((await billed([bl.id])).id); const stock = await stockQty(PART);
    expect((await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Facturé', returnConfirmed: true })).body.error.code).toBe('DELIVERY_BILLED');
    expect((await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }])).body.error.code).toBe('RETURN_EXCEEDED'); // facturé et non crédité
    const l = inv.lines[0].id;
    const financial = await credit(inv.id, 'financial', [{ sourceLineId: l, quantity: 1 }]);
    expect(await stockQty(PART)).toBe(stock); expect((await tracking(p.id)).lines[0]).toMatchObject({ delivered: 3, invoiced: 3, remainingToBill: 0 }); // ni stock ni quantité rouverte
    expect((await billing([bl.id])).status).toBe(409);
    expect((await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }])).status).toBe(409);
    expect((await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Annulation' })).status).toBe(409);
    const back = await credit(inv.id, 'return', [{ sourceLineId: l, quantity: 2 }]);
    expect(await stockQty(PART)).toBe(stock); // l'avoir seul ne réintègre rien
    expect(ok(await A.j.get(`/delivery-notes/${bl.id}/returnable`)).lines[0]).toMatchObject({ delivered: 3, billed: 3, unbilled: 0, credited: 2, returnable: 2 });
    expect((await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 3 }])).status).toBe(409);
    const value = (await levelOf(A, PART)).value;
    const returned = ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 2 }], { requestId: 'retour-0001' }), 201); expect(returned.returns[0].lines[0]).toMatchObject({ quantity: 2, creditedQty: 2 });
    expect(await stockQty(PART)).toBe(stock + 2); expect((await levelOf(A, PART)).value).toBeGreaterThan(value);
    ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 2 }], { requestId: 'retour-0001' }), 201); expect(await stockQty(PART)).toBe(stock + 2); // rejeu : aucun second retour
    expect((await tracking(p.id)).lines[0]).toMatchObject({ delivered: 1, returned: 2, invoiced: 1, remainingToDeliver: 2, deliveredNotInvoiced: 0 });
    expect((await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Annulation' })).status).toBe(409); // reste 1 livrée
    expect(await balance(customer)).toBe(inv.totals.totalPayableMinor - financial.totals.totalPayableMinor - back.totals.totalPayableMinor);
    // la troisième unité, créditée financièrement, reste chez le client : la commande ne peut pas être annulée
    expect(ok(await A.j.get(`/proformas/${p.id}/cancellation`)).blockers.map((b: Any) => b.type)).toEqual(['deliveryNote']);
    expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('accepted');
    await consistency();
  });
  it('facturé puis intégralement crédité et retourné : annulation autorisée, devis « Annulé »', async () => {
    const customer = await newCustomer(); const { proforma: p, quote } = await fromQuote([line(PART, 2)], {}, customer);
    const bl = await delivered(p, [2]); const inv = await validateInv((await billed([bl.id])).id);
    await credit(inv.id, 'return'); ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 2 }]), 201);
    const c = ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Commande soldée par avoir et retour' })); expect(c.status).toBe('cancelled');
    expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('cancelled'); expect(await balance(customer)).toBe(0);
    expect(await Invoice.countDocuments({ customerId: customer, status: 'validated' })).toBe(2); // documents conservés
    await consistency();
  });
  it('encaissement conservé : annulation possible après avoir, avec avertissement', async () => {
    const p = await proforma([line(PART, 1)]); const bl = await delivered(p, [1]); const inv = await validateInv((await billed([bl.id])).id);
    ok(await A.j.post(`/invoices/${inv.id}/payments`, { amountMinor: 1_000, method: 'cash' }), 201);
    await credit(inv.id, 'return'); ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }]), 201);
    expect(ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Remboursement à traiter' })).effects.warnings[0]).toContain('encaissements');
  });
  it('plusieurs proformas pour un même devis (historique) : le devis reste actif tant qu’une proforma subsiste', async () => {
    const { quote, proforma: p } = await fromQuote([line(PART, 1)]); const other = await proforma([line(PART, 1)]); await Proforma.updateOne({ _id: other.id }, { quotationId: quote.id });
    const check = ok(await A.j.get(`/proformas/${p.id}/cancellation`)); expect(check.quotation).toMatchObject({ willCancel: false }); expect(check.quotation.reason).toContain(other.number);
    ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Doublon' })); expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('accepted');
    ok(await A.j.post(`/proformas/${other.id}/cancel`, { reason: 'Annulation' })); expect((await A.j.get(`/quotations/${quote.id}`)).body.status).toBe('cancelled');
  });
  it('retour d’un BL non facturé, partiel : quantités à relivrer et facturation limitée au reste', async () => {
    const p = await proforma([line(PART, 4)], { globalDiscountMinor: 4_000 }); const bl = await delivered(p, [4]); const stock = await stockQty(PART);
    ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }]), 201); expect(await stockQty(PART)).toBe(stock + 1);
    expect((await A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Après retour', returnConfirmed: true })).body.error.code).toBe('DELIVERY_HAS_RETURNS');
    const first = await validateInv((await billed([bl.id])).id); expect(first.lines[0].quantity).toBe(3);
    const again = await delivered(p, [1]); const second = await validateInv((await billed([again.id])).id); expectAgreed(p, [first, second]);
    await consistency();
  });
});

describe('avoirs et correction de facturation', () => {
  it('correction de facturation : quantités rouvertes puis refacturées ; facture − avoir + nouvelle facture = montant convenu', async () => {
    const customer = await newCustomer(); const p = await proforma([line(PART, 3), line(TOOL, 5)], { globalDiscountMinor: 99_999 }, customer);
    const bl = await delivered(p, [3, 5]); const inv = await validateInv((await billed([bl.id])).id); const stock = await stockQty(PART);
    const cn = await credit(inv.id, 'billing_correction', [{ sourceLineId: inv.lines[0].id, quantity: 2 }]);
    expect(await stockQty(PART)).toBe(stock);
    expect((await tracking(p.id)).lines[0]).toMatchObject({ invoiced: 1, remainingToBill: 2, delivered: 3 });
    const again = await validateInv((await billed([bl.id])).id); expect(again.lines).toHaveLength(1); expect(again.lines[0].quantity).toBe(2);
    expect(inv.totals.totalHtMinor - cn.totals.totalHtMinor + again.totals.totalHtMinor).toBe(p.totals.totalHtMinor);
    expect(await balance(customer)).toBe(inv.totals.totalPayableMinor - cn.totals.totalPayableMinor + again.totals.totalPayableMinor);
    expect((await billing([bl.id])).status).toBe(409);
    await consistency();
  });
  it('avoir total puis avoirs partiels : montants de la facture issue de BL restitués au millime', async () => {
    const p = await proforma([line(PART, 3), line(TOOL, 3)], { globalDiscountMinor: 77_777 }); const bl = await delivered(p, [3, 3]);
    const total = await validateInv((await billed([bl.id])).id); const full = await credit(total.id, 'financial');
    for (const k of ['totalHtMinor', 'totalVatMinor', 'totalTtcMinor']) expect(full.totals[k]).toBe(total.totals[k]);
    const p2 = await proforma([line(PART, 3)], { globalDiscountMinor: 100 }); const b2 = await delivered(p2, [3]); const inv = await validateInv((await billed([b2.id])).id);
    const parts = []; for (let i = 0; i < 3; i++) parts.push(await credit(inv.id, 'financial', [{ sourceLineId: inv.lines[0].id, quantity: 1 }]));
    expect(parts.reduce((s, c) => s + c.totals.totalTtcMinor, 0)).toBe(inv.totals.totalTtcMinor);
    expect((await A.j.post(`/invoices/${inv.id}/credit-note`, { reason: 'Trop', effect: 'financial' })).status).toBe(409);
  });
  it('effets impossibles refusés : correction sans livraison, retour sans livraison', async () => {
    const d = ok(await A.j.post('/invoices', { customerId: A.customerId, lines: [line(PART, 1)] }), 201); await validateInv(d.id);
    expect((await A.j.post(`/invoices/${d.id}/credit-note`, { reason: 'Test', effect: 'billing_correction' })).body.error.code).toBe('NO_DELIVERY_TO_REBILL');
    expect((await A.j.post(`/invoices/${d.id}/credit-note`, { reason: 'Test', effect: 'return' })).body.error.code).toBe('RETURN_WITHOUT_DELIVERY');
    expect((await A.j.post(`/invoices/${d.id}/credit-note`, { reason: 'Test' })).body.creditEffect).toBe('financial');
  });
});

describe('facture saisie directement et filtres', () => {
  it('BL d’une facture directe : retour possible sans avoir ; filtres « facturés » / « non facturés »', async () => {
    const d = ok(await A.j.post('/invoices', { customerId: A.customerId, lines: [line(PART, 2)] }), 201); const v = await validateInv(d.id);
    const n = ok(await A.j.post('/delivery-notes', { source: { type: 'invoice', id: v.id }, warehouseId: A.w1, lines: [{ sourceLineId: v.lines[0].id, quantity: 2 }] }), 201); const bl = ok(await validateBl(n.id)); const stock = await stockQty(PART);
    const ids = async (invoiced: boolean) => ok(await A.j.get(`/delivery-notes?invoiced=${invoiced}&limit=100`)).items.map((x: Any) => x.id) as string[];
    expect(await ids(true)).toContain(bl.id); expect(await ids(false)).not.toContain(bl.id);
    ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }]), 201); expect(await stockQty(PART)).toBe(stock + 1);
    expect((await Invoice.findById(v.id))!.lines[0]!.deliveredQty).toBe(1); expect((await billing([bl.id])).body.error.code).toBe('ALREADY_BILLED');
    const p = await proforma([line(PART, 1)]); const open = await delivered(p, [1]); expect(await ids(false)).toContain(open.id); expect(await ids(true)).not.toContain(open.id);
  });
});

describe('numéros de série', () => {
  let S: string, OTHER: string;
  const serials = (n: string[]) => n.map((x) => `SN-${x}`);
  beforeAll(async () => {
    S = A.serialProduct; OTHER = await mkProduct(A, 'MACH-T', 'T19', 90_000, { hasSerial: true });
    ok(await stockIn(A, S, 4, 50_000, A.w1, { serials: serials(['1', '2', '3', '4']) }), 201); ok(await stockIn(A, OTHER, 1, 50_000, A.w1, { serials: ['AUTRE-1'] }), 201); ok(await stockIn(A, S, 1, 50_000, A.w2, { serials: ['SN-W2'] }), 201);
    ok(await stockIn(B, B.serialProduct, 1, 50_000, B.w1, { serials: ['ETRANGER-1'] }), 201);
  });
  const note = (p: Any, quantity: number, list: string[]) => A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, warehouseId: A.w1, lines: [{ sourceLineId: p.lines[0].id, quantity, serials: list }] });
  it('contrôles : article, société, magasin, double emploi, nombre ; traçabilité jusqu’à la facture ; retour', async () => {
    const p = await proforma([line(S, 3)]);
    const listed = ok(await A.j.get(`/delivery-notes/available-serials?productId=${S}&warehouseId=${A.w1}`)).items.map((x: Any) => x.serialNumber); expect(listed).toEqual(serials(['1', '2', '3', '4']));
    for (const bad of [['AUTRE-1'], ['ETRANGER-1'], ['SN-W2'], ['INCONNU']]) expect((await note(p, 1, bad)).body.error.code, bad[0]).toBe('SERIAL_UNAVAILABLE');
    expect((await note(p, 1, serials(['1', '2']))).body.error.code).toBe('SERIAL_COUNT');
    expect((await note(p, 2, serials(['1', '1']))).body.error.code).toBe('SERIAL_DUPLICATE');
    const incomplete = ok(await note(p, 2, serials(['4'])), 201); expect((await validateBl(incomplete.id)).status).toBe(400); // 1 numéro pour 2 unités
    expect((await DeliveryNote.findById(incomplete.id))!.status).toBe('draft'); ok(await A.j.del(`/delivery-notes/${incomplete.id}`), 204);
    const a = ok(await note(p, 2, serials(['1', '2'])), 201);
    expect((await note(p, 1, serials(['1']))).body.error.code).toBe('SERIAL_ALREADY_ASSIGNED');
    expect(ok(await A.j.get(`/delivery-notes/available-serials?productId=${S}&warehouseId=${A.w1}`)).items.find((x: Any) => x.serialNumber === 'SN-1').assignedTo).toBe(a.number);
    ok(await validateBl(a.id));
    expect((await note(p, 1, serials(['1']))).body.error.code).toBe('SERIAL_UNAVAILABLE'); // déjà livré
    const first = await validateInv((await billed([a.id], { lines: [{ deliveryNoteId: a.id, lineId: a.lines[0].id, quantity: 1 }] })).id); expect(first.lines[0].serials).toEqual(['SN-1']);
    const second = await validateInv((await billed([a.id])).id); expect(second.lines[0].serials).toEqual(['SN-2']);
    const pdf = await api().get(`/api/v1/invoices/${second.id}/pdf`).set('Authorization', `Bearer ${A.token}`).buffer().parse(binaryParser); expect(pdfText(pdf.body as Buffer)).toContain('SN-2');
    await credit(second.id, 'return');
    expect((await giveBack(a.id, [{ lineId: a.lines[0].id, quantity: 1 }])).body.error.code).toBe('SERIAL_COUNT');
    expect((await giveBack(a.id, [{ lineId: a.lines[0].id, quantity: 1, serials: ['SN-3'] }])).body.error.code).toBe('SERIAL_UNAVAILABLE');
    const stock = await stockQty(S); ok(await giveBack(a.id, [{ lineId: a.lines[0].id, quantity: 1, serials: ['SN-2'] }]), 201);
    expect(await stockQty(S)).toBe(stock + 1); expect((await ProductSerial.findOne({ companyId: A.companyId, serialNumber: 'SN-2' }))!.status).toBe('available'); expect((await ProductSerial.findOne({ companyId: A.companyId, serialNumber: 'SN-1' }))!.status).toBe('sold');
    expect((await giveBack(a.id, [{ lineId: a.lines[0].id, quantity: 1, serials: ['SN-2'] }])).status).toBe(409);
    const again = ok(await note(p, 1, serials(['2'])), 201); ok(await validateBl(again.id)); // relivrable
    await consistency();
  });
});

describe('concurrence et rejeu', () => {
  const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();
  it('conversion simultanée du même devis : une seule proforma', async () => {
    const q = ok(await A.j.post('/quotations', quoteBody(A, [line(PART, 1)])), 201); await acceptQuote(A.j, q.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => A.j.post(`/quotations/${q.id}/convert-proforma`)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(await Proforma.countDocuments({ quotationId: q.id })).toBe(1);
  });
  it('dernières quantités : deux validations simultanées ; rejeu d’une validation : une seule sortie', async () => {
    const p = await proforma([line(PART, 3)]); await delivered(p, [2]);
    const a = ok(await draftBl(p, [1]), 201); const b = ok(await draftBl(p, [1]), 201); const stock = await stockQty(PART);
    const rs = await Promise.all([validateBl(a.id), validateBl(b.id)]); expect(statuses(rs)).toEqual([200, 409]); expect(await stockQty(PART)).toBe(stock - 1);
    const winner = rs.findIndex((r) => r.status === 200) === 0 ? a : b;
    const p2 = await proforma([line(PART, 1)]); const c = ok(await draftBl(p2, [1]), 201); const before = await stockQty(PART);
    const replay = await Promise.all(Array.from({ length: 5 }, () => validateBl(c.id))); expect(replay.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await validateBl(c.id)).status).toBe(409); expect(await stockQty(PART)).toBe(before - 1); expect(await StockMovement.countDocuments({ 'source.id': c.id })).toBe(1);
    expect(winner.id).toBeTruthy();
  });
  it('stock insuffisant sous concurrence : jamais de stock négatif', async () => {
    const scarce = await mkProduct(A, `RARE-${++seq}`); ok(await stockIn(A, scarce, 1, 500), 201);
    const notes = []; for (let i = 0; i < 2; i++) { const p = await proforma([line(scarce, 1)]); notes.push(ok(await draftBl(p, [1]), 201)); }
    const rs = await Promise.all(notes.map((n) => validateBl(n.id))); expect(statuses(rs)).toEqual([200, 409]); expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('INSUFFICIENT_STOCK'); expect(await stockQty(scarce)).toBe(0);
  });
  it('même BL facturé simultanément : une seule facture ; quantités concurrentes jamais dépassées', async () => {
    const p = await proforma([line(PART, 3)]); const bl = await delivered(p, [3]);
    const rs = await Promise.all(Array.from({ length: 5 }, () => billing([bl.id]))); expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(await Invoice.countDocuments({ deliveryNoteIds: bl.id })).toBe(1);
    const p2 = await proforma([line(PART, 3)]); const b2 = await delivered(p2, [3]); const sel = { lines: [{ deliveryNoteId: b2.id, lineId: b2.lines[0].id, quantity: 2 }] };
    const part = await Promise.all([billing([b2.id], sel), billing([b2.id], sel)]); expect(statuses(part)).toEqual([201, 409]);
    expect((await DeliveryNote.findById(b2.id))!.lines[0]!.allocatedQty).toBe(2); expect((await Proforma.findById(p2.id))!.lines[0]!.allocatedQty).toBe(2);
  });
  it('validation rejouée d’une facture : une créance, une écriture', async () => {
    const customer = await newCustomer(); const p = await proforma([line(PART, 1)], {}, customer); const d = await billed([(await delivered(p, [1])).id]);
    const rs = await Promise.all(Array.from({ length: 5 }, () => A.j.post(`/invoices/${d.id}/validate`))); expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await balance(customer)).toBe(d.totals.totalPayableMinor); expect(await JournalEntry.countDocuments({ 'source.id': d.id })).toBe(1);
    expect(await AuditLog.countDocuments({ companyId: A.companyId, action: 'cycle.receivable_created', resourceId: d.id })).toBe(1);
  });
  it('facturation contre annulation du BL, annulation de proforma contre livraison : un seul gagnant, état cohérent', async () => {
    for (let i = 0; i < 4; i++) {
      const p = await proforma([line(PART, 1)]); const bl = await delivered(p, [1]);
      const rs = await Promise.all([billing([bl.id]), A.j.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Concurrence', returnConfirmed: true })]);
      expect(rs.filter((r) => r.status < 300)).toHaveLength(1);
      const d = (await DeliveryNote.findById(bl.id))!; if (d.status === 'cancelled') expect(await Invoice.countDocuments({ deliveryNoteIds: bl.id })).toBe(0);
      const p2 = await proforma([line(PART, 1)]); const draft = ok(await draftBl(p2, [1]), 201);
      const race = await Promise.all([validateBl(draft.id), A.j.post(`/proformas/${p2.id}/cancel`, { reason: 'Concurrence' })]);
      expect(race.filter((r) => r.status < 300)).toHaveLength(1);
      const state = (await Proforma.findById(p2.id))!; const note = (await DeliveryNote.findById(draft.id))!;
      if (state.status === 'cancelled') { expect(note.status).toBe('cancelled'); expect(state.lines[0]!.deliveredQty).toBe(0); } else expect(note.status).toBe('validated');
    }
    await consistency();
  });
});

describe('sécurité', () => {
  let p: Any, bl: Any, inv: Any;
  beforeAll(async () => { p = await proforma([line(PART, 3)]); bl = await delivered(p, [2]); inv = await validateInv((await billed([bl.id], { lines: [{ deliveryNoteId: bl.id, lineId: bl.lines[0].id, quantity: 1 }] })).id); });
  it('permissions : chaque action exige son droit ; documents associés filtrés', async () => {
    await makeUser(A.companyId, 'lecture@cycle.test', ['proformas:view', 'deliveryNotes:view']); const u = J((await login('lecture@cycle.test')).token);
    for (const r of [u.post(`/proformas/${p.id}/cancel`, { reason: 'Interdit' }), u.get(`/proformas/${p.id}/cancellation`), u.post(`/proformas/${p.id}/mark-sent`, { method: 'hand' }), u.get('/invoices/billable-deliveries'),
      u.post('/invoices/from-delivery-notes', { deliveryNoteIds: [bl.id] }), u.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1 }] }),
      u.post(`/delivery-notes/${bl.id}/returns`, { reason: 'Interdit', returnConfirmed: true, lines: [{ lineId: bl.lines[0].id, quantity: 1 }] }), u.post(`/delivery-notes/${bl.id}/cancel`, { reason: 'Interdit', returnConfirmed: true }),
      u.get(`/sales/chain?type=invoice&id=${inv.id}`), u.get(`/sales/chain/activities?type=quotation&id=${p.id}`), u.post(`/invoices/${inv.id}/credit-note`, { reason: 'Interdit' })]) expect((await r).status).toBe(403);
    const chain = ok(await u.get(`/sales/chain?type=proforma&id=${p.id}`)); expect(chain.items.map((x: Any) => x.type)).toEqual(['proforma', 'deliveryNote']); expect(chain.restricted).toEqual(['quotation', 'invoice']);
    const events = ok(await u.get(`/sales/chain/activities?type=proforma&id=${p.id}`)).items; expect(events.length).toBeGreaterThan(0); expect(events.some((e: Any) => e.resourceId === inv.id)).toBe(false);
    expect((await api().get(`/api/v1/proformas/${p.id}/tracking`)).status).toBe(401);
  });
  it('isolation entre sociétés', async () => {
    for (const r of [B.j.get(`/proformas/${p.id}`), B.j.get(`/proformas/${p.id}/tracking`), B.j.post(`/proformas/${p.id}/cancel`, { reason: 'Autre société' }), B.j.get(`/delivery-notes/${bl.id}`), B.j.post(`/delivery-notes/${bl.id}/validate`),
      B.j.get(`/delivery-notes/${bl.id}/returnable`), B.j.get(`/sales/chain?type=proforma&id=${p.id}`), B.j.get(`/invoices/${inv.id}`), B.j.post(`/invoices/${inv.id}/credit-note`, { reason: 'Autre société' })]) expect((await r).status).toBe(404);
    expect((await B.j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [bl.id] })).status).toBe(400);
    expect(ok(await B.j.get('/invoices/billable-deliveries')).items).toHaveLength(0);
  });
  it('manipulations par l’API : montants, statuts, quantités, conversions interdites, documents validés', async () => {
    const forged = ok(await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1, unitPriceMinor: 1, discountPct: 99 }] }), 201);
    expect(forged.lines[0]).toMatchObject({ unitPriceMinor: p.lines[0].unitPriceMinor, discountPct: 0 });
    for (const extra of [{ status: 'validated' }, { companyId: String(B.companyId) }, { totals: {} }]) expect((await A.j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1 }], ...extra })).status).toBe(422);
    for (const q of [0, -1, 0.5, 1.0001]) expect((await draftBl(p, [q === 0 ? 0 : q], q === 0 ? { lines: [{ sourceLineId: p.lines[0].id, quantity: 0 }] } : {})).status, String(q)).toBe(422);
    for (const extra of [{ totals: {} }, { status: 'validated' }, { customerId: A.customerId }]) expect((await billing([bl.id], extra)).status).toBe(422);
    expect((await billing([forged.id])).body.error.code).toBe('DELIVERY_NOT_VALIDATED');
    expect((await billing([bl.id], { lines: [{ deliveryNoteId: bl.id, lineId: bl.lines[0].id, quantity: 99 }] })).body.error.code).toBe('BILLING_EXCEEDED');
    expect((await billing([bl.id], { lines: [{ deliveryNoteId: bl.id, lineId: bl.lines[0].id, quantity: -1 }] })).status).toBe(422);
    const q = ok(await A.j.post('/quotations', quoteBody(A, [line(PART, 1)])), 201); await acceptQuote(A.j, q.id);
    for (const url of [`/quotations/${q.id}/convert-invoice`, `/quotations/${q.id}/convert-delivery-note`, `/proformas/${p.id}/convert-invoice`]) expect((await A.j.post(url)).status, url).toBe(410);
    expect((await A.j.post('/delivery-notes', { source: { type: 'quotation', id: q.id }, lines: [{ sourceLineId: q.lines[0].id, quantity: 1 }] })).status).toBe(410);
    expect((await A.j.put(`/invoices/${inv.id}`, { customerId: A.customerId, lines: [line(PART, 1)] })).status).toBe(409); expect((await A.j.del(`/invoices/${inv.id}`)).status).toBe(409);
    expect((await A.j.del(`/delivery-notes/${bl.id}`)).status).toBe(409); expect((await A.j.put(`/delivery-notes/${bl.id}`, { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity: 1 }] })).status).toBe(409);
    expect((await A.j.put(`/proformas/${p.id}`, quoteBody(A, [line(PART, 1)]))).status).toBe(409); expect((await A.j.del(`/proformas/${p.id}`)).status).toBe(409);
  });
  it('proforma partiellement livrée : elle n’expire plus et reste livrable', async () => {
    await Proforma.updateOne({ _id: p.id }, { validUntil: new Date(Date.now() - 5 * 86400000) });
    expect((await A.j.get(`/proformas/${p.id}`)).body.status).toBe('pending'); expect((await draftBl(p, [1])).status).toBe(201);
  });
});

describe('brouillons et retours de l’ancien parcours', () => {
  const raw = (c: string) => mongoose.connection.collection(c);
  const oid = (v: string) => new mongoose.Types.ObjectId(v);
  /** Brouillon tel que l'ancien parcours le créait : lié aux BL, sans lien de ligne ni compteur. */
  const legacyDraft = async (bl: Any, quantity: number) => {
    const d = ok(await A.j.post('/invoices', { customerId: A.customerId, lines: [line(PART, quantity)] }), 201);
    await raw('invoices').updateOne({ _id: oid(d.id) }, { $set: { deliveryNoteIds: [oid(bl.id)] } }); await raw('deliverynotes').updateOne({ _id: oid(bl.id) }, { $set: { invoiceId: oid(d.id) } });
    return d.id as string;
  };
  it('brouillon depuis un BL : jamais au-delà du livré ; supprimé, il libère le BL ; validé, il le solde', async () => {
    const p = await proforma([line(PART, 2)]); const bl = await delivered(p, [2]);
    const tooMuch = await legacyDraft(bl, 3); expect((await A.j.post(`/invoices/${tooMuch}/validate`)).body.error.code).toBe('BILLING_EXCEEDED');
    ok(await A.j.del(`/invoices/${tooMuch}`), 204); expect((await A.j.get(`/delivery-notes/${bl.id}`)).body).toMatchObject({ billing: 'none', cancellable: true });
    const good = await legacyDraft(bl, 2); expect((await billing([bl.id])).status).toBe(409); await validateInv(good);
    expect((await tracking(p.id)).lines[0]).toMatchObject({ invoiced: 2, remainingToBill: 0 }); expect((await billing([bl.id])).status).toBe(409);
    // retour : seulement après un avoir « retour » couvrant toute la facture
    expect((await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 1 }])).status).toBe(409);
    await credit(good, 'return'); const stock = await stockQty(PART);
    ok(await giveBack(bl.id, [{ lineId: bl.lines[0].id, quantity: 2 }]), 201); expect(await stockQty(PART)).toBe(stock + 2);
    expect((await tracking(p.id)).lines[0]).toMatchObject({ delivered: 0, invoiced: 0, remainingToDeliver: 2 });
    ok(await A.j.post(`/proformas/${p.id}/cancel`, { reason: 'Ancienne commande soldée' }));
  });
  it('brouillon converti depuis une proforma : suppression et validation', async () => {
    const make = async () => { const p = await proforma([line(PART, 1)]); const d = ok(await A.j.post('/invoices', { customerId: A.customerId, lines: [line(PART, 1)] }), 201);
      await raw('invoices').updateOne({ _id: oid(d.id) }, { $set: { proformaId: oid(p.id) } }); await raw('proformas').updateOne({ _id: oid(p.id) }, { $set: { status: 'converted', invoiceId: oid(d.id) } }); return { p, d }; };
    const a = await make(); expect((await A.j.post(`/proformas/${a.p.id}/cancel`, { reason: 'Brouillon à traiter' })).body.error.details.blockers[0].type).toBe('invoice');
    ok(await A.j.del(`/invoices/${a.d.id}`), 204); expect((await A.j.get(`/proformas/${a.p.id}`)).body).toMatchObject({ status: 'pending', invoiceId: null });
    const b = await make(); await validateInv(b.d.id); const t = await tracking(b.p.id); expect(t).toMatchObject({ legacyFlow: true }); expect(t.lines[0]).toMatchObject({ invoiced: 1, remainingToDeliver: 0 });
    expect((await draftBl(b.p, [1])).status).toBe(409);
  });
});

describe('migration de l’ancien parcours', () => {
  const snapshot = async () => JSON.stringify(await Promise.all(['quotations', 'proformas', 'deliverynotes', 'invoices', 'customers', 'stocklevels', 'stockmovements', 'payments', 'journalentries'].map((c) => mongoose.connection.collection(c).find({ companyId: B.companyId }).sort({ _id: 1 }).toArray())));
  const amounts = async () => JSON.stringify((await Invoice.find({ companyId: B.companyId }).sort({ _id: 1 }).lean()).map((i) => [i.totals, i.status, i.paidMinor]).concat((await Customer.find({ companyId: B.companyId }).sort({ _id: 1 }).lean()).map((c) => [c.balanceMinor] as never)));
  it('anciennes données : jamais de double facturation, même avant migration ; simulation, exécution, relance', async () => {
    const j = B.j; const part = (await j.post('/products', { reference: 'OLD', name: 'Ancien', unitId: B.unitId, vatRateCode: 'T19', salePriceMinor: 100_000 })).body.id as string;
    await stockIn(B, part, 20, 1_000);
    const mk = async () => ok(await j.post('/proformas', quoteBody(B, [line(part, 3)], { globalDiscountMinor: 30_000 })), 201);
    const deliver = async (p: Any, quantity: number) => { const d = ok(await j.post('/delivery-notes', { source: { type: 'proforma', id: p.id }, lines: [{ sourceLineId: p.lines[0].id, quantity }] }), 201); return ok(await j.post(`/delivery-notes/${d.id}/validate`)); };
    // 1. BL facturé par l'ancien parcours : invoiceId, aucun compteur, facture sans lien de ligne
    const p1 = await mk(); const b1 = await deliver(p1, 2);
    const old = ok(await j.post('/invoices', { customerId: B.customerId, lines: [line(part, 2)] }), 201); ok(await j.post(`/invoices/${old.id}/validate`));
    await mongoose.connection.collection('invoices').updateOne({ _id: new mongoose.Types.ObjectId(old.id as string) }, { $set: { deliveryNoteIds: [new mongoose.Types.ObjectId(b1.id as string)] } });
    await mongoose.connection.collection('deliverynotes').updateOne({ _id: new mongoose.Types.ObjectId(b1.id as string) }, { $set: { invoiceId: new mongoose.Types.ObjectId(old.id as string) } });
    // 2. Proforma convertie directement en facture
    const p2 = await mk(); const conv = ok(await j.post('/invoices', { customerId: B.customerId, lines: [line(part, 3)] }), 201); ok(await j.post(`/invoices/${conv.id}/validate`));
    await mongoose.connection.collection('invoices').updateOne({ _id: new mongoose.Types.ObjectId(conv.id as string) }, { $set: { proformaId: new mongoose.Types.ObjectId(p2.id as string) } });
    await mongoose.connection.collection('proformas').updateOne({ _id: new mongoose.Types.ObjectId(p2.id as string) }, { $set: { status: 'converted', invoiceId: new mongoose.Types.ObjectId(conv.id as string) } });
    // Avant migration : protections actives
    const again = await j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b1.id] }); expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_BILLED');
    expect((await j.post(`/delivery-notes/${b1.id}/cancel`, { reason: 'Ancien', returnConfirmed: true })).status).toBe(409);
    expect((await j.post('/delivery-notes', { source: { type: 'proforma', id: p2.id }, lines: [{ sourceLineId: p2.lines[0].id, quantity: 1 }] })).status).toBe(409);
    expect((await j.get(`/proformas/${p1.id}/tracking`)).body.lines[0]).toMatchObject({ delivered: 2, invoiced: 2 });

    const before = await snapshot(); const money = await amounts();
    const dry = (await migrateMission2({ dryRun: true })).companies.find((c) => c.companyId === String(B.companyId))!; expect(await snapshot()).toBe(before);
    expect(dry).toMatchObject({ billedDeliveries: 1, proformaLinesTracked: 2 }); expect(dry.legacy.invoicesFromDeliveries).toHaveLength(1); expect(dry.legacy.invoicesFromProforma).toHaveLength(1);
    expect(dry.anomalies.billingDifferences[0]).toContain(p1.number); // ancienne facture sans la remise : signalée, non corrigée
    const run = (await migrateMission2({})).companies.find((c) => c.companyId === String(B.companyId))!; expect(run.billedDeliveries).toBe(1);
    expect(await amounts()).toBe(money);
    expect((await DeliveryNote.findById(b1.id))!.lines[0]).toMatchObject({ allocatedQty: 2, invoicedQty: 2 }); expect((await Proforma.findById(p1.id))!.lines[0]).toMatchObject({ allocatedQty: 2, invoicedQty: 2 });
    expect((await Proforma.findById(p2.id))!.lines[0]).toMatchObject({ allocatedQty: 3, invoicedQty: 3 });
    const after = await snapshot(); const rerun = (await migrateMission2({})).companies.find((c) => c.companyId === String(B.companyId))!;
    expect(await snapshot()).toBe(after); expect(rerun).toMatchObject({ billedDeliveries: 0, proformaLinesTracked: 0, documentsFlagged: 0, quoteNumbersAdded: 0 });
    // Après migration : le reste de la commande suit le nouveau parcours, au prorata du montant convenu
    const b2 = await deliver(p1, 1); const rest = ok(await j.post('/invoices/from-delivery-notes', { deliveryNoteIds: [b2.id] }), 201);
    expect(rest.totals.totalHtMinor).toBe(90_000); expect(rest.totals.globalDiscountMinor).toBe(10_000);
    expect(await Quotation.countDocuments({ companyId: B.companyId })).toBe(0);
  });
});
