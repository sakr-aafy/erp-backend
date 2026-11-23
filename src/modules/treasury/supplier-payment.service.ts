import { z } from 'zod';
import type { QueryFilter, Types } from 'mongoose';
import { SupplierPayment, TreasuryAccount, type SupplierPaymentDoc } from '../../models/finance.model.js';
import { PurchaseInvoice } from '../../models/logistics.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { PAYMENT_METHODS } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureFinanceCounters } from '../../services/accounting.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { rangeFilter } from '../sales/document.http.js';

type Id = Types.ObjectId;
const statusOf = (ttc: number, paid: number): 'unpaid' | 'partial' | 'paid' => (paid <= 0 ? 'unpaid' : paid >= ttc ? 'paid' : 'partial');

export const paymentBody = z.object({
  supplierId: objectId, treasuryAccountId: objectId, method: z.enum(PAYMENT_METHODS), paidAt: z.coerce.date().optional(), reference: z.string().trim().max(100).optional(), note: z.string().trim().max(300).optional(),
  allocations: z.array(z.object({ purchaseInvoiceId: objectId, amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(100),
}).strict();
export const dto = (p: SupplierPaymentDoc & { _id: Id; createdAt?: Date }) => ({ id: p._id.toString(), number: p.number, supplierId: p.supplierId.toString(), supplierName: p.supplier?.name ?? null, treasuryAccountId: p.treasuryAccountId.toString(), amountMinor: p.amountMinor, method: p.method,
  paidAt: p.paidAt, reference: p.reference ?? null, note: p.note ?? null, status: p.status, cancelReason: p.cancelReason ?? null, allocations: p.allocations.map((a) => ({ purchaseInvoiceId: a.purchaseInvoiceId.toString(), number: a.number ?? null, amountMinor: a.amountMinor })), createdAt: p.createdAt });

/**
 * Règlement fournisseur (partiel ou groupé) : affecté à une ou plusieurs factures d'achat validées du fournisseur, jamais au-delà du reste dû.
 * Solde fournisseur décrémenté ; l'événement `supplierPayment.recorded` crée le mouvement de trésorerie (sortie) puis l'écriture comptable.
 */
export async function record(companyId: Id, userId: Id, b: z.infer<typeof paymentBody>) {
  const paidAt = startOfDay(b.paidAt ?? new Date()); if (paidAt > startOfDay(new Date())) throw AppError.badRequest('Date de règlement dans le futur');
  const ids = b.allocations.map((a) => a.purchaseInvoiceId); if (new Set(ids).size !== ids.length) throw AppError.badRequest('Une facture ne peut apparaître qu’une fois dans les affectations');
  await ensureCounter(companyId, 'supplierPayment', paidAt); await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const sup = await Supplier.findOne({ _id: b.supplierId, companyId }).session(session).lean(); if (!sup) throw AppError.notFound('Fournisseur introuvable');
    if (!(await TreasuryAccount.exists({ _id: b.treasuryAccountId, companyId, isActive: true }).session(session))) throw AppError.badRequest('Compte de trésorerie introuvable ou inactif');
    const allocations: { purchaseInvoiceId: Id; number?: string; amountMinor: number }[] = [];
    for (const a of b.allocations) {
      const inv = await PurchaseInvoice.findOne({ _id: a.purchaseInvoiceId, companyId }).session(session).lean();
      if (!inv || String(inv.supplierId) !== String(sup._id)) throw AppError.badRequest('Facture d’achat introuvable pour ce fournisseur');
      if (inv.status !== 'validated') throw AppError.conflict('Seules les factures d’achat validées se règlent');
      const ttc = inv.totals.totalTtcMinor ?? 0; const open = ttc - (inv.paidMinor ?? 0);
      if (a.amountMinor > open) throw AppError.conflict(`Facture ${inv.number} : montant supérieur au reste dû (${open})`);
      // Garde de concurrence : la facture n'est mise à jour que si son payé n'a pas changé
      const u = await PurchaseInvoice.findOneAndUpdate({ _id: inv._id, companyId, paidMinor: inv.paidMinor ?? 0 }, { $inc: { paidMinor: a.amountMinor } }, { returnDocument: 'after', session }).lean();
      if (!u) throw AppError.conflict(`Facture ${inv.number} : un autre règlement vient d’être enregistré, réessayez`);
      await PurchaseInvoice.updateOne({ _id: inv._id }, { paymentStatus: statusOf(ttc, u.paidMinor ?? 0) }, { session });
      allocations.push({ purchaseInvoiceId: inv._id, ...(inv.number && { number: inv.number }), amountMinor: a.amountMinor });
    }
    const total = allocations.reduce((s, a) => s + a.amountMinor, 0);
    const number = await nextDocumentNumber(companyId, 'supplierPayment', session, paidAt);
    const [p] = await SupplierPayment.create([{ companyId, number, supplierId: sup._id, supplier: { name: sup.name }, treasuryAccountId: b.treasuryAccountId, amountMinor: total, method: b.method, paidAt, reference: b.reference, note: b.note, allocations, createdBy: userId }] as never[], { session });
    await Supplier.updateOne({ _id: sup._id, companyId }, { $inc: { balanceMinor: -total } }, { session });
    await emitDomainEvent('supplierPayment.recorded', { companyId, documentId: p!._id, session, userId, documentNumber: number });
    return dto(p!.toObject() as never);
  });
}
export async function cancel(companyId: Id, userId: Id, id: string, reason: string) {
  await ensureFinanceCounters(companyId);
  return withTransaction(async (session) => {
    const p = await SupplierPayment.findOneAndUpdate({ _id: id, companyId, status: 'active' }, { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!p) throw AppError.conflict('Règlement introuvable ou déjà annulé');
    for (const a of p.allocations) {
      const u = await PurchaseInvoice.findOneAndUpdate({ _id: a.purchaseInvoiceId, companyId }, { $inc: { paidMinor: -a.amountMinor } }, { returnDocument: 'after', session }).lean();
      if (u) await PurchaseInvoice.updateOne({ _id: u._id }, { paymentStatus: statusOf(u.totals.totalTtcMinor ?? 0, u.paidMinor ?? 0) }, { session });
    }
    await Supplier.updateOne({ _id: p.supplierId, companyId }, { $inc: { balanceMinor: p.amountMinor } }, { session });
    await emitDomainEvent('supplierPayment.cancelled', { companyId, documentId: p._id, session, userId, documentNumber: p.number }); // lève 409 si le mouvement est rapproché → tout est annulé
    return dto(p as never);
  });
}
export async function list(companyId: Id, f: { supplierId?: string | undefined; status?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number }) {
  const filter: QueryFilter<SupplierPaymentDoc> = { companyId }; if (f.supplierId) filter.supplierId = f.supplierId as never; if (f.status) filter.status = f.status as never; const r = rangeFilter(f.from, f.to); if (r) filter.paidAt = r;
  const [items, total] = await Promise.all([SupplierPayment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), SupplierPayment.countDocuments(filter)]);
  return { items: items.map((p) => dto(p as never)), total, page: f.page, limit: f.limit };
}
export async function get(companyId: Id, id: string) { const p = await SupplierPayment.findOne({ _id: id, companyId }).lean(); if (!p) throw AppError.notFound('Règlement introuvable'); return dto(p as never); }
