import { Types, type QueryFilter } from 'mongoose';
import { Quotation, Proforma, DeliveryNote, QuotationComment, QuotationDocument, QuotationVersion, type QuotationDoc } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { buildDocument, discountsOf, frozenOf, inheritFrom, legacyDiscountOf, linesToInput, stillActiveAddress, type BuiltLine, type DocInput, type LineInput } from '../sales/document.builder.js';
import { snapshotDto } from '../parties/delivery-address.js';
import { rangeFilter } from '../sales/document.http.js';
import { pdfOf } from '../sales/document.pdf.js';
import { assertQuantities } from '../products/units.js';
import { deleteFile, QUOTATION_BUCKET } from '../customers/customer.files.js';
import * as activity from './quotation.activity.js';
import { SYSTEM, type Actor } from './quotation.activity.js';
import * as versions from './quotation.version.js';
import { actionsOf, assertTransition, QUOTATION_STATUSES, QUOTATION_STATUS_LABEL, statusOf, storedStatuses, type QuotationStatus } from './quotation.workflow.js';

type Id = Types.ObjectId;
export type Lean = QuotationDoc & { _id: Id; createdAt?: Date };
export const SEND_METHODS = ['hand', 'post', 'whatsapp', 'phone', 'other'] as const;
export const SEND_METHOD_LABEL: Record<string, string> = { email: 'E-mail', hand: 'Remise en main propre', post: 'Courrier', whatsapp: 'WhatsApp', phone: 'Téléphone', other: 'Autre moyen' };

/** Position affichée d'une ligne : 10, 20, 30… (documents antérieurs : déduite de l'ordre enregistré). */
export const positionOf = (l: { position?: number | null }, index: number) => l.position ?? (index + 1) * 10;

export interface History { sent: boolean; dependants: boolean }
export const toDto = (q: Lean, history?: History) => {
  const status = statusOf(q.status); const version = q.version ?? 1;
  const actions = actionsOf({ status, version, converted: !!(q.proformaId || q.invoiceId), hasSentHistory: history?.sent ?? (!!q.sentAt || status !== 'draft' || version > 1), hasDependants: history?.dependants ?? false });
  return {
    id: q._id.toString(), number: q.number, status, statusLabel: QUOTATION_STATUS_LABEL[status], version, acceptedVersion: q.acceptedVersion ?? null, revision: q.revision ?? 0,
    customerId: q.customerId.toString(), customer: q.customerSnapshot, issueDate: q.issueDate, validUntil: q.validUntil,
    lines: q.lines.map((l, i) => ({ ...l, id: (l as { _id: Id })._id.toString(), position: positionOf(l, i), vat: l.vat })), globalDiscountPct: q.globalDiscountPct ?? 0, syncDiscountPct: q.syncDiscountPct ?? 0, globalDiscountMinor: q.globalDiscountMinor ?? 0,
    withholdingOperationType: q.withholdingOperationType ?? null, withholding: q.withholding ?? null, stamp: q.stamp ?? null, totals: q.totals, notes: q.notes ?? null, terms: q.terms ?? null, paymentTerms: q.paymentTerms ?? null, paymentTermsCustom: !!q.paymentTermsCustom, deliveryAddress: snapshotDto(q.deliveryAddress as never), deliveryTime: q.deliveryTime ?? null,
    proformaId: q.proformaId?.toString() ?? null, invoiceId: q.invoiceId?.toString() ?? null, duplicatedFromId: q.duplicatedFromId?.toString() ?? null,
    sentAt: q.sentAt ?? null, sentBy: q.sentByName ?? null, sentTo: q.sentTo ?? null, sentMethod: q.sentMethod ?? null, sentMethodLabel: q.sentMethod ? SEND_METHOD_LABEL[q.sentMethod] ?? q.sentMethod : null,
    acceptedAt: q.acceptedAt ?? null, acceptedBy: q.acceptedByName ?? null, acceptanceNote: q.acceptanceNote ?? null, refusedAt: q.refusedAt ?? null, refusedBy: q.refusedByName ?? null, refusalReason: q.refusalReason ?? null, expiredAt: q.expiredAt ?? null,
    cancelledAt: q.cancelledAt ?? null, cancelReason: q.cancelReason ?? null, createdAt: q.createdAt,
    /** Actions permises selon le statut et l'historique (les permissions de l'utilisateur s'ajoutent). */
    actions, editable: actions.edit,
  };
};

/** Historique envoyé et documents dépendants : conditionnent la suppression d'un brouillon. */
async function historyOf(companyId: Id, quotes: Lean[]) {
  const ids = quotes.map((q) => q._id);
  const [versioned, delivered] = await Promise.all([
    QuotationVersion.distinct('quotationId', { companyId, quotationId: { $in: ids } }),
    DeliveryNote.distinct('source.id', { companyId, 'source.id': { $in: ids } }),
  ]);
  const v = new Set(versioned.map(String)); const d = new Set((delivered as unknown[]).map(String));
  return (q: Lean): History => ({ sent: v.has(q._id.toString()) || !!q.sentAt || statusOf(q.status) !== 'draft', dependants: d.has(q._id.toString()) });
}
const dtoWithHistory = async (companyId: Id, q: Lean) => toDto(q, (await historyOf(companyId, [q]))(q));

/**
 * Passage automatique en « expiré » des devis ENVOYÉS dont la validité est dépassée (un brouillon n'expire pas : sa date se
 * modifie). Persistant et historisé ; appelé à chaque lecture et périodiquement. La garde sur le statut évite tout doublon.
 */
export async function expireOverdue(companyId?: Id) {
  const due = await Quotation.find({ ...(companyId && { companyId }), status: 'sent', validUntil: { $lt: startOfDay(new Date()) } }).lean() as Lean[];
  let count = 0;
  for (const q of due) {
    await withTransaction(async (session) => {
      const u = await Quotation.updateOne({ _id: q._id, companyId: q.companyId, status: 'sent', validUntil: q.validUntil }, { status: 'expired', expiredAt: new Date() }, { session });
      if (!u.modifiedCount) return;
      await versions.freeze(q, 'expired', { session, origin: 'migration' });
      await versions.setVersionStatus(q.companyId, q._id, q.version ?? 1, 'expired', session);
      await activity.record(q.companyId, q._id, [{ kind: 'expired', valueType: 'text', oldValue: QUOTATION_STATUS_LABEL.sent, newValue: QUOTATION_STATUS_LABEL.expired, description: `Version ${q.version ?? 1} — date de validité dépassée (${q.validUntil.toISOString().slice(0, 10).split('-').reverse().join('/')})`, eventKey: `expired:${q._id}:${q.version ?? 1}` }], SYSTEM, session);
      count++;
    });
  }
  return count;
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: QuotationStatus | undefined; customerId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  await expireOverdue(companyId);
  const filter: QueryFilter<QuotationDoc> = { companyId };
  if (f.status) filter.status = { $in: storedStatuses(f.status) } as never; if (f.customerId) filter.customerId = f.customerId as never;
  const range = rangeFilter(f.from, f.to); if (range) filter.issueDate = range;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'customerSnapshot.name': rx }, { 'customerSnapshot.code': rx }]; }
  const key = f.sort?.replace(/customer$/, 'customerSnapshot.name').replace(/(totalHtMinor|totalTtcMinor)$/, 'totals.$1');
  const sort = buildSort(key, ['number', 'issueDate', 'validUntil', 'createdAt', 'status', 'customerSnapshot.name', 'totals.totalHtMinor', 'totals.totalTtcMinor'], { issueDate: -1, _id: -1 });
  const [items, total] = await Promise.all([Quotation.find(filter).select('-lines').sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean() as Promise<Lean[]>, Quotation.countDocuments(filter)]);
  const history = await historyOf(companyId, items);
  return { items: items.map((q) => ({ ...toDto({ ...q, lines: [] } as unknown as Lean, history(q)), lines: undefined })), total, page: f.page, limit: f.limit };
}

export async function getOwn(companyId: Id, id: string) {
  await expireOverdue(companyId);
  const q = await Quotation.findOne({ _id: id, companyId }).lean();
  if (!q) throw AppError.notFound('Devis introuvable');
  return q as Lean;
}
export const get = async (companyId: Id, id: string) => dtoWithHistory(companyId, await getOwn(companyId, id));

type Body = DocInput & { issueDate?: Date | undefined; validUntil: Date; notes?: string | undefined; terms?: string | undefined; deliveryTime?: string | undefined; revision?: number | undefined };
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
    // Duplication : les quantités et l'éventuelle ancienne remise du document source sont reprises telles quelles
    const doc = await buildDocument(companyId, 'quotation', b, { date: issueDate, session, preserveQuantities: !!source });
    const number = await nextDocumentNumber(companyId, 'quotation', session, issueDate);
    const [created] = await Quotation.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: arrange(doc.lines, b.lines), globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType,
      withholding: doc.withholding, stamp: doc.stamp, totals: doc.totals, notes: b.notes, terms: b.terms, deliveryTime: b.deliveryTime, ...frozenOf(doc), version: 1, versionCreatedAt: new Date(), versionCreatedByName: actor.name,
      ...(source && { duplicatedFromId: source._id }), createdBy: userId }] as never[], { session });
    await activity.record(companyId, created!._id, [{ kind: 'created', eventKey: `created:${created!._id}`, valueType: 'money', newValue: doc.totals.totalTtcMinor, description: `${doc.lines.length} ligne(s) — client ${doc.customer.name}`,
      ...(source && { related: { type: 'quotation', id: source._id, number: source.number } }) }], actor, session);
    if (source) await activity.record(companyId, source._id, [{ kind: 'duplicated', related: { type: 'quotation', id: created!._id, number }, description: `Nouveau devis ${number}` }], actor, session);
    return created!;
  });
  return toDto(q.toObject() as Lean);
}

const busy = (q: { sendingUntil?: Date | null }) => !!q.sendingUntil && q.sendingUntil.getTime() > Date.now();
const concurrent = () => new AppError(409, 'Le devis a été modifié entre-temps : rechargez la page avant de continuer', 'CONCURRENT_UPDATE');

export async function update(companyId: Id, id: string, b: Body, actor: Actor = {}) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const cur = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    if (!toDto(cur).editable) throw AppError.conflict('Seul un devis au brouillon est modifiable : créez une nouvelle version ou dupliquez-le');
    if (busy(cur)) throw AppError.conflict('Envoi en cours : réessayez dans un instant');
    if (b.revision !== undefined && b.revision !== (cur.revision ?? 0)) throw concurrent();
    const issueDate = startOfDay(b.issueDate ?? cur.issueDate);
    const inherit = inheritFrom(cur, b.customerId);
    const doc = await buildDocument(companyId, 'quotation', { ...b, ...legacyDiscountOf(cur, b) }, { date: issueDate, session, ...(inherit && { inherit }) });
    const next = { customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate, validUntil: startOfDay(b.validUntil),
      lines: arrange(doc.lines, b.lines, cur.lines), globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType ?? null,
      withholding: doc.withholding ?? null, stamp: doc.stamp ?? null, totals: doc.totals, notes: b.notes, terms: b.terms, ...(b.deliveryTime !== undefined && { deliveryTime: b.deliveryTime }), ...frozenOf(doc), status: 'draft' };
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: cur.status, proformaId: null, invoiceId: null }, { $set: next, $inc: { revision: 1 } }, { returnDocument: 'after', session }).lean();
    if (!u) throw concurrent();
    // Les champs absents de la requête conservent leur valeur : la comparaison porte sur ce qui est réellement enregistré.
    // Un brouillon est mis à jour en place : aucune version n'est créée.
    await activity.record(companyId, cur._id, activity.diff(cur as never, u as never), actor, session);
    return toDto(u as Lean);
  });
}

/** Suppression : brouillon sans aucun historique envoyé ni document dépendant. */
export async function remove(companyId: Id, id: string) {
  const q = await getOwn(companyId, id);
  const history = (await historyOf(companyId, [q]))(q);
  if (q.proformaId || q.invoiceId) throw AppError.conflict('Suppression impossible : le devis a été converti');
  if (statusOf(q.status) !== 'draft') throw AppError.conflict(`Suppression impossible : un devis « ${QUOTATION_STATUS_LABEL[statusOf(q.status)]} » est conservé avec son historique`);
  if (history.dependants) throw AppError.conflict('Suppression impossible : des bons de livraison en dépendent');
  if (!toDto(q, history).actions.remove) throw AppError.conflict('Suppression impossible : une version de ce devis a déjà été envoyée (abandonnez le brouillon pour revenir à la version envoyée)');
  const files = await QuotationDocument.find({ companyId, quotationId: q._id }).select('fileId').lean();
  const r = await Quotation.deleteOne({ _id: id, companyId, status: q.status, revision: q.revision ?? null });
  if (!r.deletedCount) throw concurrent();
  await Promise.all([QuotationDocument.deleteMany({ companyId, quotationId: q._id }), QuotationComment.deleteMany({ companyId, quotationId: q._id }), ...files.map((f) => deleteFile(f.fileId, QUOTATION_BUCKET))]);
  return q;
}

// ---------- Envoi ----------
const LOCK_MS = 120_000;
/**
 * Prépare un envoi : contrôle le statut, verrouille le contenu et produit le PDF qui sera transmis. Un brouillon doit encore
 * être valable et respecter les règles de quantité. `release` est à appeler si l'envoi échoue : rien n'a alors changé.
 */
export async function beginSend(companyId: Id, id: string) {
  const q = await getOwn(companyId, id); const status = statusOf(q.status);
  if (!toDto(q).actions.send) throw AppError.conflict(`Envoi impossible : devis « ${QUOTATION_STATUS_LABEL[status].toLowerCase()} »`);
  if (status === 'draft') {
    if (q.validUntil < startOfDay(new Date())) throw AppError.conflict('La date de validité est dépassée : modifiez-la avant l’envoi');
    await assertQuantities(companyId, q.lines.map((l) => ({ productId: l.productId, unit: l.unit, quantity: l.quantity })));
  }
  const locked = await Quotation.findOneAndUpdate({ _id: q._id, companyId, status: q.status, revision: q.revision ?? null, $or: [{ sendingUntil: null }, { sendingUntil: { $lt: new Date() } }] } as never,
    { $set: { sendingUntil: new Date(Date.now() + LOCK_MS) } }, { returnDocument: 'after' }).lean();
  if (!locked) throw AppError.conflict('Un envoi ou une modification est en cours : réessayez');
  const release = async () => { await Quotation.updateOne({ _id: q._id, companyId }, { $unset: { sendingUntil: 1 } }); };
  try {
    // Réenvoi d'un devis déjà envoyé : le PDF de la version figée est retransmis à l'identique
    const record = status === 'sent' ? await QuotationVersion.findOne({ companyId, quotationId: q._id, version: q.version ?? 1 }).lean() : null;
    const pdf = record ? await versions.versionPdf(companyId, record) : await pdfOf(companyId, 'quotation', toDto(locked as Lean));
    return { quote: locked as Lean, pdf, release };
  } catch (e) { await release(); throw e; }
}
export type Prepared = Awaited<ReturnType<typeof beginSend>>;

/** À appeler UNIQUEMENT après une transmission réelle : le brouillon devient « Envoyé » et sa version est figée. */
export async function completeSend(companyId: Id, p: Prepared, actor: Actor, d: { method: string; recipient?: string | undefined; note?: string | undefined }) {
  const q = p.quote; const becomesSent = statusOf(q.status) === 'draft'; const version = q.version ?? 1;
  const pdfFileId = becomesSent ? await versions.storePdf(companyId, q._id, q.number, version, p.pdf) : undefined;
  const meta = { sentAt: new Date(), sentByName: actor.name, sentTo: d.recipient ?? null, sentMethod: d.method };
  try {
    return await withTransaction(async (session) => {
      const u = await Quotation.findOneAndUpdate({ _id: q._id, companyId, status: q.status, revision: q.revision ?? null } as never,
        { $set: { ...meta, sentBy: actor.userId, ...(becomesSent && { status: 'sent' }) }, $unset: { sendingUntil: 1 } }, { returnDocument: 'after', session }).lean();
      if (!u) throw concurrent();
      await versions.freeze(u as Lean, 'sent', { session, meta, pdfFileId, authorName: actor.name });
      if (!becomesSent) await versions.setVersionStatus(companyId, q._id, version, 'sent', session, meta);
      const description = d.method === 'email' ? [`Version ${version}`, `Destinataire : ${d.recipient}`].join(' — ')
        : [`Version ${version}`, `Mode : ${SEND_METHOD_LABEL[d.method]}`, d.recipient && `Destinataire : ${d.recipient}`, d.note].filter(Boolean).join(' — ');
      await activity.record(companyId, q._id, [{ kind: d.method === 'email' ? 'email_sent' : 'marked_sent', description,
        ...(becomesSent && { valueType: 'text' as const, oldValue: QUOTATION_STATUS_LABEL.draft, newValue: QUOTATION_STATUS_LABEL.sent }) }], actor, session);
      return toDto(u as Lean);
    });
  } catch (e) { if (pdfFileId) await versions.dropPdf(pdfFileId); await p.release(); throw e; }
}
/** Devis transmis par un autre moyen que l'e-mail de l'ERP (ou transmis à nouveau). */
export async function markSent(companyId: Id, id: string, actor: Actor, d: { method: (typeof SEND_METHODS)[number]; recipient?: string | undefined; note?: string | undefined }) {
  return completeSend(companyId, await beginSend(companyId, id), actor, d);
}

// ---------- Décisions ----------
/** Changement de statut d'une version envoyée : transition contrôlée, version et événement dans la même transaction. */
async function transition(companyId: Id, id: string, to: QuotationStatus, set: Record<string, unknown>, event: Omit<activity.Event, 'valueType' | 'oldValue' | 'newValue'>, actor: Actor) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    const from = statusOf(q.status); assertTransition(from, to);
    if (busy(q)) throw AppError.conflict('Envoi en cours : réessayez dans un instant');
    const version = q.version ?? 1;
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: q.status }, { $set: { status: to, ...set, ...(to === 'accepted' && { acceptedVersion: version }) } }, { returnDocument: 'after', session }).lean();
    if (!u) throw concurrent();
    await versions.freeze(q, to, { session, origin: 'migration' });
    await versions.setVersionStatus(companyId, q._id, version, to, session);
    await activity.record(companyId, q._id, [{ ...event, description: [`Version ${version}`, event.description].filter(Boolean).join(' — '), valueType: 'text', oldValue: QUOTATION_STATUS_LABEL[from], newValue: QUOTATION_STATUS_LABEL[to] }], actor, session);
    return toDto(u as Lean);
  });
}
export const accept = (c: Id, id: string, actor: Actor = {}, comment?: string) =>
  transition(c, id, 'accepted', { acceptedAt: new Date(), acceptedBy: actor.userId, acceptedByName: actor.name, ...(comment && { acceptanceNote: comment }) }, { kind: 'accepted', description: comment }, actor);
export const refuse = (c: Id, id: string, actor: Actor = {}, reason?: string) =>
  transition(c, id, 'refused', { refusedAt: new Date(), refusedBy: actor.userId, refusedByName: actor.name, ...(reason && { refusalReason: reason }) }, { kind: 'refused', description: reason ? `Motif : ${reason}` : undefined }, actor);
/** Annulation d'un devis accepté. Sans route : sera déclenchée par l'annulation de la proforma liée (mission 2). */
export const cancel = (c: Id, id: string, actor: Actor = {}, reason?: string) =>
  transition(c, id, 'cancelled', { cancelledAt: new Date(), ...(reason && { cancelReason: reason }) }, { kind: 'cancelled', description: reason ? `Motif : ${reason}` : undefined }, actor);

// ---------- Versions ----------
const SENDING = { sentAt: 1, sentBy: 1, sentByName: 1, sentTo: 1, sentMethod: 1, expiredAt: 1, sendingUntil: 1 } as const;

/**
 * Nouvelle version d'un devis envoyé ou expiré : la version précédente reste figée (elle devient « Remplacée » et ne peut plus
 * être acceptée) et un brouillon, copie conforme, est ouvert sous le même numéro.
 */
export async function newVersion(companyId: Id, id: string, actor: Actor, opts: { validUntil?: Date | undefined } = {}) {
  await getOwn(companyId, id);
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    const status = statusOf(q.status);
    if (!toDto(q).actions.newVersion) throw AppError.conflict(status === 'accepted' ? 'Devis accepté : pour une modification, dupliquez-le (nouveau devis)' : `Nouvelle version impossible : devis « ${QUOTATION_STATUS_LABEL[status].toLowerCase()} »`);
    if (busy(q)) throw AppError.conflict('Envoi en cours : réessayez dans un instant');
    const from = q.version ?? 1; const today = startOfDay(new Date());
    if (opts.validUntil && startOfDay(opts.validUntil) < today) throw AppError.badRequest('La nouvelle date de validité ne peut pas être dépassée');
    await versions.freeze(q, status, { session, origin: 'migration' });
    if (status === 'sent') await versions.setVersionStatus(companyId, q._id, from, 'superseded', session);
    const last = await QuotationVersion.findOne({ companyId, quotationId: q._id }).sort({ version: -1 }).session(session).select('version').lean();
    const next = Math.max(from, last?.version ?? 0) + 1;
    const duration = Math.max(DAY, q.validUntil.getTime() - q.issueDate.getTime());
    const validUntil = opts.validUntil ? startOfDay(opts.validUntil) : q.validUntil >= today ? q.validUntil : new Date(today.getTime() + duration);
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: q.status, version: q.version ?? null } as never,
      { $set: { status: 'draft', version: next, versionCreatedAt: new Date(), versionCreatedByName: actor.name, validUntil }, $unset: SENDING, $inc: { revision: 1 } }, { returnDocument: 'after', session }).lean();
    if (!u) throw concurrent();
    await activity.record(companyId, q._id, [{ kind: 'version_created', description: `Copie de la version ${from} (${status === 'sent' ? 'remplacée' : 'expirée'})`, valueType: 'text', oldValue: `Version ${from}`, newValue: `Version ${next}`, eventKey: `version:${q._id}:${next}` }], actor, session);
    return toDto(u as Lean);
  });
}
const DAY = 86_400_000;

/** Abandon du brouillon d'une nouvelle version : la dernière version transmise redevient la version courante. */
export async function abandonVersion(companyId: Id, id: string, actor: Actor) {
  await getOwn(companyId, id);
  const result = await withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    const version = q.version ?? 1;
    const previous = await QuotationVersion.findOne({ companyId, quotationId: q._id, version: { $lt: version }, status: { $in: ['superseded', 'expired'] } }).sort({ version: -1 }).session(session).lean();
    if (statusOf(q.status) !== 'draft' || !previous) throw AppError.conflict('Aucun brouillon de nouvelle version à abandonner');
    if (busy(q)) throw AppError.conflict('Envoi en cours : réessayez dans un instant');
    await versions.freeze(q, 'abandoned', { session });
    const snap = previous.snapshot as Record<string, unknown>;
    const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
    for (const k of versions.CONTENT) { if (snap[k] === undefined || snap[k] === null) $unset[k] = 1; else $set[k] = snap[k]; }
    const validUntil = new Date(snap.validUntil as Date);
    const restored = previous.status === 'expired' || validUntil < startOfDay(new Date()) ? 'expired' : 'sent';
    const u = await Quotation.findOneAndUpdate({ _id: id, companyId, status: q.status, version }, { $set: { ...$set, status: restored, version: previous.version, versionCreatedAt: previous.versionCreatedAt, versionCreatedByName: previous.authorName,
      sentAt: previous.sentAt, sentByName: previous.sentByName, sentTo: previous.sentTo, sentMethod: previous.sentMethod, ...(restored === 'expired' && { expiredAt: new Date() }) }, ...(Object.keys($unset).length && { $unset }), $inc: { revision: 1 } }, { returnDocument: 'after', session }).lean();
    if (!u) throw concurrent();
    await versions.setVersionStatus(companyId, q._id, previous.version, restored, session);
    await activity.record(companyId, q._id, [{ kind: 'version_abandoned', description: `Le brouillon de la version ${version} est conservé dans les versions`, valueType: 'text', oldValue: `Version ${version}`, newValue: `Version ${previous.version}` }], actor, session);
    return toDto(u as Lean);
  });
  return result;
}

export async function listVersions(companyId: Id, id: string) {
  const q = await getOwn(companyId, id);
  return versions.listVersions(q, toDto(q));
}
/** Contenu d'une version : la copie figée, ou le devis lui-même pour le brouillon en cours. */
export async function getVersion(companyId: Id, id: string, version: number) {
  const q = await getOwn(companyId, id);
  const record = await QuotationVersion.findOne({ companyId, quotationId: q._id, version }).lean();
  if (record) return { version, status: record.status, statusLabel: versions.VERSION_STATUS_LABEL[record.status], origin: record.origin ?? 'application', frozenAt: record.frozenAt, author: record.authorName ?? null, content: versions.viewOf(record.snapshot as never) };
  if (version !== (q.version ?? 1)) throw AppError.notFound('Version introuvable');
  const dto = toDto(q);
  return { version, status: dto.status, statusLabel: dto.statusLabel, origin: 'application', frozenAt: null, author: q.versionCreatedByName ?? null, content: dto };
}
/** PDF d'une version (par défaut la version courante) : le fichier figé lorsqu'elle l'est. */
export async function pdf(companyId: Id, id: string, version?: number) {
  const q = await getOwn(companyId, id); const n = version ?? q.version ?? 1;
  const record = await QuotationVersion.findOne({ companyId, quotationId: q._id, version: n }).lean();
  const filename = `${q.number}-v${n}.pdf`;
  if (record) return { body: await versions.versionPdf(companyId, record), filename, quote: q, version: n };
  if (n !== (q.version ?? 1)) throw AppError.notFound('Version introuvable');
  return { body: await pdfOf(companyId, 'quotation', toDto(q)), filename, quote: q, version: n };
}

// ---------- Duplication et conversion ----------
/** Duplication : NOUVEAU devis au brouillon (version 1, numéro propre, TVA résolue à la date du jour) ; l'original est conservé. */
export async function duplicate(companyId: Id, userId: Id, id: string, actor: Actor = { userId }) {
  const src = await getOwn(companyId, id);
  const days = Math.max(1, Math.round((src.validUntil.getTime() - src.issueDate.getTime()) / DAY));
  const today = startOfDay(new Date());
  const deliveryAddressId = await stillActiveAddress(companyId, src.customerId, src.deliveryAddress as never);
  return create(companyId, userId, { customerId: src.customerId, deliveryAddressId, ...(src.paymentTerms !== undefined && { paymentTerms: src.paymentTerms, paymentTermsCustom: !!src.paymentTermsCustom }), lines: linesToInput(src.lines), ...discountsOf(src),
    withholdingOperationType: src.withholdingOperationType ?? undefined, issueDate: today, validUntil: new Date(today.getTime() + days * DAY), notes: src.notes ?? undefined, terms: src.terms ?? undefined, deliveryTime: src.deliveryTime ?? undefined }, actor, src);
}

/** Devis ACCEPTÉ → proforma (seule conversion possible), rattachée à la version acceptée. */
export async function convertToProforma(companyId: Id, userId: Id, id: string, validUntil?: Date, actor: Actor = { userId }) {
  await expireOverdue(companyId);
  await ensureCounter(companyId, 'proforma', startOfDay(new Date()));
  return withTransaction(async (session) => {
    const q = (await Quotation.findOne({ _id: id, companyId }).session(session).lean()) as Lean | null;
    if (!q) throw AppError.notFound('Devis introuvable');
    if (q.proformaId || q.invoiceId) throw AppError.conflict('Ce devis a déjà été converti');
    if (statusOf(q.status) !== 'accepted') throw AppError.conflict('Seul un devis accepté peut être converti en proforma');
    if (await DeliveryNote.exists({ companyId, 'source.id': q._id }).session(session)) throw AppError.conflict('Des bons de livraison existent pour ce devis : facturez-les');
    const today = startOfDay(new Date());
    const days = Math.max(1, Math.round((q.validUntil.getTime() - q.issueDate.getTime()) / DAY));
    const version = q.acceptedVersion ?? q.version ?? 1;
    const doc = await buildDocument(companyId, 'proforma', { customerId: q.customerId, lines: linesToInput(q.lines), ...discountsOf(q), withholdingOperationType: q.withholdingOperationType }, { date: today, session, inherit: inheritFrom(q, q.customerId)!, preserveQuantities: true });
    const number = await nextDocumentNumber(companyId, 'proforma', session, today);
    const [p] = await Proforma.create([{ companyId, number, customerId: doc.customer._id, customerSnapshot: doc.customerSnapshot, issueDate: today, validUntil: validUntil ? startOfDay(validUntil) : new Date(today.getTime() + days * DAY),
      lines: doc.lines, globalDiscountPct: doc.globalDiscountPct, syncDiscountPct: doc.syncDiscountPct, globalDiscountMinor: doc.globalDiscountMinor, withholdingOperationType: doc.withholdingOperationType, withholding: doc.withholding, stamp: doc.stamp,
      totals: doc.totals, quotationId: q._id, quotationVersion: version, deliveryTime: q.deliveryTime, notes: q.notes, terms: q.terms, ...frozenOf(doc), createdBy: userId }] as never[], { session });
    const u = await Quotation.updateOne({ _id: q._id, companyId, status: 'accepted', proformaId: null, invoiceId: null }, { $set: { proformaId: p!._id } }, { session });
    if (!u.modifiedCount) throw concurrent();
    await activity.record(companyId, q._id, [{ kind: 'converted_proforma', related: { type: 'proforma', id: p!._id, number }, description: `Version ${version} → proforma ${number}`, eventKey: `proforma:${p!._id}` }], actor, session);
    return { proformaId: p!._id.toString(), number, quotationVersion: version };
  });
}

/** Compteurs réels par statut, montants et taux de transformation. */
export async function stats(companyId: Id) {
  await expireOverdue(companyId);
  const rows = await Quotation.aggregate<{ _id: string; n: number; totalMinor: number }>([{ $match: { companyId } }, { $group: { _id: '$status', n: { $sum: 1 }, totalMinor: { $sum: '$totals.totalTtcMinor' } } }]);
  const sum = (s: QuotationStatus, k: 'n' | 'totalMinor') => rows.filter((r) => storedStatuses(s).includes(r._id)).reduce((t, r) => t + r[k], 0);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const converted = await Quotation.countDocuments({ companyId, $or: [{ proformaId: { $ne: null } }, { invoiceId: { $ne: null } }] });
  const counts = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, sum(s, 'n')])) as Record<QuotationStatus, number>;
  return { total, ...counts, draftTotalMinor: sum('draft', 'totalMinor'), openTotalMinor: sum('sent', 'totalMinor'), acceptedTotalMinor: sum('accepted', 'totalMinor'), converted, conversionRatePct: total ? Math.round((converted / total) * 10000) / 100 : 0 };
}
