import { Types, type ClientSession, type QueryFilter } from 'mongoose';
import { Quotation, Proforma, DeliveryNote, type QuotationDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { buildDocument, frozenOf, inheritFrom, linesToInput, stillActiveAddress, type BuiltLine, type DocInput, type LineInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import * as invoices from '../invoices/invoice.service.js';
import * as activity from './quotation.activity.js';
import { SYSTEM, type Actor } from './quotation.activity.js';
import { assertTransition, OPEN_STATUSES, QUOTATION_STATUSES, QUOTATION_STATUS_LABEL, type QuotationStatus } from './quotation.workflow.js';

type Id = Types.ObjectId;
export type Lean = QuotationDoc & { _id: Id; createdAt?: Date };
export const SEND_METHODS = ['hand', 'post', 'whatsapp', 'phone', 'other'] as const;
export const SEND_METHOD_LABEL: Record<string, string> = { email: 'E-mail', hand: 'Remise en main propre', post: 'Courrier', whatsapp: 'WhatsApp', phone: 'Téléphone', other: 'Autre moyen' };

/** Position affichée d'une ligne : 10, 20, 30… (documents antérieurs : déduite de l'ordre enregistré). */
export const positionOf = (l: { position?: number | null }, index: number) => l.position ?? (index + 1) * 10;

export const toDto = (q: Lean) => ({
  id: q._id.toString(), number: q.number, status: q.status as QuotationStatus, statusLabel: QUOTATION_STATUS_LABEL[q.status as QuotationStatus], customerId: q.customerId.toString(), customer: q.customerSnapshot, issueDate: q.issueDate, validUntil: q.validUntil,
  lines: q.lines.map((l, i) => ({ ...l, id: (l as { _id: Id })._id.toString(), position: positionOf(l, i), vat: l.vat })), globalDiscountPct: q.globalDiscountPct, globalDiscountMinor: q.globalDiscountMinor,
  withholdingOperationType: q.withholdingOperationType ?? null, withholding: q.withholding ?? null, stamp: q.stamp ?? null, totals: q.totals, notes: q.notes ?? null, terms: q.terms ?? null, paymentTerms: q.paymentTerms ?? null, paymentTermsCustom: !!q.paymentTermsCustom, deliveryAddress: snapshotDto(q.deliveryAddress as never),
  proformaId: q.proformaId?.toString() ?? null, invoiceId: q.invoiceId?.toString() ?? null, duplicatedFromId: q.duplicatedFromId?.toString() ?? null,
  sentAt: q.sentAt ?? null, sentBy: q.sentByName ?? null, sentTo: q.sentTo ?? null, sentMethod: q.sentMethod ?? null, sentMethodLabel: q.sentMethod ? SEND_METHOD_LABEL[q.sentMethod] ?? q.sentMethod : null,
  acceptedAt: q.acceptedAt ?? null, acceptedBy: q.acceptedByName ?? null, acceptanceNote: q.acceptanceNote ?? null, refusedAt: q.refusedAt ?? null, refusedBy: q.refusedByName ?? null, refusalReason: q.refusalReason ?? null, expiredAt: q.expiredAt ?? null,
  createdAt: q.createdAt,
  /** Seul un devis en attente et non converti se modifie : après envoi ou décision, une révision passe par la duplication. */
  editable: q.status === 'pending' && !q.proformaId && !q.invoiceId,
});

/**
 * Passage automatique en « expiré » après la date de validité des devis encore ouverts (en attente ou envoyés), persistant et
 * historisé. Appelé à chaque lecture et périodiquement (server.ts). La garde sur le statut évite tout doublon sous concurrence.
 */
export async function expireOverdue(companyId?: Id) {
  const due = await Quotation.find({ ...(companyId && { companyId }), status: { $in: OPEN_STATUSES }, validUntil: { $lt: startOfDay(new Date()) } }).select('_id companyId status validUntil').lean();
  let count = 0;
  for (const q of due) {
    await withTransaction(async (session) => {
      const u = await Quotation.updateOne({ _id: q._id, companyId: q.companyId, status: q.status, validUntil: q.validUntil }, { status: 'expired', expiredAt: new Date() }, { session });
      if (!u.modifiedCount) return;
      await activity.record(q.companyId, q._id, [{ kind: 'expired', valueType: 'text', oldValue: QUOTATION_STATUS_LABEL[q.status as QuotationStatus], newValue: QUOTATION_STATUS_LABEL.expired, description: `Date de validité dépassée (${q.validUntil.toISOString().slice(0, 10).split('-').reverse().join('/')})`, eventKey: `expired:${q._id}` }], SYSTEM, session);
      count++;
    });
  }
  return count;
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; customerId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  await expireOverdue(companyId);
  const filter: QueryFilter<QuotationDoc> = { companyId };
  if (f.status) filter.status = f.status as never; if (f.customerId) filter.customerId = f.customerId as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }, { 'customerSnapshot.code': rx }]; }
  const key = f.sort?.replace(/customer$/, 'customerSnapshot.name').replace(/(totalHtMinor|totalTtcMinor)$/, 'totals.$1');
  const sort = buildSort(key, ['number', 'issueDate', 'validUntil', 'createdAt', 'status', 'customerSnapshot.name', 'totals.totalHtMinor', 'totals.totalTtcMinor'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Quotation.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(), Quotation.countDocuments(filter)]);
  return { items: items.map((q) => ({ ...toDto({ ...q, lines: [] } as unknown as Lean), lines: undefined })), total, page: f.page, limit: f.limit };
}

export async function getOwn(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const q = await Quotation.findOne({ _id: id, companyId }).lean();
  if (!q) throw AppError.notFound('Devis introuvable');
  return q as Lean;
}
export const get = async (companyId: Id, id: string) => toDto(await getOwn(companyId, id));

type Body = DocInput & { issueDate?: Date | undefined; validUntil: Date; notes?: string | undefined; terms?: string | undefined };
type StoredLine = BuiltLine & { _id?: Id; position?: number };

/**
 * Positions (10, 20, 30…) selon l'ordre saisi. À la modification, chaque ligne existante garde son identifiant technique
 * (et sa référence article historique) : reconnue par son `id` ; sans aucun identifiant transmis, par le même article et la même désignation.
 */
function arrange(built: BuiltLine[], input: LineInput[], current: Lean['lines'] = [] as unknown as Lean['lines']): StoredLine[] {
  const free = new Map(current.map((l) => [String((l as { _id: Id })._id), l]));
  const ids: (string | undefined)[] = input.map((l) => { const id = (l as { id?: string }).id; return id && free.has(id) ? id : undefined; });
  for (const id of ids) if (id) free.delete(id);
  // Repli réservé aux appels qui ne transmettent aucun identifiant : sinon, une ligne sans `id` est une ligne ajoutée
  const anonymous = input.every((l) => !(l as { id?: string }).id);
  if (anonymous) input.forEach((l, i) => {
    const found = [...free.entries()].find(([, c]) => String(c.productId ?? '') === (l.productId ?? '') && c.designation === built[i]!.designation);
    if (found) { ids[i] = found[0]; free.delete(found[0]); }
  });
  return built.map((l, i) => {
    const prev = ids[i] ? current.find((c) => String((c as { _id: Id })._id) === ids[i]) : undefined;
    const same = prev && String(prev.productId ?? '') === String(l.productId ?? '');
    return { ...l, position: (i + 1) * 10, _id: prev ? (prev as unknown as { _id: Id })._id : new Types.ObjectId(), ...(same && prev.reference && { reference: prev.reference }) };
  });
}

export async function create(companyId: Id, userId: Id, b: Body, actor: Actor = { userId }, source?: Lean) {
  const issueDate = startOfDay(b.issueDate ?? new Date());
  await ensureCounter(companyId, 'quotation', issueDate);
  const q = await withTransaction(async (session) => {
    const doc = await buildDocument(companyId, 'quotation', b, { date: issueDate, session });
    const number = await nextDocumentNumber(companyId, 'quotation', session, issueDate);
    const [created] = await Quotation.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: arrange(doc.lines, b.lines), globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType,
      withholding: doc.withholding, stamp: doc.stamp, totals: doc.totals, notes: b.notes, terms: b.terms, ...frozenOf(doc), ...(source && { duplicatedFromId: source._id }), createdBy: userId }] as never[], { session });
    await activity.record(companyId, created!._id, [{ kind: 'created', eventKey: `created:${created!._id}`, valueType: 'money', newValue: doc.totals.totalTtcMinor, description: `${doc.lines.length} ligne(s) — client ${doc.customer.name}`,
      ...(source && { related: { type: 'quotation', id: source._id, number: source.number } }) }], actor, session);
    if (source) await activity.record(companyId, source._id, [{ kind: 'duplicated', related: { type: 'quotation', id: created!._id, number }, description: `Nouveau devis ${number}` }], actor, session);
    return created!;
  });
  return toDto(q.toObject() as Lean);
}

export async function update(companyId: Id, id: string, b: Body, actor: Actor = {}) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const cur = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    if (!toDto(cur).editable) throw AppError.conflict('Seul un devis en attente et non converti est modifiable : dupliquez-le pour le réviser');
    const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
    const inherit = inheritFrom(cur, b.customerId);
    const doc = await buildDocument(companyId, 'quotation', b, { date: issueDate, session, ...(inherit && { inherit }) });
    const next = { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: arrange(doc.lines, b.lines, cur.lines), globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType ?? null,
      withholding: doc.withholding ?? null, stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, terms: b.terms, ...frozenOf(doc) };
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: 'pending', proformaId: null, invoiceId: null }, { $set: next }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le devis a changé entre-temps');
    // Les champs absents de la requête conservent leur valeur : la comparaison porte sur ce qui est réellement enregistré
    await activity.record(companyId, cur._id, activity.diff(cur as never, u as never), actor, session);
    return toDto(u as Lean);
  });
}

export async function remove(companyId: Id, id: string) {
  const q = await getOwn(companyId, id);
  if (q.proformaId || q.invoiceId) throw AppError.conflict('Suppression impossible : le devis a été converti');
  if (q.status !== 'pending') throw AppError.conflict(`Suppression impossible : un devis « ${QUOTATION_STATUS_LABEL[q.status as QuotationStatus]} » est conservé avec son historique`);
  if (await DeliveryNote.exists({ companyId, 'source.id': q._id })) throw AppError.conflict('Suppression impossible : des bons de livraison en dépendent');
  const r = await Quotation.deleteOne({ _id: id, companyId, status: 'pending' });
  if (!r.deletedCount) throw AppError.conflict('Le devis a changé entre-temps');
  return q;
}

/** Changement de statut : transition contrôlée et événement enregistré dans la même transaction. */
async function transition(companyId: Id, id: string, to: QuotationStatus, set: Record<string, unknown>, event: Omit<activity.Event, 'valueType' | 'oldValue' | 'newValue'>, actor: Actor) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    const from = q.status as QuotationStatus; assertTransition(from, to);
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: from }, { $set: { status: to, ...set } }, { returnDocument: 'after', session }).lean();
    if (!u) throw AppError.conflict('Le devis a changé entre-temps');
    await activity.record(companyId, q._id, [{ ...event, valueType: 'text', oldValue: QUOTATION_STATUS_LABEL[from], newValue: QUOTATION_STATUS_LABEL[to] }], actor, session);
    return toDto(u as Lean);
  });
}
export const accept = (c: Id, id: string, actor: Actor = {}, comment?: string) =>
  transition(c, id, 'accepted', { acceptedAt: new Date(), acceptedBy: actor.userId, acceptedByName: actor.name, ...(comment && { acceptanceNote: comment }) }, { kind: 'accepted', description: comment }, actor);
export const refuse = (c: Id, id: string, actor: Actor = {}, reason?: string) =>
  transition(c, id, 'refused', { refusedAt: new Date(), refusedBy: actor.userId, refusedByName: actor.name, ...(reason && { refusalReason: reason }) }, { kind: 'refused', description: reason ? `Motif : ${reason}` : undefined }, actor);
/** Devis transmis par un autre moyen que l'e-mail de l'ERP. */
export const markSent = (c: Id, id: string, actor: Actor, d: { method: (typeof SEND_METHODS)[number]; recipient?: string | undefined; note?: string | undefined }) =>
  transition(c, id, 'sent', { sentAt: new Date(), sentBy: actor.userId, sentByName: actor.name, sentMethod: d.method, sentTo: d.recipient ?? null },
    { kind: 'marked_sent', description: [`Mode : ${SEND_METHOD_LABEL[d.method]}`, d.recipient && `Destinataire : ${d.recipient}`, d.note].filter(Boolean).join(' — ') }, actor);

/** À appeler UNIQUEMENT après un envoi SMTP réussi : un devis en attente passe à « Envoyé » ; les autres statuts ne changent pas. */
export async function recordEmail(companyId: Id, id: string, to: string, actor: Actor) {
  await withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) return;
    const becomesSent = q.status === 'pending';
    await Quotation.updateOne({ _id: q._id, companyId }, { $set: { sentAt: new Date(), sentBy: actor.userId, sentByName: actor.name, sentTo: to, sentMethod: 'email', ...(becomesSent && { status: 'sent' }) } }, { session });
    await activity.record(companyId, q._id, [{ kind: 'email_sent', description: `Destinataire : ${to}`,
      ...(becomesSent && { valueType: 'text' as const, oldValue: QUOTATION_STATUS_LABEL.pending, newValue: QUOTATION_STATUS_LABEL.sent }) }], actor, session);
  });
}

/** Duplication (révision commerciale) : nouveau devis en attente, numéro propre, TVA résolue à la date du jour ; l'original est conservé. */
export async function duplicate(companyId: Id, userId: Id, id: string, actor: Actor = { userId }) {
  const src = await getOwn(companyId, id);
  const days = Math.max(1, Math.round((src.validUntil.getTime() - src.issueDate.getTime()) / 86400000));
  const today = startOfDay(new Date());
  const deliveryAddressId = await stillActiveAddress(companyId, src.customerId, src.deliveryAddress as never);
  return create(companyId, userId, { customerId: src.customerId, deliveryAddressId, ...(src.paymentTerms !== undefined && { paymentTerms: src.paymentTerms, paymentTermsCustom: !!src.paymentTermsCustom }), lines: linesToInput(src.lines), globalDiscountPct: src.globalDiscountPct ?? 0, globalDiscountMinor: src.globalDiscountMinor ?? 0,
    withholdingOperationType: src.withholdingOperationType ?? undefined, issueDate: today, validUntil: new Date(today.getTime() + days * 86400000), notes: src.notes ?? undefined, terms: src.terms ?? undefined }, actor, src);
}

/** Conversion permise tant que le client n'a pas refusé et que le devis n'est pas expiré (le convertir vaut acceptation). */
function assertConvertible(q: Lean) {
  const st = q.status as QuotationStatus;
  if (st !== 'accepted' && !OPEN_STATUSES.includes(st)) throw AppError.conflict(`Conversion impossible : devis « ${QUOTATION_STATUS_LABEL[st].toLowerCase()} »`);
  if (q.proformaId || q.invoiceId) throw AppError.conflict('Ce devis a déjà été converti');
}
/** Marque la conversion (et l'acceptation qu'elle implique) dans la transaction de conversion. */
async function converted(companyId: Id, q: Lean, link: { proformaId?: Id; invoiceId?: Id }, event: activity.Event, actor: Actor, session: ClientSession) {
  const open = q.status !== 'accepted';
  const u = await Quotation.updateOne({ _id: q._id, companyId, status: q.status, proformaId: null, invoiceId: null },
    { $set: { ...link, ...(open && { status: 'accepted', acceptedAt: new Date(), acceptedBy: actor.userId, acceptedByName: actor.name }) } }, { session });
  if (!u.modifiedCount) throw AppError.conflict('Le devis a changé entre-temps');
  await activity.record(companyId, q._id, [...(open ? [{ kind: 'accepted' as const, description: 'Acceptation enregistrée par la conversion', valueType: 'text' as const, oldValue: QUOTATION_STATUS_LABEL[q.status as QuotationStatus], newValue: QUOTATION_STATUS_LABEL.accepted }] : []), event], actor, session);
}

/** Devis → proforma. Le devis passe à « accepté ». */
export async function convertToProforma(companyId: Id, userId: Id, id: string, validUntil?: Date, actor: Actor = { userId }) {
  await expireOverdue(companyId);
  await ensureCounter(companyId, 'proforma', startOfDay(new Date()));
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) throw AppError.notFound('Devis introuvable');
    assertConvertible(q);
    if (await DeliveryNote.exists({ companyId, 'source.id': q._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour ce devis : facturez-les');
    const today = startOfDay(new Date());
    const days = Math.max(1, Math.round((q.validUntil.getTime() - q.issueDate.getTime()) / 86400000));
    const doc = await buildDocument(companyId, 'proforma', { customerId: q.customerId, lines: linesToInput(q.lines), globalDiscountPct: q.globalDiscountPct ?? 0, globalDiscountMinor: q.globalDiscountMinor ?? 0, withholdingOperationType: q.withholdingOperationType }, { date: today, session, inherit: inheritFrom(q, q.customerId)! });
    const number = await nextDocumentNumber(companyId, 'proforma', session, today);
    const [p] = await Proforma.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate: today, validUntil: validUntil ? startOfDay(validUntil) : new Date(today.getTime() + days * 86400000),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp,
      totals: doc.totals, quotationId: q._id, notes: q.notes, terms: q.terms, ...frozenOf(doc), createdBy: userId }] as never[], { session });
    await converted(companyId, q, { proformaId: p!._id }, { kind: 'converted_proforma', related: { type: 'proforma', id: p!._id, number }, description: `Proforma ${number}`, eventKey: `proforma:${p!._id}` }, actor, session);
    return { proformaId: p!._id.toString(), number };
  });
}

/** Devis → facture (brouillon). Le devis passe à « accepté ». */
export async function convertToInvoice(companyId: Id, userId: Id, id: string, actor: Actor = { userId }) {
  await expireOverdue(companyId);
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) throw AppError.notFound('Devis introuvable');
    assertConvertible(q);
    if (await DeliveryNote.exists({ companyId, 'source.id': q._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour ce devis : facturez-les');
    const inv = await invoices.createDraft(companyId, userId, { customerId: q.customerId, lines: linesToInput(q.lines), globalDiscountPct: q.globalDiscountPct ?? 0, globalDiscountMinor: q.globalDiscountMinor ?? 0,
      withholdingOperationType: q.withholdingOperationType ?? undefined, notes: q.notes ?? undefined }, { quotationId: q._id, inherit: inheritFrom(q, q.customerId) }, session);
    const invoiceId = new Types.ObjectId(inv.id);
    await converted(companyId, q, { invoiceId }, { kind: 'converted_invoice', related: { type: 'invoice', id: invoiceId, number: null }, description: 'Facture brouillon créée', eventKey: `invoice:${inv.id}` }, actor, session);
    return { invoiceId: inv.id };
  });
}

/** Compteurs réels par statut, montants des devis ouverts et taux de conversion devis → facture. */
export async function stats(companyId: Id) {
  await expireOverdue(companyId);
  const rows = await Quotation.aggregate<{ _id: string; n: number; totalMinor: number }>([{ $match: { companyId } }, { $group: { _id: '$status', n: { $sum: 1 }, totalMinor: { $sum: '$totals.totalTtcMinor' } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r])) as Record<string, { n: number; totalMinor: number }>;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const invoiced = await Quotation.countDocuments({ companyId, invoiceId: { $ne: null } });
  // Un devis converti en proforma puis facturé compte comme converti en facture
  const viaProforma = await Proforma.countDocuments({ companyId, quotationId: { $ne: null }, invoiceId: { $ne: null } });
  const counts = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, by[s]?.n ?? 0])) as Record<QuotationStatus, number>;
  return { total, ...counts, pendingTotalMinor: by['pending']?.totalMinor ?? 0, openTotalMinor: OPEN_STATUSES.reduce((s, k) => s + (by[k]?.totalMinor ?? 0), 0),
    acceptedTotalMinor: by['accepted']?.totalMinor ?? 0, invoiced: invoiced + viaProforma, conversionRatePct: total ? Math.round(((invoiced + viaProforma) / total) * 10000) / 100 : 0 };
}
