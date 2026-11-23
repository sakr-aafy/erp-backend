import type { Types } from 'mongoose';
import { Invoice, Payment } from '../../models/sales.model.js';
import { PurchaseInvoice } from '../../models/logistics.model.js';
import { Expense, SupplierPayment, TreasuryAccount, TreasuryMovement, TreasuryTransfer, JournalEntry } from '../../models/finance.model.js';
import { onDomainEvent, type EventContext } from '../../services/domain-events.js';
import { recordMovement, reverseBySource } from '../../services/treasury.service.js';
import { postEntry, swapSides, type EntryLineInput } from '../../services/accounting.service.js';
import { startOfDay } from '../../services/fiscal.service.js';

type Id = Types.ObjectId;
type Totals = { totalHtMinor?: number | null; totalTtcMinor?: number | null; totalVatMinor?: number | null; stampMinor?: number | null; withholdingMinor?: number | null; totalPayableMinor?: number | null; vatGroups?: { vatCode?: string | null; vatMinor?: number | null }[] };
const n = (v: number | null | undefined) => v ?? 0;

/** Lignes d'écriture d'une facture de vente (sens « facture » ; l'avoir applique `swapSides`). */
export function salesEntryLines(t: Totals, customerId: Id): EntryLineInput[] {
  const lines: EntryLineInput[] = [
    { role: 'customer', label: 'Client', debitMinor: n(t.totalPayableMinor), thirdPartyId: customerId },
    { role: 'withholding', label: 'Retenue à la source', debitMinor: n(t.withholdingMinor) },
    { role: 'sales', label: 'Ventes HT', creditMinor: n(t.totalHtMinor) },
    { role: 'stamp', label: 'Timbre fiscal', creditMinor: n(t.stampMinor) },
  ];
  const groups = t.vatGroups ?? [];
  for (const g of groups) lines.push({ role: 'vat_collected', label: `TVA collectée ${g.vatCode ?? ''}`.trim(), creditMinor: n(g.vatMinor) });
  return lines;
}
export function purchaseEntryLines(t: Totals, supplierId: Id): EntryLineInput[] {
  const vat = (t.vatGroups ?? []).reduce((s, g) => s + n(g.vatMinor), 0); const ttc = n(t.totalTtcMinor);
  const lines: EntryLineInput[] = [{ role: 'purchases', label: 'Achats HT', debitMinor: ttc - vat }, { role: 'supplier', label: 'Fournisseur', creditMinor: ttc, thirdPartyId: supplierId }];
  for (const g of t.vatGroups ?? []) lines.push({ role: 'vat_deductible', label: `TVA déductible ${g.vatCode ?? ''}`.trim(), debitMinor: n(g.vatMinor) });
  return lines;
}

async function saleEntry(ctx: EventContext, credit: boolean) {
  const inv = await Invoice.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!inv) return;
  const base = salesEntryLines(inv.totals as Totals, inv.customerId);
  const r = await postEntry({ companyId: ctx.companyId, session: ctx.session, journal: 'sales', date: inv.issueDate, label: `${credit ? 'Avoir' : 'Facture'} ${inv.number} — ${inv.customerSnapshot?.name ?? ''}`.trim(), eventKey: `${credit ? 'creditNote' : 'invoice'}.validated:${inv._id}`,
    source: { type: credit ? 'creditNote' : 'invoice', id: inv._id, number: inv.number ?? undefined }, lines: credit ? swapSides(base) : base, reversal: credit });
  return { movements: r.entry && !r.duplicate ? 1 : 0 };
}

export function registerFinanceHandlers() {
  // ---------- Comptabilité : écritures automatiques (journal des ventes / achats) ----------
  onDomainEvent('invoice.validated', (ctx) => saleEntry(ctx, false), 'accounting');
  onDomainEvent('creditNote.validated', (ctx) => saleEntry(ctx, true), 'accounting');
  onDomainEvent('purchaseInvoice.validated', async (ctx) => {
    const inv = await PurchaseInvoice.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!inv) return;
    const r = await postEntry({ companyId: ctx.companyId, session: ctx.session, journal: 'purchases', date: inv.invoiceDate, label: `Facture d’achat ${inv.number} — ${inv.supplier?.name ?? ''}`.trim(), eventKey: `purchaseInvoice.validated:${inv._id}`,
      source: { type: 'purchaseInvoice', id: inv._id, number: inv.number ?? undefined }, lines: purchaseEntryLines(inv.totals as Totals, inv.supplierId) });
    return { movements: r.entry && !r.duplicate ? 1 : 0 };
  }, 'accounting');

  // Encaissement SANS compte de trésorerie : écriture de caisse « non rattachée » pour garder le compte client cohérent
  onDomainEvent('payment.recorded', async (ctx) => {
    const p = await Payment.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!p || p.treasuryAccountId) return;
    const inv = await Invoice.findById(p.invoiceId).session(ctx.session).select('number').lean();
    const r = await postEntry({ companyId: ctx.companyId, session: ctx.session, journal: 'cash', date: p.paidAt, label: `Encaissement ${inv?.number ?? ''} (sans compte de trésorerie)`.trim(), eventKey: `payment.recorded:${p._id}:entry`,
      source: { type: 'payment', id: p._id, number: inv?.number ?? undefined }, lines: [{ role: 'cash', label: 'Encaissement', debitMinor: p.amountMinor }, { role: 'customer', label: 'Client', creditMinor: p.amountMinor, thirdPartyId: p.customerId }] });
    return { movements: r.entry && !r.duplicate ? 1 : 0 };
  }, 'accounting');
  onDomainEvent('payment.cancelled', async (ctx) => {
    const p = await Payment.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!p || p.treasuryAccountId) return;
    const orig = await JournalEntry.findOne({ companyId: ctx.companyId, eventKey: `payment.recorded:${p._id}:entry` }).session(ctx.session).lean(); if (!orig) return;
    const r = await postEntry({ companyId: ctx.companyId, session: ctx.session, journal: 'cash', date: new Date(), label: `Annulation — ${orig.label}`, eventKey: `payment.cancelled:${p._id}:entry`, source: orig.source as never, reversal: true,
      lines: swapSides(orig.lines.map((l) => ({ role: l.role, label: l.label ?? undefined, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0, thirdPartyId: l.thirdPartyId ?? undefined }))) });
    return { movements: r.entry && !r.duplicate ? 1 : 0 };
  }, 'accounting');

  // Mouvement de trésorerie → écriture du journal de caisse / banque
  onDomainEvent('treasuryMovement.recorded', async (ctx) => {
    const m = await TreasuryMovement.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!m) return;
    const acc = await TreasuryAccount.findById(m.accountId).session(ctx.session).lean(); if (!acc) return;
    const treasuryRole = acc.type === 'cash' ? 'cash' : 'bank'; const amt = m.amountMinor; const inflow = m.direction === 'in';
    let counter: EntryLineInput;
    const orig = m.reversalOf ? await TreasuryMovement.findById(m.reversalOf).session(ctx.session).lean() : null;
    const kind = orig?.kind ?? m.kind; const exp = kind === 'expense' ? await Expense.findById(m.source?.id).session(ctx.session).select('categoryAccountCode categoryName').lean() : null;
    if (kind === 'customer_receipt') counter = { role: 'customer', label: 'Client', thirdPartyId: m.thirdParty?.id ?? undefined };
    else if (kind === 'supplier_payment') counter = { role: 'supplier', label: 'Fournisseur', thirdPartyId: m.thirdParty?.id ?? undefined };
    else if (kind === 'expense') counter = { role: 'expense', label: exp?.categoryName ?? 'Dépense', accountCode: exp?.categoryAccountCode ?? undefined };
    else counter = { role: 'internal_transfer', label: 'Virement interne' };
    const lines: EntryLineInput[] = [
      { role: treasuryRole, label: acc.name, accountCode: acc.accountCode ?? undefined, treasuryAccountId: acc._id, ...(inflow ? { debitMinor: amt } : { creditMinor: amt }) },
      { ...counter, ...(inflow ? { creditMinor: amt } : { debitMinor: amt }) },
    ];
    const r = await postEntry({ companyId: ctx.companyId, session: ctx.session, journal: acc.type === 'cash' ? 'cash' : 'bank', date: m.date, label: m.label, eventKey: `treasuryMovement.recorded:${m._id}`,
      source: { type: m.source?.type ?? 'treasury', id: (m.source?.id ?? m._id) as Id, number: m.source?.number ?? undefined }, lines, reversal: !!m.reversalOf });
    return { movements: r.entry && !r.duplicate ? 1 : 0 };
  }, 'accounting');

  // ---------- Trésorerie : mouvements issus des événements métier ----------
  onDomainEvent('payment.recorded', async (ctx) => {
    const p = await Payment.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!p?.treasuryAccountId) return;
    const [inv] = await Promise.all([Invoice.findById(p.invoiceId).session(ctx.session).select('number customerSnapshot').lean()]);
    const r = await recordMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, accountId: p.treasuryAccountId, direction: 'in', amountMinor: p.amountMinor, date: p.paidAt, kind: 'customer_receipt',
      label: `Encaissement facture ${inv?.number ?? ''} — ${inv?.customerSnapshot?.name ?? ''}`.trim(), eventKey: `payment.recorded:${p._id}`, source: { type: 'payment', id: p._id, number: inv?.number ?? undefined },
      thirdParty: { type: 'customer', id: p.customerId, name: inv?.customerSnapshot?.name ?? undefined }, method: p.method, reference: p.reference ?? undefined });
    return { movements: r.duplicate ? 0 : 1 };
  }, 'treasury');
  onDomainEvent('payment.cancelled', async (ctx) => {
    const r = await reverseBySource(ctx.companyId, ctx.session, ctx.userId, `payment.recorded:${ctx.documentId}`, `payment.cancelled:${ctx.documentId}`, 'Annulation d’un encaissement');
    return { movements: r && !r.duplicate ? 1 : 0 };
  }, 'treasury');

  onDomainEvent('supplierPayment.recorded', async (ctx) => {
    const p = await SupplierPayment.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!p) return;
    const r = await recordMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, accountId: p.treasuryAccountId, direction: 'out', amountMinor: p.amountMinor, date: p.paidAt, kind: 'supplier_payment',
      label: `Règlement ${p.number} — ${p.supplier?.name ?? ''}`.trim(), eventKey: `supplierPayment.recorded:${p._id}`, source: { type: 'supplierPayment', id: p._id, number: p.number }, thirdParty: { type: 'supplier', id: p.supplierId, name: p.supplier?.name ?? undefined }, method: p.method, reference: p.reference ?? undefined });
    return { movements: r.duplicate ? 0 : 1 };
  }, 'treasury');
  onDomainEvent('supplierPayment.cancelled', async (ctx) => {
    const r = await reverseBySource(ctx.companyId, ctx.session, ctx.userId, `supplierPayment.recorded:${ctx.documentId}`, `supplierPayment.cancelled:${ctx.documentId}`, 'Annulation d’un règlement fournisseur');
    return { movements: r && !r.duplicate ? 1 : 0 };
  }, 'treasury');

  onDomainEvent('expense.validated', async (ctx) => {
    const e = await Expense.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!e?.treasuryAccountId) return;
    const r = await recordMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, accountId: e.treasuryAccountId, direction: 'out', amountMinor: e.amountMinor, date: e.date, kind: 'expense',
      label: `Dépense ${e.number} — ${e.beneficiary}`, eventKey: `expense.validated:${e._id}`, source: { type: 'expense', id: e._id, number: e.number }, method: e.method, reference: e.reference ?? undefined });
    return { movements: r.duplicate ? 0 : 1 };
  }, 'treasury');
  onDomainEvent('expense.cancelled', async (ctx) => {
    const r = await reverseBySource(ctx.companyId, ctx.session, ctx.userId, `expense.validated:${ctx.documentId}`, `expense.cancelled:${ctx.documentId}`, 'Annulation d’une dépense');
    return { movements: r && !r.duplicate ? 1 : 0 };
  }, 'treasury');

  onDomainEvent('treasuryTransfer.recorded', async (ctx) => {
    const t = await TreasuryTransfer.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean(); if (!t) return;
    const base = { companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, amountMinor: t.amountMinor, date: t.date, kind: 'transfer' as const, source: { type: 'treasuryTransfer', id: t._id, number: t.number } };
    const a = await recordMovement({ ...base, accountId: t.fromAccountId, direction: 'out', label: `Virement ${t.number} (sortie)`, eventKey: `treasuryTransfer.recorded:${t._id}:out` });
    const b = await recordMovement({ ...base, accountId: t.toAccountId, direction: 'in', label: `Virement ${t.number} (entrée)`, eventKey: `treasuryTransfer.recorded:${t._id}:in` });
    return { movements: (a.duplicate ? 0 : 1) + (b.duplicate ? 0 : 1) };
  }, 'treasury');
  onDomainEvent('treasuryTransfer.cancelled', async (ctx) => {
    let k = 0;
    for (const side of ['out', 'in']) { const r = await reverseBySource(ctx.companyId, ctx.session, ctx.userId, `treasuryTransfer.recorded:${ctx.documentId}:${side}`, `treasuryTransfer.cancelled:${ctx.documentId}:${side}`, 'Annulation d’un virement interne'); if (r && !r.duplicate) k++; }
    return { movements: k };
  }, 'treasury');
}
export { startOfDay };
