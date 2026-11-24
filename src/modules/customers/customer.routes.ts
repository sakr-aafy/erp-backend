import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { AppError } from '../../utils/errors.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { renderTable } from '../../services/export.service.js';
import * as c from './customer.controller.js';
import { actor, decimalsOf, send } from './customer.controller.js';
import * as svc from './customer.service.js';
import * as detail from './customer.detail.service.js';
import * as extra from './customer.extra.service.js';
import { MAX_DOC_BYTES } from './customer.files.js';
import { customerBalanceCheck } from '../invoices/invoice.service.js';
import * as v from './customer.validator.js';

export const customerRoutes = Router();
customerRoutes.use(authenticate);
const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;
const perms = (req: Request) => req.auth!.permissions;

// Téléversement : en mémoire (limite stricte), un seul fichier ; contenu et extension contrôlés par le service
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 5 } });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo maximum)' : 'Téléversement invalide', err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'));
  next(err);
});

// ---- Liste, création, fiche ----
customerRoutes.get('/', can('customers:view'), validate({ query: v.listQuery }), h(c.list));
customerRoutes.get('/export', can('customers:view'), validate({ query: v.exportQuery }), h(c.exportList));
customerRoutes.get('/cities', can('customers:view'), h(async (req: Request, res: Response) => res.json(await svc.cities(cid(req)))));
customerRoutes.post('/', can('customers:create'), validate({ body: v.createCustomerBody }), h(c.create));
customerRoutes.get('/:id', can('customers:view'), validate({ params: v.idParam }), h(c.get));
customerRoutes.get('/:id/pdf', can('customers:view'), validate({ params: v.idParam }), h(c.fichePdf));
customerRoutes.put('/:id', can('customers:update'), validate({ params: v.idParam, body: v.updateCustomerBody }), h(c.update));
customerRoutes.delete('/:id', can('customers:delete'), validate({ params: v.idParam }), h(c.remove));

// ---- Statut ----
customerRoutes.post('/:id/status', can('customers:update'), validate({ params: v.idParam, body: v.statusBody }), h(c.setStatus));
customerRoutes.post('/:id/archive', can('customers:update'), validate({ params: v.idParam }), h(c.archive));
customerRoutes.post('/:id/reactivate', can('customers:update'), validate({ params: v.idParam }), h(c.reactivate));

// ---- Onglets Résumé / Transactions / Paiements (les données de chaque module exigent la permission de CE module) ----
customerRoutes.get('/:id/summary', can('customers:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await detail.summary(cid(req), pid(req), perms(req)))));
customerRoutes.get('/:id/transactions', can('customers:view'), validate({ params: v.idParam, query: v.transactionsQuery }), h(async (req: Request, res: Response) => res.json(await detail.transactions(cid(req), pid(req), perms(req), req.query as never))));
customerRoutes.get('/:id/payments', can('customers:view', 'invoices:view'), validate({ params: v.idParam, query: v.paymentsQuery }), h(async (req: Request, res: Response) => res.json(await detail.payments(cid(req), pid(req), perms(req), req.query as never))));
customerRoutes.get('/:id/balance-check', can('customers:view', 'invoices:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await customerBalanceCheck(cid(req), pid(req)))));
customerRoutes.get('/:id/statement', can('customers:view', 'accounting:view'), validate({ params: v.idParam, query: v.statementQuery }), h(async (req: Request, res: Response) => {
  const st = await detail.statement(cid(req), pid(req)); const d = await decimalsOf(req); const m = (x: number | undefined) => ((x ?? 0) / 10 ** d).toFixed(d);
  const { format } = req.query as unknown as { format: 'xlsx' | 'csv' | 'pdf' };
  const rows = st.documents.map((x) => ({ ...x, remaining: Math.max(0, x.amountMinor - (x.paidMinor ?? 0) - (x.creditedMinor ?? 0)) }));
  const out = await renderTable(format, 'releve-client', `Relevé de compte — ${st.name}`, `Solde : ${m(st.balanceMinor)} — édité le ${new Date().toLocaleDateString('fr-FR')}`, [
    { header: 'Date', key: 'date', width: 12, value: (r) => new Date(r.date).toISOString().slice(0, 10) },
    { header: 'Document', key: 'number', width: 18, value: (r) => r.number },
    { header: 'Type', key: 'type', width: 10, value: (r) => (r.type === 'credit_note' ? 'Avoir' : 'Facture') },
    { header: 'Montant', key: 'amount', width: 14, align: 'right', value: (r) => (r.type === 'credit_note' ? '-' : '') + m(r.amountMinor) },
    { header: 'Encaissé', key: 'paid', width: 14, align: 'right', value: (r) => m(r.paidMinor) },
    { header: 'Reste dû', key: 'remaining', width: 14, align: 'right', value: (r) => (r.type === 'credit_note' ? '' : m(r.remaining)) },
  ], rows);
  await audit(req, { action: 'export', resource: 'customer-statement', resourceId: pid(req), meta: { format } });
  send(res, out);
}));

// ---- Contacts ----
customerRoutes.post('/:id/contacts', can('customers:update'), validate({ params: v.idParam, body: v.contactBody }), h(async (req: Request, res: Response) => {
  const out = await svc.addContact(cid(req), pid(req), req.body, actor(req)); await audit(req, { action: 'contact-add', resource: 'customer', resourceId: pid(req) }); res.status(201).json(out);
}));
customerRoutes.put('/:id/contacts/:contactId', can('customers:update'), validate({ params: v.contactParams, body: v.contactBody.partial().strict() }), h(async (req: Request, res: Response) => {
  const out = await svc.updateContact(cid(req), pid(req), req.params.contactId as string, req.body, actor(req)); await audit(req, { action: 'contact-update', resource: 'customer', resourceId: pid(req) }); res.json(out);
}));
customerRoutes.post('/:id/contacts/:contactId/primary', can('customers:update'), validate({ params: v.contactParams }), h(async (req: Request, res: Response) => {
  const out = await svc.setPrimaryContact(cid(req), pid(req), req.params.contactId as string, actor(req)); await audit(req, { action: 'contact-primary', resource: 'customer', resourceId: pid(req) }); res.json(out);
}));
customerRoutes.delete('/:id/contacts/:contactId', can('customers:update'), validate({ params: v.contactParams }), h(async (req: Request, res: Response) => {
  const out = await svc.removeContact(cid(req), pid(req), req.params.contactId as string, actor(req)); await audit(req, { action: 'contact-remove', resource: 'customer', resourceId: pid(req) }); res.json(out);
}));

// ---- Documents (fichiers stockés dans MongoDB, jamais accessibles sans authentification ni hors de la société) ----
customerRoutes.get('/:id/documents', can('customers:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await extra.listDocuments(cid(req), pid(req)))));
customerRoutes.post('/:id/documents', can('customers:update'), validate({ params: v.idParam }), uploadOne, validate({ body: v.docMetaBody }), h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier requis (champ « file »)');
  const d = await extra.addDocument(cid(req), pid(req), req.file, req.body, actor(req));
  await audit(req, { action: 'document-upload', resource: 'customer', resourceId: pid(req), meta: { file: d.name, type: d.type, size: d.size } }); res.status(201).json(d);
}));
customerRoutes.put('/:id/documents/:docId', can('customers:update'), validate({ params: v.docParams, body: v.docUpdateBody }), h(async (req: Request, res: Response) => {
  const d = await extra.updateDocument(cid(req), pid(req), req.params.docId as string, req.body); await audit(req, { action: 'document-update', resource: 'customer', resourceId: pid(req), meta: { documentId: d.id } }); res.json(d);
}));
customerRoutes.get('/:id/documents/:docId/file', can('customers:view'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const { doc, stream, inline } = await extra.documentStream(cid(req), pid(req), req.params.docId as string);
  const asInline = req.query.disposition === 'inline' && inline;
  res.setHeader('Content-Type', doc.mime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'no-store');
  if (doc.size) res.setHeader('Content-Length', String(doc.size));
  await audit(req, { action: 'document-download', resource: 'customer', resourceId: pid(req), meta: { file: doc.originalName } });
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
}));
customerRoutes.delete('/:id/documents/:docId', can('customers:update'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const d = await extra.removeDocument(cid(req), pid(req), req.params.docId as string, actor(req)); await audit(req, { action: 'document-delete', resource: 'customer', resourceId: pid(req), meta: { file: d.originalName } }); res.status(204).end();
}));

// ---- Activités ----
customerRoutes.get('/:id/activities', can('customers:view'), validate({ params: v.idParam, query: v.activitiesQuery }), h(async (req: Request, res: Response) => res.json(await extra.listActivities(cid(req), pid(req), perms(req), req.query as never))));
customerRoutes.post('/:id/activities', can('customers:update'), validate({ params: v.idParam, body: v.activityBody }), h(async (req: Request, res: Response) => res.status(201).json(await extra.addActivity(cid(req), pid(req), req.body, actor(req)))));
customerRoutes.put('/:id/activities/:activityId', can('customers:update'), validate({ params: v.activityParams, body: v.activityUpdateBody }), h(async (req: Request, res: Response) => res.json(await extra.updateActivity(cid(req), pid(req), req.params.activityId as string, req.body))));
customerRoutes.delete('/:id/activities/:activityId', can('customers:update'), validate({ params: v.activityParams }), h(async (req: Request, res: Response) => { await extra.removeActivity(cid(req), pid(req), req.params.activityId as string); res.status(204).end(); }));
