import type { Types } from 'mongoose';
import { SupplierActivity, SupplierDocument, SUPPLIER_ACTIVITY_KINDS } from '../../models/supplier.model.js';
import { GoodsReceipt, ImportFile, PurchaseInvoice, PurchaseOrder } from '../../models/logistics.model.js';
import { SupplierPayment } from '../../models/finance.model.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile, inspect, MAX_DOC_BYTES, openFile, putFile, SUPPLIER_BUCKET } from '../customers/customer.files.js';
import { effectiveStatus, getOwn, logAuto, type Actor } from './supplier.service.js';

type Id = Types.ObjectId;
type Perms = ReadonlySet<string>;
export const SUPPLIER_DOC_LABEL: Record<string, string> = {
  administrative: 'Document administratif', tax_card: 'Carte d’identification fiscale', contract: 'Contrat fournisseur', catalog: 'Catalogue', price_list: 'Tarif fournisseur',
  conformity_certificate: 'Certificat de conformité', origin_certificate: 'Certificat d’origine', insurance: 'Document d’assurance', transport: 'Document de transport', customs: 'Document douanier', other: 'Autre document',
};
const MAX_DOCS = 50;

// ---------- Documents ----------
const docDto = (d: { _id: Id; type: string; description?: string | null; originalName: string; mime?: string | null; size?: number | null; uploadedByName?: string | null; createdAt?: Date }) => ({
  id: d._id.toString(), type: d.type, typeLabel: SUPPLIER_DOC_LABEL[d.type] ?? d.type, description: d.description ?? null, name: d.originalName, mime: d.mime ?? null, size: d.size ?? 0,
  uploadedBy: d.uploadedByName ?? null, uploadedAt: d.createdAt,
});

/** Documents de la fiche + liens vers les pièces des dossiers d'importation (lues à la source, jamais copiées). */
export async function listDocuments(companyId: Id, supplierId: string, perms: Perms) {
  const s = await getOwn(companyId, supplierId);
  const items = (await SupplierDocument.find({ companyId, supplierId: s._id }).sort({ createdAt: -1 }).lean()).map(docDto);
  const files = perms.has('imports:view') ? await ImportFile.find({ companyId, supplierId: s._id, 'documents.0': { $exists: true } }).sort({ orderDate: -1 }).limit(50).select('number documents').lean() : [];
  const linked = files.flatMap((f) => (f.documents ?? []).map((d) => ({ importId: f._id.toString(), importNumber: f.number, name: d.name, received: d.status === 'received', fileName: d.fileName ?? null })));
  return { items, linked };
}
const readOnly = (s: { status?: string | null; isArchived?: boolean | null }, what: string) => { if (effectiveStatus(s) === 'archived') throw AppError.conflict(`Fournisseur archivé : réactivez-le avant ${what}`); };
export async function addDocument(companyId: Id, supplierId: string, file: { originalname: string; buffer: Buffer; size: number }, meta: { type: string; description?: string | undefined }, actor: Actor) {
  const s = await getOwn(companyId, supplierId); readOnly(s, 'd’ajouter un document');
  if (file.size > MAX_DOC_BYTES) throw new AppError(413, 'Fichier trop volumineux (10 Mo maximum)', 'PAYLOAD_TOO_LARGE');
  if ((await SupplierDocument.countDocuments({ companyId, supplierId: s._id })) >= MAX_DOCS) throw AppError.conflict(`${MAX_DOCS} documents maximum par fournisseur`);
  const f = inspect(file);
  const fileId = await putFile(companyId, s._id, f.name, f.mime, file.buffer, SUPPLIER_BUCKET);
  try {
    const doc = await SupplierDocument.create({ companyId, supplierId: s._id, type: meta.type as never, ...(meta.description && { description: meta.description }), originalName: f.name, fileId, mime: f.mime, size: file.buffer.length, uploadedBy: actor.userId, uploadedByName: actor.name });
    await logAuto(companyId, s._id, 'document_added', `Document ajouté : ${SUPPLIER_DOC_LABEL[meta.type] ?? meta.type} (${f.name})`, actor, { documentId: doc._id.toString() });
    return docDto(doc.toObject());
  } catch (e) { await deleteFile(fileId, SUPPLIER_BUCKET); throw e; }
}
async function ownDoc(companyId: Id, supplierId: string, docId: string) {
  const s = await getOwn(companyId, supplierId); // vérifie l'appartenance du fournisseur à la société
  const d = await SupplierDocument.findOne({ _id: docId, companyId, supplierId: s._id }).lean();
  if (!d) throw AppError.notFound('Document introuvable');
  return { supplier: s, doc: d };
}
export async function updateDocument(companyId: Id, supplierId: string, docId: string, patch: { type?: string | undefined; description?: string | undefined }) {
  const { supplier } = await ownDoc(companyId, supplierId, docId); readOnly(supplier, 'de modifier ses documents');
  const $set: Record<string, unknown> = {}; if (patch.type) $set.type = patch.type; if (patch.description !== undefined) $set.description = patch.description;
  const d = await SupplierDocument.findOneAndUpdate({ _id: docId, companyId, supplierId }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  return docDto(d!);
}
export async function removeDocument(companyId: Id, supplierId: string, docId: string, actor: Actor) {
  const { supplier, doc } = await ownDoc(companyId, supplierId, docId); readOnly(supplier, 'de supprimer un document');
  await SupplierDocument.deleteOne({ _id: docId, companyId });
  await deleteFile(doc.fileId, SUPPLIER_BUCKET);
  await logAuto(companyId, supplierId, 'document_removed', `Document supprimé : ${doc.originalName}`, actor);
  return doc;
}
/** Consultation et téléchargement : toujours possibles, y compris pour un fournisseur archivé. */
export async function documentStream(companyId: Id, supplierId: string, docId: string) {
  const { doc } = await ownDoc(companyId, supplierId, docId);
  return { doc, stream: openFile(doc.fileId, SUPPLIER_BUCKET), inline: /^(application\/pdf|image\/(png|jpeg))$/.test(doc.mime ?? '') };
}

// ---------- Activités ----------
export const SUPPLIER_KIND_LABEL: Record<string, string> = {
  call: 'Appel téléphonique', email: 'E-mail', meeting: 'Réunion', note: 'Note interne', task: 'Tâche', reminder: 'Rappel', follow_up: 'Suivi fournisseur',
  supplier_created: 'Fournisseur créé', supplier_updated: 'Fournisseur modifié', category_changed: 'Catégorie modifiée', status_changed: 'Changement de statut', document_added: 'Document ajouté', document_removed: 'Document supprimé',
  order_created: 'Commande créée', order_confirmed: 'Commande confirmée', receipt_validated: 'Réception validée', purchase_invoice_validated: 'Facture d’achat validée', payment_recorded: 'Règlement enregistré', import_created: 'Dossier d’importation créé',
};
export interface ActivityRow { id: string; auto: boolean; derived: boolean; editable: boolean; kind: string; kindLabel: string; title: string; description: string | null; occurredAt: Date; user: string | null; ref?: { type: string; id: string; number: string | null } }
const actDto = (a: { _id: Id; auto?: boolean | null; kind: string; title: string; description?: string | null; occurredAt: Date; userName?: string | null }): ActivityRow => ({
  id: a._id.toString(), auto: !!a.auto, derived: false, editable: !a.auto, kind: a.kind, kindLabel: SUPPLIER_KIND_LABEL[a.kind] ?? a.kind, title: a.title, description: a.description ?? null, occurredAt: a.occurredAt, user: a.userName ?? null,
});

/** Source d'événements lue dans les documents réels : un événement par document et par étape, donc jamais dupliqué ni modifiable. */
interface Source { kind: string; permission: string; model: { find: (f: object) => { sort: (s: object) => { limit: (n: number) => { select: (s: string) => { lean: () => Promise<Record<string, unknown>[]> } } } }; countDocuments: (f: object) => Promise<number> }; filter: object; at: string; type: string; title: (n: string) => string }
const src = (kind: string, permission: string, model: unknown, filter: object, at: string, type: string, title: (n: string) => string): Source => ({ kind, permission, model: model as Source['model'], filter, at, type, title });
const SOURCES: Source[] = [
  src('order_created', 'purchases:view', PurchaseOrder, {}, 'createdAt', 'purchase_order', (x) => `Commande créée : ${x}`),
  src('order_confirmed', 'purchases:view', PurchaseOrder, { confirmedAt: { $ne: null } }, 'confirmedAt', 'purchase_order', (x) => `Commande confirmée : ${x}`),
  src('receipt_validated', 'purchases:view', GoodsReceipt, { status: 'validated' }, 'validatedAt', 'goods_receipt', (x) => `Réception validée : ${x}`),
  src('purchase_invoice_validated', 'purchases:view', PurchaseInvoice, { status: 'validated' }, 'validatedAt', 'purchase_invoice', (x) => `Facture d’achat validée : ${x}`),
  src('payment_recorded', 'treasury:view', SupplierPayment, { status: 'active' }, 'paidAt', 'supplier_payment', (x) => `Règlement enregistré : ${x}`),
  src('import_created', 'imports:view', ImportFile, {}, 'createdAt', 'import_file', (x) => `Dossier d’importation créé : ${x}`),
];

/** Chronologie : activités manuelles + événements de la fiche (collection dédiée, distincte du journal d'audit) + événements des documents réels. */
export async function listActivities(companyId: Id, supplierId: string, perms: Perms, q: { page: number; limit: number; kind?: string | undefined }) {
  const s = await getOwn(companyId, supplierId); const take = q.page * q.limit;
  const own = { companyId, supplierId: s._id, ...(q.kind && { kind: q.kind as never }) };
  const sources = SOURCES.filter((x) => perms.has(x.permission) && (!q.kind || q.kind === x.kind));
  const [stored, storedCount, parts] = await Promise.all([
    SupplierActivity.find(own).sort({ occurredAt: -1, _id: -1 }).limit(take).lean(),
    SupplierActivity.countDocuments(own),
    Promise.all(sources.map(async (x) => {
      const filter = { companyId, supplierId: s._id, ...x.filter };
      const [docs, total] = await Promise.all([x.model.find(filter).sort({ [x.at]: -1 }).limit(take).select(`number ${x.at}`).lean(), x.model.countDocuments(filter)]);
      const items = docs.map((d): ActivityRow => {
        const id = String(d['_id']); const number = (d['number'] as string | undefined) ?? null;
        return { id: `${x.kind}:${id}`, auto: true, derived: true, editable: false, kind: x.kind, kindLabel: SUPPLIER_KIND_LABEL[x.kind]!, title: x.title(number ?? '(sans numéro)'), description: null, occurredAt: d[x.at] as Date, user: null, ref: { type: x.type, id, number } };
      });
      return { items, total };
    })),
  ]);
  const all = [...stored.map((a) => actDto(a as never)), ...parts.flatMap((p) => p.items)].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
  return { items: all.slice((q.page - 1) * q.limit, take), total: storedCount + parts.reduce((n, p) => n + p.total, 0), page: q.page, limit: q.limit };
}

export async function addActivity(companyId: Id, supplierId: string, d: { kind: (typeof SUPPLIER_ACTIVITY_KINDS)[number]; title: string; description?: string | undefined; occurredAt?: Date | undefined }, actor: Actor) {
  const s = await getOwn(companyId, supplierId); readOnly(s, 'd’ajouter une activité');
  const a = await SupplierActivity.create({ companyId, supplierId: s._id, auto: false, kind: d.kind as never, title: d.title, ...(d.description && { description: d.description }), occurredAt: d.occurredAt ?? new Date(), userId: actor.userId, userName: actor.name });
  return actDto(a.toObject());
}
async function manualOwn(companyId: Id, supplierId: string, activityId: string) {
  const s = await getOwn(companyId, supplierId);
  const a = await SupplierActivity.findOne({ _id: activityId, companyId, supplierId: s._id }).lean();
  if (!a) throw AppError.notFound('Activité introuvable');
  if (a.auto) throw AppError.conflict('Un événement automatique ne peut pas être modifié ni supprimé');
  readOnly(s, 'de modifier ses activités');
}
export async function updateActivity(companyId: Id, supplierId: string, activityId: string, patch: { kind?: string | undefined; title?: string | undefined; description?: string | undefined; occurredAt?: Date | undefined }) {
  await manualOwn(companyId, supplierId, activityId);
  const $set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const a = await SupplierActivity.findOneAndUpdate({ _id: activityId, companyId, auto: false }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  return actDto(a!);
}
export async function removeActivity(companyId: Id, supplierId: string, activityId: string) {
  await manualOwn(companyId, supplierId, activityId);
  await SupplierActivity.deleteOne({ _id: activityId, companyId, auto: false });
}
