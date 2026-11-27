import type { ClientSession, Model, QueryFilter, Types } from 'mongoose';
import { DeliveryNote, Invoice, Proforma, Quotation, type DeliveryNoteDoc } from '../../models/sales.model.js';
import { Product, ProductSerial } from '../../models/product.model.js';
import { StockLevel, Warehouse } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { computeDocument, proportion, type VatRegime } from '../../services/calculation.service.js';
import { defaultWarehouseId, ensureLevels } from '../../services/stock.service.js';
import { assertCanSell } from '../customers/customer.service.js';
import { buildDocument, inheritFrom, linesToInput, type BuiltDocument, type LineInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import { assertQuantities, carriedOver } from '../products/units.js';
import { allocatedOf, availableToBill, billedBySource, billingState, componentsOf, netDelivered, q3, withShares, writeLines, type BillableNote, type CycleLine } from '../sales/billing.js';
import { logCycle, type CycleActor } from '../sales/cycle.log.js';
import { BILLABLE_EXPR } from '../invoices/delivery-billing.js';
import { expireOverdue as expireProformas } from '../proformas/proforma.expiry.js';

type Id = Types.ObjectId;
export type Lean = DeliveryNoteDoc & { _id: Id; createdAt?: Date };
type SourceType = 'quotation' | 'proforma' | 'invoice';
const model = { quotation: Quotation, proforma: Proforma, invoice: Invoice } as const;
const asModel = (t: SourceType) => model[t] as unknown as Model<unknown>;
const EPS = 1e-9;

export const toDto = (d: Lean) => {
  const b = d as unknown as BillableNote & Lean; const billing = billingState(b); const returned = !!d.returns?.length;
  const invoiceIds = [...new Set([...(d.invoiceIds ?? []), ...(d.invoiceId ? [d.invoiceId] : [])].map(String))];
  return {
    id: d._id.toString(), deliveryAddress: snapshotDto(d.deliveryAddress as never), number: d.number, status: d.status, customerId: d.customerId.toString(), customer: d.customerSnapshot, deliveryDate: d.deliveryDate, carrier: d.carrier ?? null,
    source: d.source?.type ? { type: d.source.type, id: d.source.id?.toString(), number: d.source.number ?? null } : null,
    lines: (d.lines ?? []).map((l) => { const c = l as unknown as CycleLine; return { ...l, id: c._id.toString(), returnedQty: c.returnedQty ?? 0, billedQty: billedBySource(b) ? 0 : allocatedOf(b, c), availableToBill: availableToBill(b, c) }; }),
    totals: d.totals, notes: d.notes ?? null,
    /** Facturation : aucune, partielle, totale, ou « source » (livraison d’une facture déjà émise). */
    billing, invoiced: billing === 'full' || billing === 'source', invoiceId: invoiceIds[0] ?? null, invoiceIds,
    warehouseId: d.warehouseId?.toString() ?? null, validatedAt: d.validatedAt ?? null, validatedByName: d.validatedByName ?? null, cancelledAt: d.cancelledAt ?? null, cancelledByName: d.cancelledByName ?? null, cancelReason: d.cancelReason ?? null, createdAt: d.createdAt, legacyFlow: !!d.legacyFlow,
    returns: (d.returns ?? []).map((r) => ({ id: String((r as { _id: Id })._id), date: r.date, warehouseId: r.warehouseId?.toString() ?? null, reason: r.reason, userName: r.userName ?? null,
      lines: r.lines.map((x) => { const l = (d.lines ?? []).find((y) => String((y as { _id: Id })._id) === String(x.lineId)); return { lineId: String(x.lineId), designation: l?.designation ?? '', unit: l?.unit ?? null, quantity: x.quantity, serials: x.serials ?? [], creditedQty: q3((x.credited ?? []).reduce((s, c) => s + (c.quantity ?? 0), 0)) }; }) })),
    editable: d.status === 'draft',
    cancellable: d.status === 'validated' && !returned && !d.invoiceId && (billedBySource(b) || billing === 'none'),
    returnable: d.status === 'validated' && b.lines.some((l) => netDelivered(l) > EPS),
  };
};

interface Source { _id: Id; number?: string | null; status: string; customerId: Id; lines: CycleLine[]; invoiceId?: Id | null; proformaId?: Id | null; type?: string | null; origin?: string | null; deliveryNoteIds?: Id[] | null; deliveryAddress?: unknown; cycleRevision?: number | null; totals?: { globalDiscountMinor?: number | null; vatGroups?: { vatCode?: string | null; regime?: string | null; ratePct?: number | null; baseMinor?: number | null }[] | null } | null }
async function loadSource(companyId: Id, type: SourceType, id: string, session?: ClientSession) {
  const doc = (await asModel(type).findOne({ _id: id, companyId }).session(session ?? null).lean()) as Source | null;
  if (!doc) throw AppError.notFound('Document source introuvable');
  if (type === 'quotation') {
    if (doc.status !== 'accepted') throw AppError.conflict('Seul un devis accepté peut donner lieu à une livraison');
    if (doc.invoiceId || doc.proformaId) throw AppError.conflict('Ce devis a été converti : livrez depuis la proforma ou la facture');
  } else if (type === 'proforma') {
    if (doc.status !== 'pending') throw AppError.conflict(`Seule une proforma en cours peut être livrée (proforma ${({ cancelled: 'annulée', expired: 'expirée', converted: 'convertie' } as Record<string, string>)[doc.status] ?? doc.status})`);
  } else if (doc.status !== 'validated' || doc.type !== 'invoice') throw AppError.conflict('Seule une facture validée peut donner lieu à une livraison');
  else if (doc.origin === 'delivery' || doc.deliveryNoteIds?.length) throw AppError.conflict('Cette facture est issue de bons de livraison : ses marchandises sont déjà livrées');
  return withShares(doc);
}
const remainingOf = (l: CycleLine) => Math.max(0, q3(l.quantity - (l.deliveredQty ?? 0)));

/** Un devis ne donne plus lieu à une livraison ; les BL déjà créés depuis un devis restent exploitables. */
const noQuotationSource = () => new AppError(410, 'Un devis ne se livre pas directement : convertissez-le en proforma', 'CONVERSION_REMOVED');
/** Lignes livrables d'un document source : reste à livrer, quantités déjà en préparation et stock disponible par magasin. */
export async function sourceLines(companyId: Id, type: SourceType, id: string, excludeId?: string) {
  if (type === 'quotation') throw noQuotationSource();
  if (type === 'proforma') await expireProformas(companyId);
  const src = await loadSource(companyId, type, id);
  const ids = src.lines.map((l) => l.productId).filter(Boolean) as Id[];
  const [products, levels, drafts, warehouses] = await Promise.all([
    Product.find({ companyId, _id: { $in: ids } }).select('hasSerial kind').lean(),
    StockLevel.find({ companyId, productId: { $in: ids } }).select('productId warehouseId qty').lean(),
    DeliveryNote.find({ companyId, 'source.id': src._id, status: 'draft', ...(excludeId && { _id: { $ne: excludeId } }) }).select('lines').lean(),
    Warehouse.find({ companyId, isActive: true }).sort({ code: 1 }).select('code name isDefault').lean(),
  ]);
  const serial = new Set(products.filter((p) => p.hasSerial).map((p) => p._id.toString()));
  const inDraft = (lineId: string) => q3(drafts.flatMap((d) => d.lines).filter((l) => String(l.sourceLineId) === lineId).reduce((s, l) => s + l.quantity, 0));
  return { sourceNumber: src.number ?? null, customerId: src.customerId.toString(),
    // absent : document antérieur aux adresses multiples (l'adresse par défaut du client sera reprise)
    ...(src.deliveryAddress !== undefined && { deliveryAddress: snapshotDto(src.deliveryAddress as never) }),
    fullyDelivered: src.lines.filter((l) => remainingOf(l) <= EPS).length,
    /** Magasins de sortie proposés (la préparation d'un BL ne requiert pas la consultation du stock). */
    warehouses: warehouses.map((w) => ({ id: w._id.toString(), code: w.code, name: w.name, isDefault: !!w.isDefault, isActive: true })),
    lines: src.lines.filter((l) => remainingOf(l) > EPS).map((l) => ({ sourceLineId: l._id.toString(), productId: l.productId?.toString() ?? null, reference: l.reference ?? null, designation: l.designation, unit: l.unit ?? null, kind: l.kind ?? 'product',
      hasSerial: serial.has(String(l.productId)), quantity: l.quantity, deliveredQty: l.deliveredQty ?? 0, remainingQty: remainingOf(l), draftQty: inDraft(l._id.toString()),
      /** Stock par magasin (articles stockés uniquement). */
      stock: l.productId && l.kind !== 'service' ? levels.filter((s) => String(s.productId) === String(l.productId)).map((s) => ({ warehouseId: s.warehouseId.toString(), qty: s.qty })) : null })) };
}
/** Numéros de série disponibles dans un magasin, hors ceux déjà affectés à un autre BL en préparation. */
export async function availableSerials(companyId: Id, f: { productId: string; warehouseId: string; excludeId?: string | undefined }) {
  const [rows, drafts] = await Promise.all([
    ProductSerial.find({ companyId, productId: f.productId, warehouseId: f.warehouseId, status: 'available' }).sort({ serialNumber: 1 }).limit(2000).select('serialNumber').lean(),
    DeliveryNote.find({ companyId, status: 'draft', 'lines.productId': f.productId, ...(f.excludeId && { _id: { $ne: f.excludeId } }) }).select('number lines').lean(),
  ]);
  const taken = new Map(drafts.flatMap((d) => d.lines.filter((l) => String(l.productId) === f.productId).flatMap((l) => (l.serials ?? []).map((s) => [s, d.number] as const))));
  return { items: rows.map((r) => ({ serialNumber: r.serialNumber, assignedTo: taken.get(r.serialNumber) ?? null })) };
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; sourceId?: string | undefined; invoiced?: boolean | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: Record<string, unknown> = { companyId };
  if (f.status) filter.status = f.status; if (f.customerId) filter.customerId = f.customerId; if (f.sourceId) filter['source.id'] = f.sourceId;
  // « Non facturés » : BL validés ayant une quantité livrée à facturer
  if (f.invoiced === false) { filter.status = 'validated'; filter['source.type'] = { $ne: 'invoice' }; filter.$expr = BILLABLE_EXPR; }
  if (f.invoiced === true) { filter.status = 'validated'; filter.$nor = [{ 'source.type': { $ne: 'invoice' }, $expr: BILLABLE_EXPR }]; }
  const range = rangeFilter(f.from, f.to); if (range) filter.deliveryDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }, { 'source.number': rx }]; }
  const sort = buildSort(f.sort, ['number', 'deliveryDate', 'createdAt'], { deliveryDate: -1, _id: -1 });
  const q = filter as QueryFilter<DeliveryNoteDoc>;
  const [items, total] = await Promise.all([DeliveryNote.find(q).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), DeliveryNote.countDocuments(q)]);
  return { items: items.map((d) => ({ ...toDto(d as unknown as Lean), lines: undefined, returns: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const d = await DeliveryNote.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!d) throw AppError.notFound('Bon de livraison introuvable');
  return d as Lean;
}
export const get = async (c: Id, id: string) => toDto(await getOwn(c, id));

interface Body { deliveryAddressId?: string | null | undefined; customerId?: string | undefined; source?: { type: SourceType; id: string } | undefined; lines: LineInput[]; deliveryDate?: Date | undefined; carrier?: string | undefined; notes?: string | undefined; warehouseId?: string | undefined }

/** Prépare les lignes : depuis un document source (prix et TVA repris, quantité cumulée ≤ reste à livrer) ou saisie manuelle. */
async function prepare(companyId: Id, b: Body, session: ClientSession) {
  if (!b.source) {
    if (b.lines.some((l) => l.sourceLineId)) throw AppError.badRequest('sourceLineId sans document source');
    return { customerId: b.customerId!, lines: b.lines, source: undefined as undefined | { type: SourceType; id: Id; number: string }, doc: undefined as Source | undefined };
  }
  const src = await loadSource(companyId, b.source.type, b.source.id, session);
  const lines: LineInput[] = []; const asked = new Map<string, number>();
  for (const l of b.lines) {
    const sl = src.lines.find((x) => x._id.toString() === l.sourceLineId);
    if (!sl) throw AppError.badRequest('Ligne source inconnue');
    const remaining = remainingOf(sl); const total = q3((asked.get(l.sourceLineId!) ?? 0) + l.quantity); asked.set(l.sourceLineId!, total);
    if (total > remaining + EPS) throw new AppError(409, `« ${sl.designation} » : quantité à livrer (${total}) supérieure au reste (${remaining})`, 'DELIVERY_EXCEEDED');
    lines.push({ ...linesToInput([sl as never], false, 'self')[0]!, quantity: l.quantity, ...(l.serials?.length && { serials: l.serials }) });
    await assertQuantities(companyId, [{ productId: sl.productId ?? undefined, quantity: l.quantity, exempt: carriedOver(l.quantity, sl.quantity, remaining), label: `« ${sl.designation} »` }], session);
  }
  return { customerId: src.customerId.toString(), lines, source: { type: b.source.type, id: src._id, number: src.number ?? '' }, doc: src };
}
/** Montants du BL : prorata des montants convenus sur le document source (remise supplémentaire comprise). */
function priceFromSource(doc: BuiltDocument, src: Source) {
  const calc = doc.lines.map((l) => {
    const sl = src.lines.find((x) => x._id.toString() === String(l.sourceLineId))!; const c = componentsOf(sl);
    const part = (v: number) => (l.quantity >= sl.quantity - EPS ? v : proportion(v, l.quantity, sl.quantity));
    const after = part(c.after); const share = part(c.share);
    return { quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, vatCode: l.vat.code, vatRegime: l.vat.regime as VatRegime, vatRatePct: l.vat.ratePct, netHtOverrideMinor: after + share, globalShareOverrideMinor: share, grossOverrideMinor: after + share + part(c.discount) };
  });
  const r = computeDocument({ lines: calc });
  doc.lines.forEach((l, i) => Object.assign(l, r.lines[i]));
  return { ...doc, totals: r.totals };
}
/** Numéros de série d'un BL en préparation : articles, société, disponibilité, magasin, et aucun double emploi entre BL. */
async function assertSerials(companyId: Id, lines: { productId?: Id; quantity: number; serials?: string[] | undefined; designation: string }[], warehouseId: string | undefined, session: ClientSession, ignore?: string) {
  const used = new Set<string>();
  for (const l of lines) {
    if (!l.serials?.length) continue;
    const p = l.productId ? await Product.findOne({ _id: l.productId, companyId }).session(session).select('reference hasSerial').lean() : null;
    if (!p?.hasSerial) throw new AppError(400, `« ${l.designation} » n’est pas suivi par numéro de série`, 'SERIAL_NOT_TRACKED');
    if (l.serials.length > l.quantity) throw new AppError(400, `« ${p.reference} » : ${l.serials.length} numéros de série pour une quantité de ${l.quantity}`, 'SERIAL_COUNT');
    for (const s of l.serials) { const k = `${l.productId}:${s}`; if (used.has(k)) throw new AppError(400, `Numéro de série saisi deux fois : ${s}`, 'SERIAL_DUPLICATE'); used.add(k); }
    const rows = await ProductSerial.find({ companyId, productId: l.productId, serialNumber: { $in: l.serials } }).session(session).lean();
    for (const s of l.serials) {
      const row = rows.find((r) => r.serialNumber === s);
      if (!row || row.status !== 'available' || (warehouseId && String(row.warehouseId) !== warehouseId)) throw new AppError(409, `Numéro de série indisponible pour « ${p.reference} »${warehouseId ? ' dans ce magasin' : ''} : ${s}`, 'SERIAL_UNAVAILABLE');
    }
    const other = await DeliveryNote.findOne({ companyId, status: 'draft', ...(ignore && { _id: { $ne: ignore } }), lines: { $elemMatch: { productId: l.productId, serials: { $in: l.serials } } } }).session(session).select('number').lean();
    if (other) throw new AppError(409, `Numéro de série de « ${p.reference} » déjà affecté au bon de livraison ${other.number}`, 'SERIAL_ALREADY_ASSIGNED');
  }
}
const assertWarehouse = async (companyId: Id, id: string, session: ClientSession) => {
  if (!(await Warehouse.exists({ _id: id, companyId, isActive: true }).session(session))) throw new AppError(409, 'Magasin introuvable ou inactif', 'WAREHOUSE_UNAVAILABLE');
};
async function build(companyId: Id, b: Body, p: Awaited<ReturnType<typeof prepare>>, date: Date, session: ClientSession, inherit: Parameters<typeof buildDocument>[3]['inherit'], ignore?: string) {
  const built = await buildDocument(companyId, 'deliveryNote', { customerId: p.customerId, lines: p.lines, deliveryAddressId: b.deliveryAddressId }, { date, session, ...(inherit && { inherit }), preserveQuantities: !!p.source });
  if (b.warehouseId) await assertWarehouse(companyId, b.warehouseId, session);
  await assertSerials(companyId, built.lines, b.warehouseId, session, ignore);
  return p.doc ? priceFromSource(built, p.doc) : built;
}
/** Une écriture sur la proforma sérialise la préparation d'un BL avec son annulation ou une livraison concurrente. */
const touchSource = async (companyId: Id, p: Awaited<ReturnType<typeof prepare>>, session: ClientSession) => { if (p.doc && p.source) await writeLines(asModel(p.source.type), companyId, p.doc, new Map(), session); };

export async function create(companyId: Id, userId: Id, b: Body, actor: CycleActor = { userId }) {
  if (b.source?.type === 'quotation') throw noQuotationSource();
  if (b.source?.type === 'proforma') await expireProformas(companyId);
  await ensureCounter(companyId, 'deliveryNote', startOfDay(b.deliveryDate ?? new Date()));
  return withTransaction(async (session) => {
    const date = startOfDay(b.deliveryDate ?? new Date());
    const p = await prepare(companyId, b, session);
    const doc = await build(companyId, b, p, date, session, { deliveryAddress: p.doc?.deliveryAddress });
    const number = await nextDocumentNumber(companyId, 'deliveryNote', session, date);
    const [c] = await DeliveryNote.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, deliveryDate: date, carrier: b.carrier, lines: doc.lines, totals: doc.totals, globalDiscountMinor: doc.totals.globalDiscountMinor,
      source: p.source, deliveryAddress: doc.deliveryAddress, notes: b.notes, warehouseId: b.warehouseId, createdBy: userId }] as never[], { session });
    await touchSource(companyId, p, session);
    await logCycle(session, companyId, actor, [{ action: 'delivery_created', resourceId: c!._id, number, description: p.source ? `Depuis ${p.source.number}` : 'Saisie sans document source', refs: [p.source?.id] }]);
    return toDto(c!.toObject() as Lean);
  });
}

export async function update(companyId: Id, id: string, b: Body) {
  return withTransaction(async (session) => {
    const cur = await getOwn(companyId, id, session);
    if (cur.status !== 'draft') throw AppError.conflict('Seul un BL en brouillon est modifiable');
    const date = startOfDay(b.deliveryDate ?? cur.deliveryDate);
    const body: Body = { ...b, warehouseId: b.warehouseId ?? cur.warehouseId?.toString(), ...(cur.source?.type && { source: { type: cur.source.type as SourceType, id: cur.source.id!.toString() } }) }; // la source ne change pas
    const p = await prepare(companyId, body, session);
    const doc = await build(companyId, body, p, date, session, inheritFrom(cur, p.customerId), id);
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { $set: { deliveryAddress: doc.deliveryAddress, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, deliveryDate: date, carrier: b.carrier, lines: doc.lines, totals: doc.totals, notes: b.notes, ...(body.warehouseId && { warehouseId: body.warehouseId }) } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps');
    await touchSource(companyId, p, session);
    return toDto(u as Lean);
  });
}
export async function remove(companyId: Id, id: string) {
  const d = await getOwn(companyId, id);
  if (d.status !== 'draft') throw AppError.conflict('Seul un BL en brouillon peut être supprimé : un BL validé ou annulé est conservé (traçabilité)');
  await DeliveryNote.deleteOne({ _id: id, companyId, status: 'draft' }); return d;
}

/** Met à jour les quantités livrées du document source (validation ou annulation), sans jamais dépasser la quantité commandée. */
async function moveDelivered(companyId: Id, src: Source, type: SourceType, d: Lean, sign: 1 | -1, session: ClientSession) {
  const changes = new Map<string, Record<string, unknown>>();
  for (const l of d.lines) {
    if (!l.sourceLineId) continue;
    const sl = src.lines.find((x) => x._id.equals(l.sourceLineId!));
    if (!sl) throw AppError.conflict(`« ${l.designation} » : ligne du document source introuvable`);
    const k = String(sl._id); const current = (changes.get(k)?.deliveredQty as number | undefined) ?? sl.deliveredQty ?? 0; const next = q3(current + sign * l.quantity);
    if (sign > 0 && next > sl.quantity + EPS) throw new AppError(409, `« ${l.designation} » : quantité supérieure au reste à livrer (${Math.max(0, q3(sl.quantity - current))})`, 'DELIVERY_EXCEEDED');
    changes.set(k, { deliveredQty: Math.max(0, next) });
  }
  await writeLines(asModel(type), companyId, src, changes, session);
}
const sourceDoc = async (companyId: Id, d: Lean, session: ClientSession) => {
  const src = (await asModel(d.source!.type as SourceType).findOne({ _id: d.source!.id, companyId }).session(session).lean()) as Source | null;
  if (!src) throw AppError.conflict('Document source introuvable');
  return src;
};

/** VALIDATION : la livraison est acquise. Quantités livrées du source et sortie de stock dans la même transaction. */
export async function validate(companyId: Id, userId: Id, id: string, opts: { warehouseId?: string | undefined; allowNegativeStock?: boolean | undefined } = {}, userName?: string) {
  // Niveaux de stock préparés avant la transaction (première sortie d'un article dans un magasin)
  const pre = await getOwn(companyId, id);
  if (pre.source?.type === 'proforma') await expireProformas(companyId);
  const wh = opts.warehouseId ?? pre.warehouseId?.toString() ?? (await defaultWarehouseId(companyId).catch(() => null))?.toString();
  if (wh) await ensureLevels(companyId, pre.lines.filter((l) => l.productId).map((l) => ({ productId: l.productId!, warehouseId: wh })));
  return withTransaction(async (session) => {
    const d = await getOwn(companyId, id, session);
    if (d.status !== 'draft') throw AppError.conflict('BL déjà validé ou annulé');
    if (wh) await assertWarehouse(companyId, wh, session);
    await assertCanSell(companyId, d.customerId, d.totals.totalTtcMinor ?? 0, session); // blocage des ventes : crédit dépassé / client archivé
    let proforma: Source | null = null;
    if (d.source?.type) {
      const type = d.source.type as SourceType;
      const src = await loadSource(companyId, type, d.source.id!.toString(), session); // statut du source encore valable ?
      await moveDelivered(companyId, src, type, d, 1, session);
      if (type === 'proforma') proforma = src;
    }
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'draft' }, { status: 'validated', validatedAt: new Date(), validatedBy: userId, validatedByName: userName }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps');
    // Sortie de stock (abonné du module Stock) dans la même transaction : un stock insuffisant annule la validation
    await emitDomainEvent('deliveryNote.validated', { companyId, documentId: d._id, session, userId, documentNumber: d.number, payload: { warehouseId: wh, allowNegativeStock: !!opts.allowNegativeStock } });
    const stocked = d.lines.filter((l) => l.productId && l.kind !== 'service');
    const complete = proforma?.lines.every((l) => (l.deliveredQty ?? 0) >= l.quantity - EPS);
    const refs = [d.source?.id];
    await logCycle(session, companyId, { userId, name: userName }, [
      { action: 'delivery_validated', resourceId: d._id, number: d.number, refs },
      ...(stocked.length ? [{ action: 'stock_out' as const, resourceId: d._id, number: d.number, refs, description: stocked.map((l) => `${l.reference ?? l.designation} : ${l.quantity} ${l.unit ?? ''}`.trim()).join(' · ') }] : []),
      ...(proforma ? [{ action: (complete ? 'delivery_complete' : 'delivery_partial') as 'delivery_complete' | 'delivery_partial', resourceId: proforma._id, number: proforma.number, refs: [d._id], description: `Après le BL ${d.number}` }] : []),
    ]);
    return toDto((await getOwn(companyId, id, session)));
  });
}

/**
 * Annulation d'un BL validé non facturé, après confirmation que la marchandise est physiquement en magasin : quantités livrées
 * du source restituées, stock et numéros de série réintégrés. Un BL facturé passe par un avoir puis un retour.
 */
export async function cancel(companyId: Id, userId: Id, id: string, reason: string, userName?: string) {
  return withTransaction(async (session) => {
    const d = await getOwn(companyId, id, session); const b = d as unknown as BillableNote;
    if (d.status !== 'validated') throw AppError.conflict('Seul un BL validé peut être annulé');
    if (d.invoiceId || (!billedBySource(b) && b.lines.some((l) => allocatedOf(b, l) > EPS))) throw new AppError(409, 'BL facturé : annulation impossible. Émettez un avoir « retour de marchandise » sur la facture, puis enregistrez le retour physique.', 'DELIVERY_BILLED');
    if (d.returns?.length) throw new AppError(409, 'Des retours sont enregistrés sur ce BL : traitez les quantités restantes par un nouveau retour', 'DELIVERY_HAS_RETURNS');
    if (d.source?.type) await moveDelivered(companyId, await sourceDoc(companyId, d, session), d.source.type as SourceType, d, -1, session);
    const u = await DeliveryNote.findOneAndUpdate({ _id: id, companyId, status: 'validated', cycleRevision: d.cycleRevision ?? null }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId, cancelledByName: userName, cancelReason: reason }, $inc: { cycleRevision: 1 } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le BL a changé entre-temps (peut-être facturé)');
    await emitDomainEvent('deliveryNote.cancelled', { companyId, documentId: d._id, session, userId, documentNumber: d.number });
    await logCycle(session, companyId, { userId, name: userName }, [{ action: 'delivery_cancelled', resourceId: d._id, number: d.number, refs: [d.source?.id], description: `${reason} — retour physique confirmé` }]);
    return toDto(u as Lean);
  });
}
