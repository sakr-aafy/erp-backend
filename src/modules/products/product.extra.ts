import type { Types } from 'mongoose';
import { CostHistory, ImportFile, PurchaseInvoice, StockMovement } from '../../models/logistics.model.js';
import { PRODUCT_ACTIVITY_KINDS, Product, ProductActivity, ProductDocument } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile, inspect, MAX_DOC_BYTES, openFile, PRODUCT_BUCKET, putFile } from '../customers/customer.files.js';
import { effectiveStatus, getOwn, logProductAuto, type Access, type Actor } from './product.service.js';

type Id = Types.ObjectId;
type Perms = ReadonlySet<string>;
export const DOC_TYPE_LABEL: Record<string, string> = {
  photo: 'Photo de l’article', supplier_invoice: 'Facture fournisseur', datasheet: 'Fiche technique', manual: 'Manuel d’utilisation', ce_certificate: 'Certificat CE',
  origin_certificate: 'Certificat d’origine', conformity: 'Déclaration de conformité', customs: 'Document douanier', warranty: 'Document de garantie', other: 'Autre fichier',
};
const MAX_DOCS = 100; const IMAGE = /^image\/(png|jpeg|webp)$/;

// ---------- Documents ----------
const docDto = (d: { _id: Id; type: string; description?: string | null; originalName: string; mime?: string | null; size?: number | null; uploadedByName?: string | null; createdAt?: Date }, mainId: string | null) => ({
  id: d._id.toString(), type: d.type, typeLabel: DOC_TYPE_LABEL[d.type] ?? d.type, description: d.description ?? null, name: d.originalName, mime: d.mime ?? null, size: d.size ?? 0,
  uploadedBy: d.uploadedByName ?? null, uploadedAt: d.createdAt, isImage: IMAGE.test(d.mime ?? ''), isMain: mainId === d._id.toString(),
});

/** Documents propres à l'article + liens vers les documents des modules sources (factures d'achat, dossiers d'importation) : jamais de copie de fichier. */
export async function listDocuments(companyId: Id, productId: string, perms: Perms) {
  const p = await getOwn(companyId, productId); const main = p.mainPhotoId?.toString() ?? null;
  const own = (await ProductDocument.find({ companyId, productId: p._id }).sort({ createdAt: -1 }).lean()).map((d) => docDto(d, main));
  const linked: { kind: string; typeLabel: string; name: string; subtitle: string | null; webPath: string }[] = [];
  if (perms.has('purchases:view')) {
    for (const i of await PurchaseInvoice.find({ companyId, 'lines.productId': p._id }).sort({ invoiceDate: -1 }).limit(30).select('number supplierInvoiceNumber supplier invoiceDate status').lean())
      linked.push({ kind: 'supplier_invoice', typeLabel: DOC_TYPE_LABEL['supplier_invoice']!, name: `Facture d’achat ${i.number ?? i.supplierInvoiceNumber}`, subtitle: [i.supplier?.name, i.supplierInvoiceNumber ? `n° fournisseur ${i.supplierInvoiceNumber}` : null].filter(Boolean).join(' · ') || null, webPath: `/purchase-invoices/${i._id}` });
  }
  if (perms.has('imports:view')) {
    for (const f of await ImportFile.find({ companyId, 'lines.productId': p._id }).sort({ orderDate: -1 }).limit(30).select('number supplier documents').lean())
      for (const d of f.documents ?? []) linked.push({ kind: 'customs', typeLabel: DOC_TYPE_LABEL['customs']!, name: `${d.name} (dossier ${f.number})`, subtitle: [f.supplier?.name, d.kind].filter(Boolean).join(' · ') || null, webPath: `/imports/${f._id}` });
  }
  return { items: own, linked, mainPhotoId: main };
}
export async function addDocument(companyId: Id, productId: string, file: { originalname: string; buffer: Buffer; size: number }, meta: { type: string; description?: string | undefined }, actor: Actor) {
  const p = await getOwn(companyId, productId);
  if (effectiveStatus(p) === 'archived') throw AppError.conflict('Article archivé : réactivez-le avant d’ajouter un document');
  if (file.size > MAX_DOC_BYTES) throw new AppError(413, 'Fichier trop volumineux (10 Mo maximum)', 'PAYLOAD_TOO_LARGE');
  if ((await ProductDocument.countDocuments({ companyId, productId: p._id })) >= MAX_DOCS) throw AppError.conflict(`${MAX_DOCS} documents maximum par article`);
  const f = inspect(file);
  if (meta.type === 'photo' && !IMAGE.test(f.mime)) throw AppError.badRequest('Une photo doit être une image (PNG, JPG ou WEBP)');
  const fileId = await putFile(companyId, p._id, f.name, f.mime, file.buffer, PRODUCT_BUCKET);
  try {
    const doc = await ProductDocument.create({ companyId, productId: p._id, type: meta.type as never, ...(meta.description && { description: meta.description }), originalName: f.name, fileId, mime: f.mime, size: file.buffer.length, uploadedBy: actor.userId, uploadedByName: actor.name });
    if (meta.type === 'photo' && !p.mainPhotoId) await Product.updateOne({ _id: p._id, companyId }, { mainPhotoId: doc._id }); // la première photo devient la photo principale
    await logProductAuto(companyId, p._id, 'document_added', `Document ajouté : ${DOC_TYPE_LABEL[meta.type] ?? meta.type} (${f.name})`, actor, { documentId: doc._id.toString() });
    return docDto(doc.toObject(), (p.mainPhotoId ?? (meta.type === 'photo' ? doc._id : null))?.toString() ?? null);
  } catch (e) { await deleteFile(fileId, PRODUCT_BUCKET); throw e; }
}
async function ownDoc(companyId: Id, productId: string, docId: string) {
  const p = await getOwn(companyId, productId);
  const d = await ProductDocument.findOne({ _id: docId, companyId, productId: p._id }).lean();
  if (!d) throw AppError.notFound('Document introuvable');
  return { p, d };
}
export async function updateDocument(companyId: Id, productId: string, docId: string, patch: { type?: string | undefined; description?: string | undefined }) {
  const { p, d } = await ownDoc(companyId, productId, docId);
  if (patch.type && patch.type === 'photo' && !IMAGE.test(d.mime ?? '')) throw AppError.badRequest('Seule une image peut être classée comme photo');
  const $set: Record<string, unknown> = {}; if (patch.type) $set.type = patch.type; if (patch.description !== undefined) $set.description = patch.description;
  const u = await ProductDocument.findOneAndUpdate({ _id: docId, companyId }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  if (patch.type && patch.type !== 'photo' && p.mainPhotoId?.toString() === docId) await Product.updateOne({ _id: p._id, companyId }, { $unset: { mainPhotoId: 1 } });
  return docDto(u!, (await Product.findById(p._id).select('mainPhotoId').lean())?.mainPhotoId?.toString() ?? null);
}
export async function setMainPhoto(companyId: Id, productId: string, docId: string) {
  const { p, d } = await ownDoc(companyId, productId, docId);
  if (d.type !== 'photo' || !IMAGE.test(d.mime ?? '')) throw AppError.badRequest('Seule une photo peut devenir photo principale');
  await Product.updateOne({ _id: p._id, companyId }, { mainPhotoId: d._id });
  return { mainPhotoId: d._id.toString() };
}
export async function removeDocument(companyId: Id, productId: string, docId: string, actor: Actor) {
  const { p, d } = await ownDoc(companyId, productId, docId);
  await ProductDocument.deleteOne({ _id: docId, companyId }); await deleteFile(d.fileId, PRODUCT_BUCKET);
  if (p.mainPhotoId?.toString() === docId) { // la photo principale supprimée est remplacée par la photo la plus récente (ou aucune)
    const next = await ProductDocument.findOne({ companyId, productId: p._id, type: 'photo' }).sort({ createdAt: -1 }).lean();
    await Product.updateOne({ _id: p._id, companyId }, next ? { mainPhotoId: next._id } : { $unset: { mainPhotoId: 1 } });
  }
  await logProductAuto(companyId, p._id, 'document_removed', `Document supprimé : ${d.originalName}`, actor);
  return d;
}
export async function documentStream(companyId: Id, productId: string, docId: string) {
  const { d } = await ownDoc(companyId, productId, docId);
  return { doc: d, stream: openFile(d.fileId, PRODUCT_BUCKET), inline: /^(application\/pdf|image\/(png|jpeg|webp))$/.test(d.mime ?? '') };
}
/** Photo principale (miniatures et en-tête) : image seulement, jamais un autre type de fichier. */
export async function mainPhotoStream(companyId: Id, productId: string) {
  const p = await getOwn(companyId, productId); if (!p.mainPhotoId) throw AppError.notFound('Aucune photo');
  const d = await ProductDocument.findOne({ _id: p.mainPhotoId, companyId, productId: p._id }).lean(); if (!d || !IMAGE.test(d.mime ?? '')) throw AppError.notFound('Aucune photo');
  return { doc: d, stream: openFile(d.fileId, PRODUCT_BUCKET) };
}

// ---------- Activités ----------
export const KIND_LABEL: Record<string, string> = {
  call: 'Appel téléphonique', meeting: 'Réunion', task: 'Tâche à effectuer', reminder: 'Rappel de suivi', note: 'Note interne',
  product_created: 'Article créé', product_updated: 'Article modifié', purchase_price_changed: 'Prix d’achat modifié', sale_price_changed: 'Prix de vente modifié', technical_changed: 'Informations modifiées', status_changed: 'Changement de statut',
  document_added: 'Document ajouté', document_removed: 'Document supprimé', stock_setting_changed: 'Réglages de stock modifiés', cost_changed: 'Coût de revient modifié', goods_received: 'Réception de marchandises', stock_transfer: 'Transfert entre entrepôts', stock_changed: 'Changement de stock',
};
export interface ActivityRow { id: string; auto: boolean; derived: boolean; editable: boolean; kind: string; kindLabel: string; title: string; description: string | null; occurredAt: Date; dueDate: Date | null; done: boolean | null; overdue: boolean; user: string | null; link: string | null; meta?: unknown }

const dto = (a: { _id: Id; auto?: boolean | null; kind: string; title: string; description?: string | null; occurredAt: Date; dueDate?: Date | null; done?: boolean | null; userName?: string | null; meta?: unknown }): ActivityRow => ({
  id: a._id.toString(), auto: !!a.auto, derived: false, editable: !a.auto, kind: a.kind, kindLabel: KIND_LABEL[a.kind] ?? a.kind, title: a.title, description: a.description ?? null, occurredAt: a.occurredAt,
  dueDate: a.dueDate ?? null, done: a.done ?? null, overdue: !!a.dueDate && !a.done && new Date(a.dueDate) < new Date(), user: a.userName ?? null, link: null, ...(a.auto && a.meta ? { meta: a.meta } : {}),
});

/**
 * Chronologie : activités manuelles + événements automatiques de la fiche (collection dédiée, distincte du journal d'audit)
 * + événements lus à la volée dans les modules sources (mouvements de stock, réceptions, coût de revient) — donc jamais dupliqués ni modifiables.
 * Les montants d'achat n'apparaissent qu'avec la permission correspondante.
 */
export async function listActivities(companyId: Id, productId: string, perms: Perms, access: Access, q: { page: number; limit: number; kind?: string | undefined; from?: Date | undefined; to?: Date | undefined; open?: boolean | undefined }) {
  const p = await getOwn(companyId, productId); const take = q.page * q.limit + 50;
  const dateF = q.from || q.to ? { occurredAt: { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) } } : {};
  const hidden = [...(access.purchase ? [] : ['purchase_price_changed'])];
  const storedFilter: Record<string, unknown> = { companyId, productId: p._id, ...dateF, ...(hidden.length && { kind: { $nin: hidden } }), ...(q.open && { kind: { $in: ['task', 'reminder'] }, done: { $ne: true } }) };
  if (q.kind) storedFilter.kind = q.open ? { $in: [q.kind] } : (hidden.includes(q.kind) ? '__none__' : q.kind);
  const stored = await ProductActivity.find(storedFilter).sort({ occurredAt: -1 }).limit(take).lean();
  const derived: ActivityRow[] = []; const range = (k: string) => (q.from || q.to ? { [k]: { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) } } : {});
  const want = (k: string) => !q.open && (!q.kind || q.kind === k);
  const add = (kind: string, id: Id, at: Date, title: string, description: string | null, link: string | null, meta?: Record<string, number | null>) => derived.push({ id: `${kind}:${id}`, auto: true, derived: true, editable: false, kind, kindLabel: KIND_LABEL[kind]!, title, description, occurredAt: at, dueDate: null, done: null, overdue: false, user: null, link, ...(meta && { meta }) });
  if (perms.has('inventory:view') && (want('goods_received') || want('stock_transfer') || want('stock_changed'))) {
    for (const m of await StockMovement.find({ companyId, productId: p._id, ...range('createdAt') }).sort({ createdAt: -1 }).limit(take).lean()) {
      const at = (m as unknown as { createdAt: Date }).createdAt; const sign = m.direction === 'in' ? '+' : '−';
      if (m.reason === 'receipt' || m.reason === 'import') { if (want('goods_received')) add('goods_received', m._id, at, `Réception de marchandises${m.source?.number ? ` ${m.source.number}` : ''}`, `${m.quantity} unité(s) réceptionnée(s)`, '/stock/movements'); }
      else if (m.reason === 'transfer_out' || m.reason === 'transfer_in') { if (want('stock_transfer') && m.reason === 'transfer_out') add('stock_transfer', m._id, at, `Transfert entre entrepôts${m.source?.number ? ` ${m.source.number}` : ''}`, `${m.quantity} unité(s)`, '/stock/movements'); }
      else if (want('stock_changed')) add('stock_changed', m._id, at, `Changement de stock : ${sign}${m.quantity}`, m.note ?? null, '/stock/movements');
    }
  }
  if (perms.has('costCalculation:view') && want('cost_changed')) {
    for (const c of await CostHistory.find({ companyId, productId: p._id, ...range('at') }).sort({ at: -1 }).limit(take).lean()) add('cost_changed', c._id, c.at, 'Coût de revient modifié', null, '/costs', access.cost ? { costFrom: c.previousCostMinor ?? null, costTo: c.newCostMinor } : undefined);
  }
  const all = [...stored.map((a) => dto(a as never)), ...derived].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
  return { items: all.slice((q.page - 1) * q.limit, q.page * q.limit), total: all.length < take ? all.length : (await ProductActivity.countDocuments(storedFilter)) + derived.length, page: q.page, limit: q.limit };
}

export async function addActivity(companyId: Id, productId: string, d: { kind: (typeof PRODUCT_ACTIVITY_KINDS)[number]; title: string; description?: string | undefined; occurredAt?: Date | undefined; dueDate?: Date | null | undefined }, actor: Actor) {
  const p = await getOwn(companyId, productId);
  if (d.dueDate && !['task', 'reminder'].includes(d.kind)) throw AppError.badRequest('Une échéance ne concerne que les tâches et les rappels');
  const a = await ProductActivity.create({ companyId, productId: p._id, auto: false, kind: d.kind as never, title: d.title, ...(d.description && { description: d.description }), occurredAt: d.occurredAt ?? new Date(),
    ...(d.dueDate && { dueDate: d.dueDate }), ...(['task', 'reminder'].includes(d.kind) && { done: false }), userId: actor.userId, userName: actor.name });
  return dto(a.toObject());
}
async function manualOwn(companyId: Id, productId: string, activityId: string) {
  const p = await getOwn(companyId, productId);
  const a = await ProductActivity.findOne({ _id: activityId, companyId, productId: p._id }).lean();
  if (!a) throw AppError.notFound('Activité introuvable');
  if (a.auto) throw AppError.conflict('Un événement automatique ne peut pas être modifié ni supprimé');
  return a;
}
export async function updateActivity(companyId: Id, productId: string, activityId: string, patch: { kind?: string | undefined; title?: string | undefined; description?: string | undefined; occurredAt?: Date | undefined; dueDate?: Date | null | undefined; done?: boolean | undefined }) {
  const cur = await manualOwn(companyId, productId, activityId);
  const kind = patch.kind ?? cur.kind; const task = ['task', 'reminder'].includes(kind);
  if ((patch.dueDate || patch.done !== undefined) && !task) throw AppError.badRequest('Échéance et réalisation ne concernent que les tâches et les rappels');
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(patch)) { if (k === 'dueDate') { if (v) $set.dueDate = v; else $unset.dueDate = 1; } else if (k === 'done') { $set.done = v; if (v) $set.doneAt = new Date(); else $unset.doneAt = 1; } else if (v !== undefined) $set[k] = v; }
  if (task && cur.done == null && patch.done === undefined) $set.done = false;
  const a = await ProductActivity.findOneAndUpdate({ _id: activityId, companyId, auto: false }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true }).lean();
  return dto(a!);
}
export async function removeActivity(companyId: Id, productId: string, activityId: string) {
  await manualOwn(companyId, productId, activityId);
  await ProductActivity.deleteOne({ _id: activityId, companyId, auto: false });
}
