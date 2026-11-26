import { z } from 'zod';
import type { ClientSession, QueryFilter, Types } from 'mongoose';
import { GoodsReceipt, PurchaseInvoice, PurchaseOrder, type PurchaseOrderDoc } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex, objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { assertCanOrder } from '../suppliers/supplier.service.js';
import { rangeFilter } from '../sales/document.http.js';
import { buildPurchaseLines, loadSupplier, purchaseLineBody } from './purchase.builder.js';
import { addressesDto, orderAddresses } from './purchase.addresses.js';

type Id = Types.ObjectId; type Lean = PurchaseOrderDoc & { _id: Id; createdAt?: Date };
export const orderBody = z.object({ supplierAddressId: objectId.nullable().optional(), receivingWarehouseId: objectId.nullable().optional(), supplierId: objectId, orderDate: z.coerce.date().optional(), expectedDate: z.coerce.date().optional(), lines: z.array(purchaseLineBody).min(1).max(300), notes: z.string().trim().max(2000).optional() }).strict();
type Body = z.infer<typeof orderBody>;

export const toDto = (o: Lean) => ({
  id: o._id.toString(), ...addressesDto(o), number: o.number, status: o.status, supplierId: o.supplierId.toString(), supplier: o.supplier, orderDate: o.orderDate, expectedDate: o.expectedDate ?? null, notes: o.notes ?? null, totals: o.totals,
  lines: o.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), productId: l.productId?.toString() ?? null, reference: l.reference ?? null, designation: l.designation, unit: l.unit ?? null, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct ?? 0,
    vat: l.vat, netHtMinor: l.netHtMinor, receivedQty: l.receivedQty ?? 0, invoicedQty: l.invoicedQty ?? 0, remainingQty: Math.max(0, l.quantity - (l.receivedQty ?? 0)) })),
  confirmedAt: o.confirmedAt ?? null, cancelReason: o.cancelReason ?? null, editable: o.status === 'draft', createdAt: o.createdAt });

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; open?: boolean | undefined; supplierId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: QueryFilter<PurchaseOrderDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.supplierId) filter.supplierId = f.supplierId as never;
  if (f.open) filter.status = { $in: ['confirmed', 'partially_received'] } as never; // commandes en cours
  const r = rangeFilter(f.from, f.to); if (r) filter.orderDate = r;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'supplier.name': rx }]; }
  const [items, total] = await Promise.all([PurchaseOrder.find(filter).select('-lines').sort(buildSort(f.sort, ['number', 'orderDate', 'createdAt'], { orderDate: -1, _id: -1 })).skip((f.page - 1) * f.limit).limit(f.limit).lean(), PurchaseOrder.countDocuments(filter)]);
  return { items: items.map((o) => ({ ...toDto({ ...o, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const o = await PurchaseOrder.findOne({ _id: id, companyId }).session(session ?? null).lean(); if (!o) throw AppError.notFound('Commande introuvable'); return o as Lean; }
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

export async function create(companyId: Id, userId: Id, b: Body) {
  const date = startOfDay(b.orderDate ?? new Date()); await ensureCounter(companyId, 'purchaseOrder', date);
  return withTransaction(async (session) => {
    const sup = await loadSupplier(companyId, b.supplierId, session); const built = await buildPurchaseLines(companyId, b.lines, date, session, { checkStatus: true });
    const number = await nextDocumentNumber(companyId, 'purchaseOrder', session, date);
    const addresses = await orderAddresses(companyId, sup, b, session);
    const [o] = await PurchaseOrder.create([{ ...addresses, companyId, number, supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, orderDate: date, expectedDate: b.expectedDate, lines: built.lines, totals: built.totals, notes: b.notes, createdBy: userId }] as never[], { session });
    return toDto(o!.toObject() as Lean);
  });
}
export async function update(companyId: Id, id: string, b: Body) {
  const cur = await getOwn(companyId, id); if (cur.status !== 'draft') throw AppError.conflict('Seule une commande en brouillon est modifiable');
  const date = startOfDay(b.orderDate ?? cur.orderDate);
  return withTransaction(async (session) => {
    const sup = await loadSupplier(companyId, b.supplierId, session); const built = await buildPurchaseLines(companyId, b.lines, date, session, { checkStatus: true });
    const addresses = await orderAddresses(companyId, sup, b, session, String(cur.supplierId) === String(sup._id) ? cur : { receivingAddress: cur.receivingAddress });
    const u = await PurchaseOrder.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { ...addresses, supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, orderDate: date, expectedDate: b.expectedDate, lines: built.lines, totals: built.totals, notes: b.notes } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La commande a changé entre-temps'); return toDto(u as Lean);
  });
}
export async function remove(companyId: Id, id: string) { const o = await getOwn(companyId, id); if (o.status !== 'draft') throw AppError.conflict('Seule une commande en brouillon se supprime : annulez une commande confirmée'); await PurchaseOrder.deleteOne({ _id: id, companyId, status: 'draft' }); return o; }

/** Validation (confirmation) : contrôle le blocage fournisseur (solde impayé > seuil paramétré). */
export async function confirm(companyId: Id, id: string) {
  return withTransaction(async (session) => {
    const o = await getOwn(companyId, id, session); if (o.status !== 'draft') throw AppError.conflict('Commande déjà confirmée ou annulée');
    await assertCanOrder(companyId, o.supplierId, session);
    const u = await PurchaseOrder.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'confirmed', confirmedAt: new Date() }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La commande a changé entre-temps'); return toDto(u as Lean);
  });
}
/** Annulation : impossible dès qu'une réception a été validée ou qu'une facture existe. */
export async function cancel(companyId: Id, id: string, reason: string) {
  return withTransaction(async (session) => {
    const o = await getOwn(companyId, id, session);
    if (o.status !== 'confirmed') throw AppError.conflict(o.status === 'draft' ? 'Brouillon : supprimez-le' : 'Annulation impossible : commande déjà réceptionnée ou annulée');
    if (await GoodsReceipt.exists({ companyId, purchaseOrderId: o._id, status: 'validated' }).session(session) || await PurchaseInvoice.exists({ companyId, purchaseOrderId: o._id }).session(session)) throw AppError.conflict('Annulation impossible : réceptions ou factures liées');
    const u = await PurchaseOrder.findOneAndUpdate({ _id: id, companyId, status: 'confirmed' }, { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La commande a changé entre-temps'); await GoodsReceipt.deleteMany({ companyId, purchaseOrderId: o._id, status: 'draft' }, { session });
    return toDto(u as Lean);
  });
}

/** Rapprochement commande / réception / facture : écarts de quantité et de prix, ligne par ligne. */
export async function reconciliation(companyId: Id, id: string) {
  const o = await getOwn(companyId, id);
  const invoices = await PurchaseInvoice.find({ companyId, purchaseOrderId: o._id, status: 'validated' }).lean();
  const lines = o.lines.map((l) => {
    const lid = (l as { _id: Id })._id.toString(); const inv = invoices.flatMap((i) => i.lines.filter((x) => String(x.orderLineId) === lid));
    const invoiced = inv.reduce((s, x) => s + x.quantity, 0); const invoicedValue = inv.reduce((s, x) => s + (x.netHtMinor ?? 0), 0);
    const received = l.receivedQty ?? 0; const priceDiffMinor = inv.length ? invoicedValue - Math.round((l.netHtMinor ?? 0) * (invoiced / l.quantity)) : 0;
    const flags = [received < l.quantity ? 'Reçu < commandé' : '', invoiced > received ? 'Facturé > reçu' : '', invoiced < received ? 'Reçu non facturé' : '', priceDiffMinor !== 0 ? 'Écart de prix' : ''].filter(Boolean);
    return { lineId: lid, designation: l.designation, ordered: l.quantity, received, invoiced, receivedNotInvoiced: Math.max(0, received - invoiced), missing: Math.max(0, l.quantity - received), orderNetHtMinor: l.netHtMinor, invoicedNetHtMinor: invoicedValue, priceDiffMinor, flags };
  });
  return { orderId: id, number: o.number, status: o.status, lines, hasVariance: lines.some((l) => l.flags.some((f) => f !== 'Reçu non facturé' || false) && l.flags.length > 0 && l.flags.filter((f) => f !== 'Reçu non facturé').length > 0) };
}
