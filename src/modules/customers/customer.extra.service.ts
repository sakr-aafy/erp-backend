import type { Types } from 'mongoose';
import { ACTIVITY_KINDS, CustomerActivity, CustomerDocument } from '../../models/customer.model.js';
import { Invoice, Payment, Quotation } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile, inspect, MAX_DOC_BYTES, openFile, putFile } from './customer.files.js';
import { effectiveStatus, getOwn, logAuto, type Actor } from './customer.service.js';

type Id = Types.ObjectId;
type Perms = ReadonlySet<string>;
export const DOC_TYPE_LABEL: Record<string, string> = { registry_extract: 'Extrait du registre de commerce', tax_card: 'Carte d’identification fiscale', contract: 'Contrat commercial', other: 'Autre document' };
const MAX_DOCS = 50;

// ---------- Documents ----------
const docDto = (d: { _id: Id; type: string; description?: string | null; originalName: string; mime?: string | null; size?: number | null; uploadedByName?: string | null; createdAt?: Date }) => ({
  id: d._id.toString(), type: d.type, typeLabel: DOC_TYPE_LABEL[d.type] ?? d.type, description: d.description ?? null, name: d.originalName, mime: d.mime ?? null, size: d.size ?? 0,
  uploadedBy: d.uploadedByName ?? null, uploadedAt: d.createdAt,
});
export async function listDocuments(companyId: Id, customerId: string) {
  const c = await getOwn(companyId, customerId);
  return (await CustomerDocument.find({ companyId, customerId: c._id }).sort({ createdAt: -1 }).lean()).map(docDto);
}
export async function addDocument(companyId: Id, customerId: string, file: { originalname: string; buffer: Buffer; size: number }, meta: { type: string; description?: string | undefined }, actor: Actor) {
  const c = await getOwn(companyId, customerId);
  if (effectiveStatus(c) === 'archived') throw AppError.conflict('Client archivé : réactivez-le avant d’ajouter un document');
  if (file.size > MAX_DOC_BYTES) throw new AppError(413, 'Fichier trop volumineux (10 Mo maximum)', 'PAYLOAD_TOO_LARGE');
  if ((await CustomerDocument.countDocuments({ companyId, customerId: c._id })) >= MAX_DOCS) throw AppError.conflict(`${MAX_DOCS} documents maximum par client`);
  const f = inspect(file);
  const fileId = await putFile(companyId, c._id, f.name, f.mime, file.buffer);
  try {
    const doc = await CustomerDocument.create({ companyId, customerId: c._id, type: meta.type as never, ...(meta.description && { description: meta.description }), originalName: f.name, fileId, mime: f.mime, size: file.buffer.length, uploadedBy: actor.userId, uploadedByName: actor.name });
    await logAuto(companyId, c._id, 'document_added', `Document ajouté : ${DOC_TYPE_LABEL[meta.type] ?? meta.type} (${f.name})`, actor, { documentId: doc._id.toString() });
    return docDto(doc.toObject());
  } catch (e) { await deleteFile(fileId); throw e; }
}
async function ownDoc(companyId: Id, customerId: string, docId: string) {
  const c = await getOwn(companyId, customerId); // vérifie l'appartenance du client à la société
  const d = await CustomerDocument.findOne({ _id: docId, companyId, customerId: c._id }).lean();
  if (!d) throw AppError.notFound('Document introuvable');
  return d;
}
export async function updateDocument(companyId: Id, customerId: string, docId: string, patch: { type?: string | undefined; description?: string | undefined }) {
  await ownDoc(companyId, customerId, docId);
  const $set: Record<string, unknown> = {}; if (patch.type) $set.type = patch.type; if (patch.description !== undefined) $set.description = patch.description;
  const d = await CustomerDocument.findOneAndUpdate({ _id: docId, companyId, customerId }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  return docDto(d!);
}
export async function removeDocument(companyId: Id, customerId: string, docId: string, actor: Actor) {
  const d = await ownDoc(companyId, customerId, docId);
  await CustomerDocument.deleteOne({ _id: docId, companyId });
  await deleteFile(d.fileId);
  await logAuto(companyId, customerId, 'document_removed', `Document supprimé : ${d.originalName}`, actor);
  return d;
}
export async function documentStream(companyId: Id, customerId: string, docId: string) {
  const d = await ownDoc(companyId, customerId, docId);
  return { doc: d, stream: openFile(d.fileId), inline: /^(application\/pdf|image\/(png|jpeg))$/.test(d.mime ?? '') };
}

// ---------- Activités ----------
export const KIND_LABEL: Record<string, string> = {
  call: 'Appel téléphonique', email: 'E-mail', meeting: 'Réunion', note: 'Note commerciale', follow_up: 'Suivi client', other: 'Autre activité',
  customer_created: 'Client créé', customer_updated: 'Client modifié', status_changed: 'Changement de statut', document_added: 'Document ajouté', document_removed: 'Document supprimé',
  quotation_created: 'Devis créé', quotation_sent: 'Devis envoyé', invoice_validated: 'Facture validée', payment_recorded: 'Paiement enregistré',
};
export interface ActivityRow { id: string; auto: boolean; derived: boolean; editable: boolean; kind: string; kindLabel: string; title: string; description: string | null; occurredAt: Date; user: string | null; ref?: { type: string; id: string; number: string | null } }

const actDto = (a: { _id: Id; auto?: boolean | null; kind: string; title: string; description?: string | null; occurredAt: Date; userName?: string | null }): ActivityRow => ({
  id: a._id.toString(), auto: !!a.auto, derived: false, editable: !a.auto, kind: a.kind, kindLabel: KIND_LABEL[a.kind] ?? a.kind, title: a.title, description: a.description ?? null, occurredAt: a.occurredAt, user: a.userName ?? null,
});

/**
 * Chronologie : activités manuelles + événements automatiques de la fiche (collection dédiée, distincte du journal d'audit)
 * + événements issus des documents réels (devis, factures validées, paiements) — lus à la volée, donc jamais dupliqués ni modifiables.
 */
export async function listActivities(companyId: Id, customerId: string, perms: Perms, q: { page: number; limit: number; kind?: string | undefined }) {
  const c = await getOwn(companyId, customerId); const take = q.page * q.limit + 50;
  const stored = await CustomerActivity.find({ companyId, customerId: c._id, ...(q.kind && { kind: q.kind as never }) }).sort({ occurredAt: -1 }).limit(take).lean();
  const derived: ActivityRow[] = [];
  const add = (kind: string, id: Id, type: string, number: string | null | undefined, at: Date | undefined | null, title: string) => {
    if (!at || (q.kind && q.kind !== kind)) return;
    derived.push({ id: `${kind}:${id}`, auto: true, derived: true, editable: false, kind, kindLabel: KIND_LABEL[kind]!, title, description: null, occurredAt: at, user: null, ref: { type, id: id.toString(), number: number ?? null } });
  };
  if (perms.has('quotations:view')) {
    for (const d of await Quotation.find({ companyId, customerId: c._id }).sort({ issueDate: -1 }).limit(take).select('number issueDate createdAt sentAt').lean()) {
      add('quotation_created', d._id, 'quotation', d.number, d.createdAt ?? d.issueDate, `Devis créé : ${d.number}`);
      add('quotation_sent', d._id, 'quotation', d.number, d.sentAt, `Devis envoyé : ${d.number}`);
    }
  }
  if (perms.has('invoices:view')) {
    for (const d of await Invoice.find({ companyId, customerId: c._id, status: 'validated' }).sort({ validatedAt: -1 }).limit(take).select('number type validatedAt issueDate').lean()) {
      add('invoice_validated', d._id, d.type ?? 'invoice', d.number, d.validatedAt ?? d.issueDate, `${d.type === 'credit_note' ? 'Avoir validé' : 'Facture validée'} : ${d.number}`);
    }
    for (const p of await Payment.find({ companyId, customerId: c._id, status: 'active' }).sort({ paidAt: -1 }).limit(take).select('invoiceId amountMinor paidAt').lean()) {
      add('payment_recorded', p._id, 'payment', null, p.paidAt, 'Paiement enregistré');
    }
  }
  const all = [...stored.map((a) => actDto(a as never)), ...derived].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
  const want = (k: string) => !q.kind || q.kind === k;
  const counts = await Promise.all([
    CustomerActivity.countDocuments({ companyId, customerId: c._id, ...(q.kind && { kind: q.kind as never }) }),
    perms.has('quotations:view') && want('quotation_created') ? Quotation.countDocuments({ companyId, customerId: c._id }) : 0,
    perms.has('quotations:view') && want('quotation_sent') ? Quotation.countDocuments({ companyId, customerId: c._id, sentAt: { $exists: true, $ne: null } }) : 0,
    perms.has('invoices:view') && want('invoice_validated') ? Invoice.countDocuments({ companyId, customerId: c._id, status: 'validated' }) : 0,
    perms.has('invoices:view') && want('payment_recorded') ? Payment.countDocuments({ companyId, customerId: c._id, status: 'active' }) : 0,
  ]);
  const total = counts.reduce((a, b) => a + b, 0);
  return { items: all.slice((q.page - 1) * q.limit, q.page * q.limit), total, page: q.page, limit: q.limit };
}

export async function addActivity(companyId: Id, customerId: string, d: { kind: (typeof ACTIVITY_KINDS)[number]; title: string; description?: string | undefined; occurredAt?: Date | undefined }, actor: Actor) {
  const c = await getOwn(companyId, customerId);
  const a = await CustomerActivity.create({ companyId, customerId: c._id, auto: false, kind: d.kind as never, title: d.title, ...(d.description && { description: d.description }), occurredAt: d.occurredAt ?? new Date(), userId: actor.userId, userName: actor.name });
  return actDto(a.toObject());
}
async function manualOwn(companyId: Id, customerId: string, activityId: string) {
  const c = await getOwn(companyId, customerId);
  const a = await CustomerActivity.findOne({ _id: activityId, companyId, customerId: c._id }).lean();
  if (!a) throw AppError.notFound('Activité introuvable');
  if (a.auto) throw AppError.conflict('Un événement automatique ne peut pas être modifié ni supprimé');
  return a;
}
export async function updateActivity(companyId: Id, customerId: string, activityId: string, patch: { kind?: string | undefined; title?: string | undefined; description?: string | undefined; occurredAt?: Date | undefined }) {
  await manualOwn(companyId, customerId, activityId);
  const $set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const a = await CustomerActivity.findOneAndUpdate({ _id: activityId, companyId, auto: false }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  return actDto(a!);
}
export async function removeActivity(companyId: Id, customerId: string, activityId: string) {
  await manualOwn(companyId, customerId, activityId);
  await CustomerActivity.deleteOne({ _id: activityId, companyId, auto: false });
}
