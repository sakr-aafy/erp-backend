import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { AppError } from '../../utils/errors.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, type ExportFormat } from '../../services/export.service.js';
import * as c from './supplier.controller.js';
import { actor, cid, decimalsOf, perms, pid, send } from './supplier.controller.js';
import * as svc from './supplier.service.js';
import * as detail from './supplier.detail.service.js';
import * as extra from './supplier.extra.service.js';
import * as categories from './supplier.categories.js';
import * as v from './supplier.validator.js';
import { MAX_DOC_BYTES } from '../customers/customer.files.js';
import { Supplier } from '../../models/supplier.model.js';
import { GoodsReceipt, PurchaseOrder } from '../../models/logistics.model.js';
import { mountDeliveryAddresses } from '../parties/delivery-address.routes.js';

export const supplierRoutes = Router();
supplierRoutes.use(authenticate);

/** Montants et situation financière : au moins une permission Achats, Trésorerie ou Comptabilité. */
const canSeeAmounts: RequestHandler = (req, _res, next) => (svc.canSeeAmounts(perms(req)) ? next() : next(AppError.forbidden(`Permission requise : ${svc.FINANCE_PERMISSIONS.join(' ou ')}`)));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 5 } });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo maximum)' : 'Téléversement invalide', err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'));
  next(err);
});

// ---- Liste, création, fiche ----
supplierRoutes.get('/', can('suppliers:view'), validate({ query: v.listQuery }), h(c.list));
supplierRoutes.get('/export', can('suppliers:view'), validate({ query: v.exportQuery }), h(c.exportList));
supplierRoutes.get('/countries', can('suppliers:view'), h(async (req: Request, res: Response) => res.json(await svc.countries(cid(req)))));
supplierRoutes.post('/', can('suppliers:create'), validate({ body: v.createSupplierBody }), h(c.create));
supplierRoutes.get('/:id', can('suppliers:view'), validate({ params: v.idParam }), h(c.get));
supplierRoutes.get('/:id/pdf', can('suppliers:view'), validate({ params: v.idParam }), h(c.fichePdf));
supplierRoutes.put('/:id', can('suppliers:update'), validate({ params: v.idParam, body: v.updateSupplierBody }), h(c.update));
supplierRoutes.delete('/:id', can('suppliers:delete'), validate({ params: v.idParam }), h(c.remove));

// ---- Statut ----
supplierRoutes.post('/:id/status', can('suppliers:update'), validate({ params: v.idParam, body: v.statusBody }), h(c.setStatus));
supplierRoutes.post('/:id/archive', can('suppliers:update'), validate({ params: v.idParam }), h(c.archive));
supplierRoutes.post('/:id/reactivate', can('suppliers:update'), validate({ params: v.idParam }), h(c.reactivate));

// ---- Résumé / Transactions / Paiements (les données de chaque module exigent la permission de CE module) ----
supplierRoutes.get('/:id/summary', can('suppliers:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await detail.summary(cid(req), pid(req), perms(req)))));
supplierRoutes.get('/:id/transactions', can('suppliers:view'), validate({ params: v.idParam, query: v.transactionsQuery }), h(async (req: Request, res: Response) => res.json(await detail.transactions(cid(req), pid(req), perms(req), req.query as never))));
supplierRoutes.get('/:id/transactions/export', can('suppliers:view'), validate({ params: v.idParam, query: v.transactionsExportQuery }), h(async (req: Request, res: Response) => {
  const q = req.query as unknown as detail.TxQuery & { format: ExportFormat }; const d = await decimalsOf(req);
  const data = await detail.transactionsExport(cid(req), pid(req), perms(req), q);
  const m = (x: number | null, dec = d) => (x == null ? '' : (x / 10 ** dec).toFixed(dec));
  const out = await renderTable(q.format, 'transactions-fournisseur', `Transactions — ${data.supplier}`, `${data.rows.length} document(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, [
    { header: 'Date', key: 'date', width: 12, value: (r) => new Date(r.date).toISOString().slice(0, 10) },
    { header: 'Type', key: 'type', width: 22, value: (r) => detail.TX_LABEL[r.kind] },
    { header: 'Référence', key: 'number', width: 18, value: (r) => r.number ?? '(brouillon)' },
    { header: 'Réf. externe', key: 'ext', width: 18, value: (r) => r.externalRef },
    { header: 'Montant HT', key: 'ht', width: 14, align: 'right', value: (r) => m(r.totalHtMinor) },
    { header: 'Montant TTC', key: 'ttc', width: 14, align: 'right', value: (r) => m(r.totalTtcMinor) },
    { header: 'Devise', key: 'currency', width: 8, value: (r) => r.currency },
    { header: 'Montant en devise', key: 'foreign', width: 16, align: 'right', value: (r) => m(r.foreignMinor, 2) },
    { header: 'Statut', key: 'status', width: 16, value: (r) => r.paymentStatus ?? r.status },
  ], data.rows);
  await audit(req, { action: 'export', resource: 'supplier-transactions', resourceId: pid(req), meta: { format: q.format, count: data.rows.length } });
  send(res, out);
}));
supplierRoutes.get('/:id/payments', can('suppliers:view'), canSeeAmounts, validate({ params: v.idParam, query: v.paymentsQuery }), h(async (req: Request, res: Response) => res.json(await detail.payments(cid(req), pid(req), perms(req), req.query as never))));
supplierRoutes.get('/:id/payments/export', can('suppliers:view', 'treasury:view'), validate({ params: v.idParam, query: v.formatQuery }), h(async (req: Request, res: Response) => {
  const { format } = req.query as unknown as { format: ExportFormat }; const d = await decimalsOf(req);
  const data = await detail.paymentsExport(cid(req), pid(req)); const m = (x: number) => (x / 10 ** d).toFixed(d);
  const METHOD: Record<string, string> = { cash: 'Espèces', check: 'Chèque', transfer: 'Virement', card: 'Carte', draft: 'Traite', other: 'Autre' };
  const out = await renderTable(format, 'reglements-fournisseur', `Règlements — ${data.supplier}`, `Montants en ${data.currency} — édité le ${new Date().toLocaleDateString('fr-FR')}`, [
    { header: 'Date', key: 'date', width: 12, value: (r) => new Date(r.paidAt).toISOString().slice(0, 10) },
    { header: 'Règlement', key: 'number', width: 18, value: (r) => r.number },
    { header: 'Référence', key: 'ref', width: 18, value: (r) => r.reference },
    { header: 'Factures', key: 'inv', width: 30, value: (r) => r.invoices.map((i) => i.number).join(', ') },
    { header: 'Montant', key: 'amount', width: 14, align: 'right', value: (r) => m(r.amountMinor) },
    { header: 'Mode', key: 'method', width: 12, value: (r) => METHOD[r.method] ?? r.method },
    { header: 'Compte', key: 'account', width: 20, value: (r) => r.account },
    { header: 'Statut', key: 'status', width: 10, value: (r) => (r.status === 'cancelled' ? 'Annulé' : 'Réglé') },
  ], data.rows);
  await audit(req, { action: 'export', resource: 'supplier-payments', resourceId: pid(req), meta: { format, count: data.rows.length } });
  send(res, out);
}));
supplierRoutes.get('/:id/statement', can('suppliers:view', 'accounting:view'), validate({ params: v.idParam, query: v.formatQuery }), h(async (req: Request, res: Response) => {
  const st = await detail.statement(cid(req), pid(req)); const d = await decimalsOf(req); const m = (x: number) => (x / 10 ** d).toFixed(d);
  const { format } = req.query as unknown as { format: ExportFormat };
  const out = await renderTable(format, 'releve-fournisseur', `Relevé de compte — ${st.name}`, `Solde dû : ${m(st.balanceMinor)} — édité le ${new Date().toLocaleDateString('fr-FR')}`, [
    { header: 'Date', key: 'date', width: 12, value: (r) => new Date(r.date).toISOString().slice(0, 10) },
    { header: 'Facture', key: 'number', width: 18, value: (r) => r.number },
    { header: 'N° fournisseur', key: 'ext', width: 18, value: (r) => r.supplierInvoiceNumber },
    { header: 'Échéance', key: 'due', width: 12, value: (r) => (r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '') },
    { header: 'Montant', key: 'amount', width: 14, align: 'right', value: (r) => m(r.amountMinor) },
    { header: 'Réglé', key: 'paid', width: 14, align: 'right', value: (r) => m(r.paidMinor) },
    { header: 'Reste dû', key: 'remaining', width: 14, align: 'right', value: (r) => m(Math.max(0, r.amountMinor - r.paidMinor)) },
  ], st.documents);
  await audit(req, { action: 'export', resource: 'supplier-statement', resourceId: pid(req), meta: { format } });
  send(res, out);
}));

// ---- Contacts ----
supplierRoutes.post('/:id/contacts', can('suppliers:update'), validate({ params: v.idParam, body: v.contactBody }), h(async (req: Request, res: Response) => {
  const out = await svc.addContact(cid(req), pid(req), req.body, actor(req)); await audit(req, { action: 'contact-add', resource: 'supplier', resourceId: pid(req) }); res.status(201).json(svc.redact(out, perms(req)));
}));
supplierRoutes.put('/:id/contacts/:contactId', can('suppliers:update'), validate({ params: v.contactParams, body: v.contactBody.partial().strict() }), h(async (req: Request, res: Response) => {
  const out = await svc.updateContact(cid(req), pid(req), req.params.contactId as string, req.body, actor(req)); await audit(req, { action: 'contact-update', resource: 'supplier', resourceId: pid(req) }); res.json(svc.redact(out, perms(req)));
}));
supplierRoutes.post('/:id/contacts/:contactId/primary', can('suppliers:update'), validate({ params: v.contactParams }), h(async (req: Request, res: Response) => {
  const out = await svc.setPrimaryContact(cid(req), pid(req), req.params.contactId as string, actor(req)); await audit(req, { action: 'contact-primary', resource: 'supplier', resourceId: pid(req) }); res.json(svc.redact(out, perms(req)));
}));
supplierRoutes.delete('/:id/contacts/:contactId', can('suppliers:update'), validate({ params: v.contactParams }), h(async (req: Request, res: Response) => {
  const out = await svc.removeContact(cid(req), pid(req), req.params.contactId as string, actor(req)); await audit(req, { action: 'contact-remove', resource: 'supplier', resourceId: pid(req) }); res.json(svc.redact(out, perms(req)));
}));

// ---- Documents (fichiers dans MongoDB, jamais accessibles sans authentification ni hors de la société) ----
supplierRoutes.get('/:id/documents', can('suppliers:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await extra.listDocuments(cid(req), pid(req), perms(req)))));
supplierRoutes.post('/:id/documents', can('suppliers:update'), validate({ params: v.idParam }), uploadOne, validate({ body: v.docMetaBody }), h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier requis (champ « file »)');
  const d = await extra.addDocument(cid(req), pid(req), req.file, req.body, actor(req));
  await audit(req, { action: 'document-upload', resource: 'supplier', resourceId: pid(req), meta: { file: d.name, type: d.type, size: d.size } }); res.status(201).json(d);
}));
supplierRoutes.put('/:id/documents/:docId', can('suppliers:update'), validate({ params: v.docParams, body: v.docUpdateBody }), h(async (req: Request, res: Response) => {
  const d = await extra.updateDocument(cid(req), pid(req), req.params.docId as string, req.body); await audit(req, { action: 'document-update', resource: 'supplier', resourceId: pid(req), meta: { documentId: d.id } }); res.json(d);
}));
supplierRoutes.get('/:id/documents/:docId/file', can('suppliers:view'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const { doc, stream, inline } = await extra.documentStream(cid(req), pid(req), req.params.docId as string);
  const asInline = req.query.disposition === 'inline' && inline;
  res.setHeader('Content-Type', doc.mime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'no-store');
  if (doc.size) res.setHeader('Content-Length', String(doc.size));
  await audit(req, { action: 'document-download', resource: 'supplier', resourceId: pid(req), meta: { file: doc.originalName } });
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
}));
supplierRoutes.delete('/:id/documents/:docId', can('suppliers:update'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const d = await extra.removeDocument(cid(req), pid(req), req.params.docId as string, actor(req)); await audit(req, { action: 'document-delete', resource: 'supplier', resourceId: pid(req), meta: { file: d.originalName } }); res.status(204).end();
}));

// ---- Activités ----
supplierRoutes.get('/:id/activities', can('suppliers:view'), validate({ params: v.idParam, query: v.activitiesQuery }), h(async (req: Request, res: Response) => res.json(await extra.listActivities(cid(req), pid(req), perms(req), req.query as never))));
supplierRoutes.post('/:id/activities', can('suppliers:update'), validate({ params: v.idParam, body: v.activityBody }), h(async (req: Request, res: Response) => res.status(201).json(await extra.addActivity(cid(req), pid(req), req.body, actor(req)))));
supplierRoutes.put('/:id/activities/:activityId', can('suppliers:update'), validate({ params: v.activityParams, body: v.activityUpdateBody }), h(async (req: Request, res: Response) => res.json(await extra.updateActivity(cid(req), pid(req), req.params.activityId as string, req.body))));
supplierRoutes.delete('/:id/activities/:activityId', can('suppliers:update'), validate({ params: v.activityParams }), h(async (req: Request, res: Response) => { await extra.removeActivity(cid(req), pid(req), req.params.activityId as string); res.status(204).end(); }));

// ---- Adresses de livraison / d'enlèvement ----
mountDeliveryAddresses(supplierRoutes, {
  resource: 'supplier', permission: 'suppliers:update', model: Supplier, notFound: 'Fournisseur introuvable', dto: (companyId, id) => svc.get(companyId, id),
  view: (req, d) => svc.redact(d, perms(req)),
  readOnly: (s) => (svc.effectiveStatus(s) === 'archived' ? 'Fournisseur archivé : réactivez-le avant de modifier ses adresses' : null),
  onChange: (req, id, title) => svc.logAuto(cid(req), id, 'supplier_updated', title, actor(req)),
  isReferenced: async (companyId, addressId, supplierId) => {
    const q = { companyId, supplierId, 'supplierAddress.addressId': addressId };
    return !!(await PurchaseOrder.exists(q) || await GoodsReceipt.exists(q));
  },
});

// ---- Catégories de fournisseurs (mêmes permissions que le référentiel Fournisseurs) ----
export const supplierCategoryRoutes = Router();
supplierCategoryRoutes.use(authenticate);
supplierCategoryRoutes.get('/', can('suppliers:view'), validate({ query: v.categoryListQuery }), h(async (req: Request, res: Response) => res.json(await categories.list(cid(req), req.query as never))));
supplierCategoryRoutes.post('/', can('suppliers:create'), validate({ body: v.categoryBody }), h(async (req: Request, res: Response) => {
  const out = await categories.create(cid(req), req.body); await audit(req, { action: 'create', resource: 'supplier-category', resourceId: out.id, meta: { name: out.name } }); res.status(201).json(out);
}));
supplierCategoryRoutes.put('/:id', can('suppliers:update'), validate({ params: v.idParam, body: v.categoryUpdateBody }), h(async (req: Request, res: Response) => {
  const { category, previousName } = await categories.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'supplier-category', resourceId: category.id, meta: { from: previousName, to: category.name } }); res.json(category);
}));
for (const [action, active] of [['deactivate', false], ['activate', true]] as const) {
  supplierCategoryRoutes.post(`/:id/${action}`, can('suppliers:update'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => {
    const out = await categories.setActive(cid(req), pid(req), active); await audit(req, { action, resource: 'supplier-category', resourceId: out.id, meta: { name: out.name } }); res.json(out);
  }));
}
supplierCategoryRoutes.delete('/:id', can('suppliers:delete'), validate({ params: v.idParam, query: v.categoryDeleteQuery }), h(async (req: Request, res: Response) => {
  const out = await categories.remove(cid(req), pid(req), (req.query as { reassignTo?: string }).reassignTo, actor(req));
  await audit(req, { action: 'delete', resource: 'supplier-category', resourceId: pid(req), meta: out }); res.json(out);
}));
