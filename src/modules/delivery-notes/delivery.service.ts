import { Types, type ClientSession, type QueryFilter } from 'mongoose';
import { DeliveryNote, Invoice, Proforma, Quotation, type DeliveryNoteDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { defaultWarehouseId, ensureLevels } from '../../services/stock.service.js';
import { assertCanSell } from '../customers/customer.service.js';
import { buildDocument, inheritFrom, linesToInput, type LineInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import { assertQuantities, carriedOver } from '../products/units.js';

type Id = Types.ObjectId;
type Lean = DeliveryNoteDoc & { _id: Id; createdAt?: Date };
type SourceType = 'quotation' | 'proforma' | 'invoice';
const model = { quotation: Quotation, proforma: Proforma, invoice: Invoice } as const;

export const toDto = (d: Lean) => ({
  id: d._id.toString(), deliveryAddress: snapshotDto(d.deliveryAddress as never), number: d.number, status: d.status, customerId: d.customerId.toString(), customer: d.customerSnapshot, deliveryDate: d.deliveryDate, carrier: d.carrier ?? null,
  source: d.source?.type ? { type: d.source.type, id: d.source.id?.toString(), number: d.source.number ?? null } : null,
  lines: d.lines.map((l) => ({ ...l, id: (l as { _id: Id })._id.toString() })), totals: d.totals, notes: d.notes ?? null, invoiceId: d.invoiceId?.toString() ?? null, invoiced: !!d.invoiceId,
  warehouseId: d.warehouseId?.toString() ?? null, validatedAt: d.validatedAt ?? null, cancelledAt: d.cancelledAt ?? null, cancelReason: d.cancelReason ?? null, createdAt: d.createdAt,
  editable: d.status === 'draft', cancellable: d.status === 'validated' && !d.invoiceId,
});

async function loadSource(companyId: Id, type: SourceType, id: string, session?: ClientSession) {
  const doc = await (model[type] as typeof Quotation).findOne({ _id: id, companyId }).session(session ?? null).lean() as unknown as
    { _id: Id; number?: string; status: string; customerId: Id; lines: { _id: Id; designation: string; kind?: string; quantity: number; deliveredQty?: number; unitPriceMinor: number }[]; invoiceId?: Id; proformaId?: Id; type?: string; deliveryAddress?: unknown } | null;
  if (!doc) throw AppError.notFound('Document source introuvable');
  if (type === 'quotation') {
    if (doc.status !== 'accepted') throw AppError.conflict('Seul un devis accepté peut donner lieu à une livraison');
    if (doc.invoiceId || doc.proformaId) throw AppError.conflict('Ce devis a été converti : livrez depuis la proforma ou la facture');
  } else if (type === 'proforma') {
    if (doc.status !== 'pending') throw AppError.conflict('Seule une proforma en attente peut donner lieu à une livraison');
  } else if (doc.status !== 'validated' || doc.type !== 'invoice') throw AppError.conflict('Seule une facture validée peut donner lieu à une livraison');
  return doc;
}

/** Lignes livrables d'un document source (articles uniquement) avec la quantité restante à livrer. */
/** Un devis ne donne plus lieu à une livraison (proforma ou facture) ; les BL déjà créés depuis un devis restent exploitables. */
const noQuotationSource = () => new AppError(410, 'Un devis ne se livre pas directement : convertissez-le en proforma', 'CONVERSION_REMOVED');
export async function sourceLines(companyId: Id, type: SourceType, id: string) {
  if (type === 'quotation') throw noQuotationSource();
  const src = await loadSource(companyId, type, id);
  const { Product } = await import('../../models/product.model.js');
  const prods = await Product.find({ companyId, _id: { $in: src.lines.map((l) => (l as { productId?: Id }).productId).filter(Boolean) } }).select('hasSerial').lean(); const serial = new Set(prods.filter((p) => p.hasSerial).map((p) => p._id.toString()));
  return { sourceNumber: src.number ?? null, customerId: src.customerId.toString(),
    // absent : document antérieur aux adresses multiples (l'adresse par défaut du client sera reprise)
    ...(src.deliveryAddress !== undefined && { deliveryAddress: snapshotDto(src.deliveryAddress as never) }),
    lines: src.lines.filter((l) => l.kind !== 'service').map((l) => ({ sourceLineId: l._id.toString(), hasSerial: serial.has(String((l as { productId?: Id }).productId)), unit: (l as { unit?: string | null }).unit ?? null, designation: l.designation, quantity: l.quantity, deliveredQty: l.deliveredQty ?? 0, remainingQty: Math.max(0, l.quantity - (l.deliveredQty ?? 0)) })) };
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; invoiced?: boolean | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: QueryFilter<DeliveryNoteDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  if (f.invoiced !== undefined) filter.invoiceId = (f.invoiced ? { $exists: true } : { $exists: false }) as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.deliveryDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }]; }
  const sort = buildSort(f.sort, ['number', 'deliveryDate', 'createdAt'], { deliveryDate: -1, _id: -1 });
  const [items, total] = await Promise.all([DeliveryNote.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), DeliveryNote.countDocuments(filter)]);
  return { items: items.map((d) => ({ ...toDto({ ...d, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const d = await DeliveryNote.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!d) throw AppError.notFound('Bon de livraison introuvable');
  return d as Lean;
}
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

interface Body { deliveryAddressId?: string | null | undefined; customerId?: string | undefined; source?: { type: SourceType; id: string } | undefined; lines: LineInput[]; deliveryDate?: Date | undefined; carrier?: string | undefined; notes?: string | undefined }

/** Prépare les lignes : depuis un document source (prix/TVA repris du source, quantité ≤ reste à livrer) ou saisie manuelle. */
async function prepare(companyId: Id, b: Body, session: ClientSession, ignoreBl?: Id) {
  if (!b.source) {
    if (b.lines.some((l) => l.sourceLineId)) throw AppError.badRequest('sourceLineId sans document source');
    return { customerId: b.customerId!, lines: b.lines, source: undefined as undefined | { type: SourceType; id: Id; number: string }, sourceAddress: undefined as unknown };
  }
  const src = await loadSource(companyId, b.source.type, b.source.id, session);
  const lines: LineInput[] = [];
  for (const l of b.lines) {
    const sl = src.lines.find((x) => x._id.toString() === l.sourceLineId);
    if (!sl) throw AppError.badRequest('Ligne source inconnue');
    if (sl.kind === 'service') throw AppError.badRequest(`« ${sl.designation} » est un service : non livrable`);
    const remaining = sl.quantity - (sl.deliveredQty ?? 0);
    if (l.quantity > remaining + 1e-9) throw AppError.conflict(`« ${sl.designation} » : quantité à livrer (${l.quantity}) supérieure au reste (${remaining})`);
    lines.push({ ...linesToInput([sl as never], false, 'self')[0]!, quantity: l.quantity, ...(l.serials?.length && { serials: l.serials }) });
    await assertQuantities(companyId, [{ productId: (sl as { productId?: Id }).productId, quantity: l.quantity, exempt: carriedOver(l.quantity, sl.quantity, remaining), label: `« ${sl.designation} »` }], session);
  }
  void ignoreBl;
  return { customerId: src.customerId.toString(), lines, source: { type: b.source.type, id: src._id, number: src.number ?? '' }, sourceAddress: src.deliveryAddress };
}

export async function create(companyId: Id, userId: Id, b: Body) {
  if (b.source?.type === 'quotation') throw noQuotationSource();
  await ensureCounter(companyId, 'deliveryNote', startOfDay(b.deliveryDate ?? new Date()));
  return withTransaction(async (session) => {
    const date = startOfDay(b.deliveryDate ?? new Date());
    const p = await prepare(companyId, b, session);
    const doc = await buildDocument(companyId, 'deliveryNote', { customerId: p.customerId, lines: p.lines, deliveryAddressId: b.deliveryAddressId }, { date, session, inherit: { deliveryAddress: p.sourceAddress }, preserveQuantities: !!p.source });
    const number = await nextDocumentNumber(companyId, 'deliveryNote', session, date);
    const [c] = await DeliveryNote.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, deliveryDate: date, carrier: b.carrier, lines: doc.lines, totals: doc.totals,
      source: p.source, deliveryAddress: doc.deliveryAddress, notes: b.notes, createdBy: userId }] as never[], { session });
    return toDto(c!.toObject() as Lean);
  });
}

export async function update(companyId: Id, id: string, b: Body) {
  return withTransaction(async (session) => {
    const cur = await getOwn(companyId, id, session);
    if (cur.status !== 'draft') throw AppError.conflict(cur.invoiceId ? 'BL facturé : non modifiable' : 'Seul un BL en brouillon est modifiable');
    const date = startOfDay(b.deliveryDate ?? cur.deliveryDate);
    const body: Body = { ...b, ...(cur.source?.type && { source: { type: cur.source.type as SourceType, id: cur.source.id!.toString() } }) }; // la source ne change pas
    const p = await prepare(companyId, body, session);
    const inherit = inheritFrom(cur, p.customerId);
    const doc = await buildDocument(companyId, 'deliveryNote', { customerId: p.customerId, lines: p.lines, deliveryAddressId: b.deliveryAddressId }, { date, session, ...(inherit && { inherit }), preserveQuantities: !!p.source });
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { deliveryAddress: doc.deliveryAddress, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, deliveryDate: date, carrier: b.carrier, lines: doc.lines, totals: doc.totals, notes: b.notes } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps');
    return toDto(u as Lean);
  });
}
export async function remove(companyId: Id, id: string) {
  const d = await getOwn(companyId, id);
  if (d.status !== 'draft') throw AppError.conflict('Seul un BL en brouillon peut être supprimé : annulez un BL validé (traçabilité conservée)');
  await DeliveryNote.deleteOne({ _id: id, companyId, status: 'draft' }); return d;
}

async function moveDelivered(companyId: Id, d: Lean, sign: 1 | -1, session: ClientSession) {
  if (!d.source?.type) return;
  const M = model[d.source.type as SourceType] as typeof Quotation;
  for (const l of d.lines) {
    if (!l.sourceLineId) continue;
    const r = await M.updateOne({ _id: d.source.id, companyId }, { $inc: { 'lines.$[l].deliveredQty': sign * l.quantity } }, { arrayFilters: [{ 'l._id': l.sourceLineId }], session });
    if (!r.matchedCount) throw AppError.conflict('Document source introuvable');
  }
}

/** VALIDATION : la livraison est acquise. Met à jour les quantités livrées du source (livraisons partielles) et notifie le module Stock (sortie). */
export async function validate(companyId: Id, userId: Id, id: string, opts: { warehouseId?: string | undefined; allowNegativeStock?: boolean | undefined } = {}) {
  // Niveaux de stock préparés avant la transaction (première sortie d'un article dans un magasin)
  const pre = await getOwn(companyId, id);
  const wh = opts.warehouseId ?? pre.warehouseId?.toString() ?? (await defaultWarehouseId(companyId).catch(() => null))?.toString();
  if (wh) await ensureLevels(companyId, pre.lines.filter((l) => l.productId).map((l) => ({ productId: l.productId!, warehouseId: wh })));
  return withTransaction(async (session) => {
    const d = await getOwn(companyId, id, session);
    if (d.status !== 'draft') throw AppError.conflict('BL déjà validé ou annulé');
    await assertCanSell(companyId, d.customerId, d.totals.totalTtcMinor ?? 0, session); // blocage des ventes : crédit dépassé / client archivé
    if (d.source?.type) {
      const src = await loadSource(companyId, d.source.type as SourceType, d.source.id!.toString(), session); // statut du source encore valable ?
      for (const l of d.lines) { // contrôle final du reste à livrer (autre BL validé entre-temps)
        const sl = src.lines.find((x) => x._id.equals(l.sourceLineId!));
        if (!sl || l.quantity > sl.quantity - (sl.deliveredQty ?? 0) + 1e-9) throw AppError.conflict(`« ${l.designation} » : quantité supérieure au reste à livrer`);
      }
      await moveDelivered(companyId, d, 1, session);
    }
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps');
    // Sortie de stock (abonné du module Stock) dans la même transaction : un stock insuffisant annule la validation
    await emitDomainEvent('deliveryNote.validated', { companyId, documentId: d._id, session, userId, documentNumber: d.number, payload: { warehouseId: opts.warehouseId, allowNegativeStock: !!opts.allowNegativeStock } });
    return toDto(u as Lean);
  });
}

/** Annulation d'un BL validé non facturé : restitue les quantités livrées du source ; le module Stock réintègre. */
export async function cancel(companyId: Id, userId: Id, id: string, reason: string) {
  return withTransaction(async (session) => {
    const d = await getOwn(companyId, id, session);
    if (d.status !== 'validated') throw AppError.conflict('Seul un BL validé peut être annulé');
    if (d.invoiceId) throw AppError.conflict('BL facturé : annulation impossible (émettez un avoir sur la facture)');
    await moveDelivered(companyId, d, -1, session);
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'validated', invoiceId: { $exists: false } }, { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps (peut-être facturé)');
    await emitDomainEvent('deliveryNote.cancelled', { companyId, documentId: d._id, session, userId, documentNumber: d.number });
    return toDto(u as Lean);
  });
}
