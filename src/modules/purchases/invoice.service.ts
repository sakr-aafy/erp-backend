import { z } from 'zod';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureFinanceCounters } from '../../services/accounting.service.js';
import type { ClientSession, QueryFilter, Types } from 'mongoose';
import { PurchaseInvoice, PurchaseOrder, type PurchaseInvoiceDoc } from '../../models/logistics.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex, objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { rangeFilter } from '../sales/document.http.js';
import { buildPurchaseLines, loadSupplier, purchaseLineBody } from './purchase.builder.js';

type Id = Types.ObjectId; type Lean = PurchaseInvoiceDoc & { _id: Id; createdAt?: Date };
export const invoiceBody = z.object({ supplierId: objectId, purchaseOrderId: objectId.optional(), supplierInvoiceNumber: z.string().trim().min(1).max(60), invoiceDate: z.coerce.date().optional(), dueDate: z.coerce.date().optional(),
  lines: z.array(purchaseLineBody).min(1).max(300), notes: z.string().trim().max(2000).optional() }).strict();
type Body = z.infer<typeof invoiceBody>;

export const toDto = (i: Lean) => ({ id: i._id.toString(), number: i.number ?? null, supplierInvoiceNumber: i.supplierInvoiceNumber, status: i.status, supplierId: i.supplierId.toString(), supplier: i.supplier, purchaseOrderId: i.purchaseOrderId?.toString() ?? null,
  invoiceDate: i.invoiceDate, dueDate: i.dueDate ?? null, totals: i.totals, notes: i.notes ?? null, variances: i.variances ?? [], editable: i.status === 'draft',
  lines: i.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), orderLineId: l.orderLineId?.toString() ?? null, productId: l.productId?.toString() ?? null, reference: l.reference ?? null, designation: l.designation, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct ?? 0, vat: l.vat, netHtMinor: l.netHtMinor })),
  validatedAt: i.validatedAt ?? null, paidMinor: i.paidMinor ?? 0, paymentStatus: i.paymentStatus ?? 'unpaid', balanceDueMinor: i.status === 'validated' ? (i.totals.totalTtcMinor ?? 0) - (i.paidMinor ?? 0) : null, createdAt: i.createdAt });

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; supplierId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: QueryFilter<PurchaseInvoiceDoc> = { companyId }; if (f.status) filter.status = f.status as never; if (f.supplierId) filter.supplierId = f.supplierId as never;
  const r = rangeFilter(f.from, f.to); if (r) filter.invoiceDate = r;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { supplierInvoiceNumber: rx }, { 'supplier.name': rx }]; }
  const [items, total] = await Promise.all([PurchaseInvoice.find(filter).select('-lines').sort(buildSort(f.sort, ['number', 'invoiceDate', 'createdAt'], { invoiceDate: -1, _id: -1 })).skip((f.page - 1) * f.limit).limit(f.limit).lean(), PurchaseInvoice.countDocuments(filter)]);
  return { items: items.map((i) => ({ ...toDto({ ...i, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const i = await PurchaseInvoice.findOne({ _id: id, companyId }).session(session ?? null).lean(); if (!i) throw AppError.notFound('Facture d’achat introuvable'); return i as Lean; }
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

async function build(companyId: Id, b: Body, session: ClientSession) {
  const sup = await loadSupplier(companyId, b.supplierId, session, true); const date = startOfDay(b.invoiceDate ?? new Date());
  if (b.purchaseOrderId) {
    const po = await PurchaseOrder.findOne({ _id: b.purchaseOrderId, companyId }).session(session).lean();
    if (!po || String(po.supplierId) !== String(sup._id)) throw AppError.badRequest('Commande introuvable pour ce fournisseur');
    if (b.lines.some((l) => !l.orderLineId)) throw AppError.badRequest('Chaque ligne doit référencer une ligne de la commande');
  }
  const built = await buildPurchaseLines(companyId, b.lines, date, session);
  return { sup, date, ...built };
}
export async function create(companyId: Id, userId: Id, b: Body) {
  return withTransaction(async (session) => {
    const { sup, date, lines, totals } = await build(companyId, b, session);
    const [i] = await PurchaseInvoice.create([{ companyId, supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, supplierInvoiceNumber: b.supplierInvoiceNumber, purchaseOrderId: b.purchaseOrderId, invoiceDate: date, dueDate: b.dueDate, lines, totals, notes: b.notes, createdBy: userId }] as never[], { session });
    return toDto(i!.toObject() as Lean);
  });
}
export async function update(companyId: Id, id: string, b: Body) {
  return withTransaction(async (session) => {
    const cur = await getOwn(companyId, id, session); if (cur.status !== 'draft') throw AppError.conflict('Facture d’achat validée : non modifiable');
    const { sup, date, lines, totals } = await build(companyId, b, session);
    const u = await PurchaseInvoice.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, supplierInvoiceNumber: b.supplierInvoiceNumber, purchaseOrderId: b.purchaseOrderId ?? null, invoiceDate: date, dueDate: b.dueDate, lines, totals, notes: b.notes } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La facture a changé entre-temps'); return toDto(u as Lean);
  });
}
export async function remove(companyId: Id, id: string) { const i = await getOwn(companyId, id); if (i.status !== 'draft') throw AppError.conflict('Une facture d’achat validée ne se supprime pas'); await PurchaseInvoice.deleteOne({ _id: id, companyId, status: 'draft' }); return i; }

/** Pré-remplissage depuis une commande : quantités reçues et non encore facturées, prix de la commande. */
export async function draftFromOrder(companyId: Id, orderId: string) {
  const po = await PurchaseOrder.findOne({ _id: orderId, companyId }).lean(); if (!po) throw AppError.notFound('Commande introuvable');
  return { supplierId: po.supplierId.toString(), purchaseOrderId: orderId, lines: po.lines.filter((l) => (l.receivedQty ?? 0) - (l.invoicedQty ?? 0) > 1e-9).map((l) => ({ orderLineId: (l as { _id: Id })._id.toString(), productId: l.productId?.toString(), designation: l.designation,
    quantity: (l.receivedQty ?? 0) - (l.invoicedQty ?? 0), unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct ?? 0, vatCode: l.vat?.code })) };
}

/**
 * VALIDATION : contrôle à 3 voies. On ne facture pas plus que reçu (par ligne de commande) ; les écarts de prix sont consignés
 * (non bloquants) ; numéro interne FA- ; solde dû au fournisseur augmenté du TTC.
 */
export async function validate(companyId: Id, userId: Id, id: string) {
  await ensureFinanceCounters(companyId);
  const pre = await getOwn(companyId, id); await ensureCounter(companyId, 'purchaseInvoice', startOfDay(pre.invoiceDate));
  return withTransaction(async (session) => {
    const inv = await getOwn(companyId, id, session); if (inv.status !== 'draft') throw AppError.conflict('Facture déjà validée');
    const variances: { lineId?: Id; type: string; message: string; ordered?: number; received?: number; invoiced?: number; orderPriceMinor?: number; invoicePriceMinor?: number }[] = [];
    if (inv.purchaseOrderId) {
      const po = await PurchaseOrder.findOne({ _id: inv.purchaseOrderId, companyId }).session(session);
      if (!po || po.status === 'cancelled' || po.status === 'draft') throw AppError.conflict('Commande non facturable');
      for (const l of inv.lines) {
        const ol = po.lines.find((x) => String((x as { _id: Id })._id) === String(l.orderLineId)); if (!ol) throw AppError.conflict(`Ligne « ${l.designation} » : ligne de commande introuvable`);
        const room = (ol.receivedQty ?? 0) - (ol.invoicedQty ?? 0);
        if (l.quantity > room + 1e-9) throw AppError.conflict(`« ${l.designation} » : facturé ${l.quantity} > reçu non encore facturé ${room}`);
        if (l.unitPriceMinor !== ol.unitPriceMinor || (l.discountPct ?? 0) !== (ol.discountPct ?? 0)) variances.push({ lineId: (l as { _id: Id })._id, type: 'price', message: `Écart de prix sur « ${l.designation} »`, ordered: ol.quantity, received: ol.receivedQty ?? 0, invoiced: l.quantity, orderPriceMinor: ol.unitPriceMinor, invoicePriceMinor: l.unitPriceMinor });
        ol.invoicedQty = (ol.invoicedQty ?? 0) + l.quantity;
      }
      await po.save({ session });
    }
    const number = await nextDocumentNumber(companyId, 'purchaseInvoice', session, startOfDay(inv.invoiceDate));
    const u = await PurchaseInvoice.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', number, validatedAt: new Date(), validatedBy: userId, variances }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La facture a changé entre-temps');
    await Supplier.updateOne({ _id: inv.supplierId, companyId }, { $inc: { balanceMinor: inv.totals.totalTtcMinor ?? 0 } }, { session }); // solde dû (réglé par les règlements fournisseurs)
    await emitDomainEvent('purchaseInvoice.validated', { companyId, documentId: inv._id, session, userId, documentNumber: number });
    return toDto(u as Lean);
  });
}
