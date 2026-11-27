import { z } from 'zod';
import type { ClientSession, Types } from 'mongoose';
import { GoodsReceipt, PurchaseOrder, Warehouse, type GoodsReceiptDoc } from '../../models/logistics.model.js';
import { Product } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureLevels } from '../../services/stock.service.js';
import { proportion } from '../../services/calculation.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { Supplier } from '../../models/supplier.model.js';
import { resolveAddress, type AddressSnapshot } from '../parties/delivery-address.js';
import { addressesDto, receivingSnapshot } from './purchase.addresses.js';
import { assertQuantities, carriedOver } from '../products/units.js';

type Id = Types.ObjectId; type Lean = GoodsReceiptDoc & { _id: Id; createdAt?: Date };
export const receiptBody = z.object({
  /** Adresse du fournisseur : absente = celle de la commande ; null = aucune. */
  supplierAddressId: objectId.nullable().optional(),
  purchaseOrderId: objectId, warehouseId: objectId, receiptDate: z.coerce.date().optional(), deliveryNoteRef: z.string().trim().max(60).optional(), notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ orderLineId: objectId, quantity: z.number().gt(0).max(1e9), serials: z.array(z.string().trim().min(1)).max(1000).optional() }).strict()).min(1).max(300),
}).strict();
type Body = z.infer<typeof receiptBody>;

export const toDto = (r: Lean) => ({ ...addressesDto(r), id: r._id.toString(), number: r.number, status: r.status, purchaseOrderId: r.purchaseOrderId?.toString() ?? null, importFileId: r.importFileId?.toString() ?? null, supplier: r.supplier, warehouseId: r.warehouseId!.toString(),
  receiptDate: r.receiptDate, deliveryNoteRef: r.deliveryNoteRef ?? null, notes: r.notes ?? null, validatedAt: r.validatedAt ?? null, editable: r.status === 'draft' && !r.importFileId,
  lines: r.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), orderLineId: l.orderLineId?.toString() ?? null, productId: l.productId!.toString(), designation: l.designation ?? null, quantity: l.quantity, unitCostMinor: l.unitCostMinor ?? 0, extraUnitCostMinor: l.extraUnitCostMinor ?? 0, valueMinor: l.valueMinor ?? 0, serials: l.serials ?? [] })), createdAt: r.createdAt });

/** Adresses copiées sur la réception : fournisseur (celle de la commande par défaut) et magasin de réception choisi. */
async function receiptAddresses(companyId: Id, b: Body, supplierId: Id, inherited: unknown, session: ClientSession) {
  const supplier = await Supplier.findOne({ _id: supplierId, companyId }).session(session).lean();
  if (!supplier) throw AppError.badRequest('Fournisseur invalide');
  return {
    supplierAddress: resolveAddress(supplier, b.supplierAddressId, inherited as AddressSnapshot | null | undefined),
    receivingAddress: await receivingSnapshot(companyId, b.warehouseId, session),
  };
}

/** Préparation des lignes : quantité ≤ reste à recevoir ; valeur = part du net HT de la commande (reliquat sur la dernière fraction). */
async function prepare(companyId: Id, b: Body, session: ClientSession) {
  const po = await PurchaseOrder.findOne({ _id: b.purchaseOrderId, companyId }).session(session).lean();
  if (!po) throw AppError.badRequest('Commande introuvable');
  if (po.status !== 'confirmed' && po.status !== 'partially_received') throw AppError.conflict('Seule une commande confirmée peut être réceptionnée');
  if (!(await Warehouse.exists({ _id: b.warehouseId, companyId, isActive: true }).session(session))) throw AppError.badRequest('Magasin invalide');
  const lines = [] as { orderLineId: Id; productId: Id; designation: string; quantity: number; unitCostMinor: number; valueMinor: number; serials: string[] }[];
  for (const l of b.lines) {
    const ol = po.lines.find((x) => (x as { _id: Id })._id.toString() === l.orderLineId);
    if (!ol) throw AppError.badRequest('Ligne de commande inconnue'); if (!ol.productId) throw AppError.badRequest(`« ${ol.designation} » : ligne libre, non stockable`);
    const remaining = ol.quantity - (ol.receivedQty ?? 0);
    if (l.quantity > remaining + 1e-9) throw AppError.conflict(`« ${ol.designation} » : quantité reçue ${l.quantity} supérieure au reste à recevoir ${remaining}`);
    const net = ol.netHtMinor ?? 0; const value = l.quantity >= remaining - 1e-9 ? net - (ol.receivedValueMinor ?? 0) : proportion(net, l.quantity, ol.quantity);
    lines.push({ orderLineId: (ol as { _id: Id })._id, productId: ol.productId, designation: ol.designation, quantity: l.quantity, unitCostMinor: Math.round(value / l.quantity), valueMinor: value, serials: l.serials ?? [] });
  }
  await assertQuantities(companyId, b.lines.map((l) => { const ol = po.lines.find((x) => (x as { _id: Id })._id.toString() === l.orderLineId)!; return { productId: ol.productId, quantity: l.quantity, exempt: carriedOver(l.quantity, ol.quantity, ol.quantity - (ol.receivedQty ?? 0)) }; }), session);
  return { po, lines };
}
export async function list(companyId: Id, f: { status?: string | undefined; purchaseOrderId?: string | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { companyId, ...(f.status && { status: f.status }), ...(f.purchaseOrderId && { purchaseOrderId: f.purchaseOrderId }) };
  const [items, total] = await Promise.all([GoodsReceipt.find(filter).select('-lines').sort({ receiptDate: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean(), GoodsReceipt.countDocuments(filter)]);
  return { items: items.map((r) => ({ ...toDto({ ...r, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const r = await GoodsReceipt.findOne({ _id: id, companyId }).session(session ?? null).lean(); if (!r) throw AppError.notFound('Réception introuvable'); return r as Lean; }
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

export async function create(companyId: Id, userId: Id, b: Body) {
  const date = startOfDay(b.receiptDate ?? new Date()); await ensureCounter(companyId, 'goodsReceipt', date);
  return withTransaction(async (session) => {
    const { po, lines } = await prepare(companyId, b, session); const number = await nextDocumentNumber(companyId, 'goodsReceipt', session, date);
    const addresses = await receiptAddresses(companyId, b, po.supplierId, po.supplierAddress, session);
    const [r] = await GoodsReceipt.create([{ ...addresses, companyId, number, purchaseOrderId: po._id, supplierId: po.supplierId, supplier: po.supplier, warehouseId: b.warehouseId, receiptDate: date, lines, notes: b.notes, deliveryNoteRef: b.deliveryNoteRef, createdBy: userId }] as never[], { session });
    return toDto(r!.toObject() as Lean);
  });
}
export async function update(companyId: Id, id: string, b: Body) {
  return withTransaction(async (session) => {
    const cur = await getOwn(companyId, id, session); if (cur.status !== 'draft') throw AppError.conflict('Réception validée : non modifiable'); if (cur.importFileId) throw AppError.conflict('Réception d’importation : gérée par le dossier');
    const { lines } = await prepare(companyId, { ...b, purchaseOrderId: cur.purchaseOrderId!.toString() }, session);
    const addresses = await receiptAddresses(companyId, b, cur.supplierId, cur.supplierAddress, session);
    const u = await GoodsReceipt.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { ...addresses, warehouseId: b.warehouseId, receiptDate: startOfDay(b.receiptDate ?? cur.receiptDate), lines, notes: b.notes, deliveryNoteRef: b.deliveryNoteRef } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La réception a changé entre-temps'); return toDto(u as Lean);
  });
}
export async function remove(companyId: Id, id: string) { const r = await getOwn(companyId, id); if (r.status !== 'draft' || r.importFileId) throw AppError.conflict('Seule une réception en brouillon se supprime'); await GoodsReceipt.deleteOne({ _id: id, companyId, status: 'draft' }); return r; }

/**
 * VALIDATION : entrée en stock (événement, même transaction), quantités reçues de la commande, statut de la commande.
 * Les quantités sont re-contrôlées (autre réception validée entre-temps). Réceptions partielles ou complètes.
 */
export async function validate(companyId: Id, userId: Id, id: string) {
  const pre = await getOwn(companyId, id);
  await ensureLevels(companyId, pre.lines.map((l) => ({ productId: l.productId!, warehouseId: pre.warehouseId! })));
  return withTransaction(async (session) => {
    const r = await getOwn(companyId, id, session); if (r.status !== 'draft') throw AppError.conflict('Réception déjà validée');
    if (r.purchaseOrderId) {
      const po = await PurchaseOrder.findOne({ _id: r.purchaseOrderId, companyId }).session(session);
      if (!po || (po.status !== 'confirmed' && po.status !== 'partially_received')) throw AppError.conflict('Commande non réceptionnable');
      for (const l of r.lines) {
        const ol = po.lines.find((x) => String((x as { _id: Id })._id) === String(l.orderLineId)); if (!ol) throw AppError.conflict('Ligne de commande introuvable');
        const remaining = ol.quantity - (ol.receivedQty ?? 0);
        if (l.quantity > remaining + 1e-9) throw AppError.conflict(`« ${ol.designation} » : quantité supérieure au reste à recevoir (${remaining})`);
        const net = ol.netHtMinor ?? 0; const value = l.quantity >= remaining - 1e-9 ? net - (ol.receivedValueMinor ?? 0) : proportion(net, l.quantity, ol.quantity);
        l.valueMinor = value; l.unitCostMinor = Math.round(value / l.quantity);
        ol.receivedQty = (ol.receivedQty ?? 0) + l.quantity; ol.receivedValueMinor = (ol.receivedValueMinor ?? 0) + value;
      }
      po.status = po.lines.every((x) => (x.receivedQty ?? 0) >= x.quantity - 1e-9) ? 'received' : 'partially_received';
      await po.save({ session });
      await GoodsReceipt.updateOne({ _id: id, companyId }, { $set: { lines: r.lines } }, { session }); // valeurs définitives
    }
    // Entrée de stock : abonné du module Stock (idempotent, même transaction)
    await emitDomainEvent('goodsReceipt.validated', { companyId, documentId: r._id, session, userId, documentNumber: r.number });
    const u = await GoodsReceipt.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('La réception a changé entre-temps'); void Product; return toDto(u as Lean);
  });
}
