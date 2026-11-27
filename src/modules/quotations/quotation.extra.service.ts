import type { Types } from 'mongoose';
import { QuotationComment, QuotationDocument, QuotationVersion, QUOTATION_DOC_TYPES } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile, inspect, MAX_DOC_BYTES, openFile, putFile, QUOTATION_BUCKET } from '../customers/customer.files.js';
import * as activity from './quotation.activity.js';
import type { Actor } from './quotation.activity.js';
import { getOwn, type Lean } from './quotation.service.js';
import { statusOf } from './quotation.workflow.js';

type Id = Types.ObjectId;
export const QUOTATION_DOC_LABEL: Record<(typeof QUOTATION_DOC_TYPES)[number], string> = {
  price_request: 'Demande de prix', specifications: 'Cahier des charges', catalog: 'Catalogue', datasheet: 'Fiche technique', drawing: 'Plan technique', signed_quote: 'Devis signé', customer_confirmation: 'Confirmation du client', other: 'Autre document',
};
const MAX_DOCS = 50;

// ---------- Documents ----------
type Doc = { _id: Id; type: string; description?: string | null; version?: number | null; originalName: string; mime?: string | null; size?: number | null; uploadedByName?: string | null; createdAt?: Date };
/** Une pièce se conserve lorsque le devis est accepté ou annulé, ou lorsqu'elle est rattachée à une version figée. */
function lockReason(q: Lean, frozen: Set<number>, d: { version?: number | null }) {
  const status = statusOf(q.status);
  if (status === 'accepted' || status === 'cancelled') return 'Pièce conservée : le devis est accepté ou annulé';
  if (d.version && frozen.has(d.version)) return `Pièce conservée : elle est rattachée à la version ${d.version}, déjà transmise`;
  return null;
}
const frozenVersions = async (q: Lean) => new Set((await QuotationVersion.find({ companyId: q.companyId, quotationId: q._id }).select('version').lean()).map((v) => v.version));
const docDto = (q: Lean, frozen: Set<number>) => (d: Doc) => ({
  id: d._id.toString(), type: d.type, typeLabel: QUOTATION_DOC_LABEL[d.type as never] ?? d.type, description: d.description ?? null, version: d.version ?? null, name: d.originalName, mime: d.mime ?? null, size: d.size ?? 0,
  uploadedBy: d.uploadedByName ?? null, uploadedAt: d.createdAt, lockedReason: lockReason(q, frozen, d), previewable: /^(application\/pdf|image\/(png|jpeg|webp))$/.test(d.mime ?? ''),
});
export async function listDocuments(companyId: Id, id: string) {
  const q = await getOwn(companyId, id);
  const items = await QuotationDocument.find({ companyId, quotationId: q._id }).sort({ createdAt: -1 }).lean();
  return { items: items.map(docDto(q, await frozenVersions(q))) };
}
async function assertVersion(q: Lean, version: number | undefined) {
  if (version === undefined) return;
  if (version !== (q.version ?? 1) && !(await QuotationVersion.exists({ companyId: q.companyId, quotationId: q._id, version }))) throw AppError.badRequest('Version inconnue pour ce devis');
}
type Meta = { type: (typeof QUOTATION_DOC_TYPES)[number]; description?: string | undefined; version?: number | undefined };
export async function addDocument(companyId: Id, id: string, file: { originalname: string; buffer: Buffer }, meta: Meta, actor: Actor) {
  const q = await getOwn(companyId, id);
  if (file.buffer.length > MAX_DOC_BYTES) throw new AppError(413, 'Fichier trop volumineux (10 Mo maximum)', 'PAYLOAD_TOO_LARGE');
  if ((await QuotationDocument.countDocuments({ companyId, quotationId: q._id })) >= MAX_DOCS) throw AppError.conflict(`${MAX_DOCS} documents maximum par devis`);
  await assertVersion(q, meta.version);
  const f = inspect(file);
  const fileId = await putFile(companyId, q._id, f.name, f.mime, file.buffer, QUOTATION_BUCKET);
  try {
    const d = await QuotationDocument.create({ companyId, quotationId: q._id, type: meta.type, ...(meta.description && { description: meta.description }), ...(meta.version && { version: meta.version }), originalName: f.name, fileId, mime: f.mime, size: file.buffer.length, uploadedBy: actor.userId, uploadedByName: actor.name });
    await activity.record(companyId, q._id, [{ kind: 'document_added', description: `${QUOTATION_DOC_LABEL[meta.type]} : ${f.name}`, eventKey: `doc:${d._id}` }], actor);
    return docDto(q, await frozenVersions(q))(d.toObject());
  } catch (e) { await deleteFile(fileId, QUOTATION_BUCKET); throw e; }
}
async function ownDoc(companyId: Id, id: string, docId: string) {
  const q = await getOwn(companyId, id);
  const doc = await QuotationDocument.findOne({ _id: docId, companyId, quotationId: q._id }).lean();
  if (!doc) throw AppError.notFound('Document introuvable');
  return { q, doc };
}
export async function updateDocument(companyId: Id, id: string, docId: string, patch: Partial<Meta>, actor: Actor) {
  const { q, doc } = await ownDoc(companyId, id, docId); const frozen = await frozenVersions(q);
  // Description et type restent corrigeables ; le rattachement d'une pièce conservée ne change pas
  if (patch.version !== undefined && patch.version !== doc.version) { const why = lockReason(q, frozen, doc); if (why) throw AppError.conflict(why); await assertVersion(q, patch.version); }
  const u = await QuotationDocument.findOneAndUpdate({ _id: docId, companyId }, { $set: patch }, { returnDocument: 'after', runValidators: true }).lean();
  await activity.record(companyId, q._id, [{ kind: 'document_updated', description: doc.originalName }], actor);
  return docDto(q, frozen)(u!);
}
export async function removeDocument(companyId: Id, id: string, docId: string, actor: Actor) {
  const { q, doc } = await ownDoc(companyId, id, docId);
  const why = lockReason(q, await frozenVersions(q), doc); if (why) throw AppError.conflict(why);
  await QuotationDocument.deleteOne({ _id: docId, companyId });
  await deleteFile(doc.fileId, QUOTATION_BUCKET);
  await activity.record(companyId, q._id, [{ kind: 'document_removed', description: `${QUOTATION_DOC_LABEL[doc.type]} : ${doc.originalName}` }], actor);
  return doc;
}
export async function documentStream(companyId: Id, id: string, docId: string) {
  const { doc } = await ownDoc(companyId, id, docId);
  return { doc, stream: openFile(doc.fileId, QUOTATION_BUCKET), inline: /^(application\/pdf|image\/(png|jpeg|webp))$/.test(doc.mime ?? '') };
}

// ---------- Commentaires internes (jamais repris dans un PDF, un e-mail ou un document externe) ----------
export interface Who extends Actor { moderator: boolean; canWrite: boolean }
type C = { _id: Id; body: string; authorId?: Id | null; authorName?: string | null; createdAt?: Date; editedAt?: Date | null; editedByName?: string | null; archivedAt?: Date | null; archivedByName?: string | null };
const commentDto = (who: Who) => (c: C) => {
  const own = !!who.userId && String(c.authorId) === String(who.userId); const allowed = !c.archivedAt && (who.moderator || (own && who.canWrite));
  return { id: c._id.toString(), body: c.archivedAt ? null : c.body, author: c.authorName ?? null, createdAt: c.createdAt, editedAt: c.editedAt ?? null, editedBy: c.editedByName ?? null,
    archivedAt: c.archivedAt ?? null, archivedBy: c.archivedByName ?? null, canEdit: allowed, canArchive: allowed };
};
export async function listComments(companyId: Id, id: string, who: Who) {
  const q = await getOwn(companyId, id);
  return { items: (await QuotationComment.find({ companyId, quotationId: q._id }).sort({ createdAt: -1, _id: -1 }).limit(200).lean()).map(commentDto(who)) };
}
export async function addComment(companyId: Id, id: string, body: string, who: Who) {
  const q = await getOwn(companyId, id);
  const c = await QuotationComment.create({ companyId, quotationId: q._id, body, authorId: who.userId, authorName: who.name });
  await activity.record(companyId, q._id, [{ kind: 'comment_added', eventKey: `comment:${c._id}` }], who);
  return commentDto(who)(c.toObject());
}
async function ownComment(companyId: Id, id: string, commentId: string, who: Who) {
  const q = await getOwn(companyId, id);
  const c = await QuotationComment.findOne({ _id: commentId, companyId, quotationId: q._id }).lean();
  if (!c) throw AppError.notFound('Commentaire introuvable');
  if (c.archivedAt) throw AppError.conflict('Commentaire archivé');
  if (!commentDto(who)(c).canEdit) throw AppError.forbidden('Seul l’auteur (ou un responsable autorisé à supprimer les devis) peut modifier ce commentaire');
  return { q, c };
}
export async function editComment(companyId: Id, id: string, commentId: string, body: string, who: Who) {
  const { q, c } = await ownComment(companyId, id, commentId, who);
  if (c.body === body) return commentDto(who)(c);
  const u = await QuotationComment.findOneAndUpdate({ _id: commentId, companyId }, { $set: { body, editedAt: new Date(), editedByName: who.name } }, { returnDocument: 'after' }).lean();
  await activity.record(companyId, q._id, [{ kind: 'comment_edited' }], who);
  return commentDto(who)(u!);
}
export async function archiveComment(companyId: Id, id: string, commentId: string, who: Who) {
  const { q } = await ownComment(companyId, id, commentId, who);
  const u = await QuotationComment.findOneAndUpdate({ _id: commentId, companyId }, { $set: { archivedAt: new Date(), archivedByName: who.name } }, { returnDocument: 'after' }).lean();
  await activity.record(companyId, q._id, [{ kind: 'comment_archived' }], who);
  return commentDto(who)(u!);
}
