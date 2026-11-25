import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { AppError } from '../../utils/errors.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import * as c from './product.controller.js';
import { actor, access } from './product.controller.js';
import * as svc from './product.service.js';
import * as stock from './product.stock.js';
import * as tx from './product.transactions.js';
import * as extra from './product.extra.js';
import { MAX_DOC_BYTES } from '../customers/customer.files.js';
import { Setting } from '../../models/setting.model.js';
import { renderTable } from '../../services/export.service.js';
import * as v from './product.validator.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(AppError.badRequest('Format non supporté : .xlsx ou .csv uniquement'))) });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (5 Mo max)' : 'Fichier invalide', 'UPLOAD_ERROR'));
  next(err);
});

const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 5 } });
const docUploadOne: RequestHandler = (req, res, next) => docUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo maximum)' : 'Téléversement invalide', err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'));
  next(err);
});
const cid = (req: Request) => req.auth!.companyId; const pid = (req: Request) => req.params.id as string; const perms = (req: Request) => req.auth!.permissions;
const baseCurrency = async (req: Request) => (await Setting.findOne({ companyId: cid(req) }).lean())?.baseCurrency ?? 'TND';

export const productRoutes = Router();
productRoutes.use(authenticate);
productRoutes.get('/', can('products:view'), validate({ query: v.listQuery }), h(c.list));
productRoutes.get('/export', can('products:view'), validate({ query: v.exportQuery }), h(c.exportList));
productRoutes.get('/import/template', can('products:view'), h(c.template));
// upsert nécessite aussi products:update : contrôlé dans le middleware ci-dessous
productRoutes.post('/import', can('products:create'), validate({ query: v.importQuery }), ((req, _res, next) =>
  (req.query as { mode?: string }).mode === 'upsert' && !req.auth!.permissions.has('products:update') ? next(AppError.forbidden('Permission requise : products:update')) : next()) as RequestHandler,
  uploadOne, h(c.importFile));
productRoutes.get('/brands', can('products:view'), h(async (req: Request, res: Response) => res.json(await svc.brands(cid(req)))));
productRoutes.post('/pricing-preview', can('products:view'), validate({ body: v.pricingPreviewBody }), h(async (req: Request, res: Response) => res.json(await svc.pricingPreview(cid(req), req.body, access(req)))));
productRoutes.post('/', can('products:create'), validate({ body: v.createProductBody }), h(c.create));
productRoutes.get('/:id', can('products:view'), validate({ params: v.idParam }), h(c.get));
productRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.updateProductBody }), h(c.update));
productRoutes.get('/:id/pdf', can('products:view'), validate({ params: v.idParam }), h(c.fichePdf));
productRoutes.post('/:id/status', can('products:update'), validate({ params: v.idParam, body: v.statusBody }), h(c.setStatus));
// Groupes de la fiche : mêmes règles que PUT /:id, avec des corps restreints au groupe
productRoutes.put('/:id/packaging', can('products:update'), validate({ params: v.idParam, body: v.packagingBody }), h(async (req: Request, res: Response) => { req.body = { packaging: req.body }; await c.update(req, res); }));
productRoutes.put('/:id/prices', can('products:update'), validate({ params: v.idParam, body: v.pricingBody }), h(c.update));
productRoutes.put('/:id/customs', can('products:update'), validate({ params: v.idParam, body: v.customsBody }), h(async (req: Request, res: Response) => { req.body = { customs: req.body }; await c.update(req, res); }));
productRoutes.get('/:id/stock', can('products:view', 'inventory:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await stock.stockTab(cid(req), pid(req), true))));
productRoutes.put('/:id/stock-settings/:warehouseId', can('products:update', 'inventory:view'), validate({ params: v.stockParams, body: v.stockSettingBody }), h(async (req: Request, res: Response) => {
  const out = await stock.saveStockSetting(cid(req), pid(req), req.params.warehouseId as string, req.body, actor(req)); await audit(req, { action: 'stock-setting', resource: 'product', resourceId: pid(req), meta: { warehouseId: req.params.warehouseId, ...req.body } }); res.json(out);
}));
productRoutes.get('/:id/transactions', can('products:view'), validate({ params: v.idParam, query: v.transactionsQuery }), h(async (req: Request, res: Response) => res.json(await tx.transactions(cid(req), pid(req), perms(req), await baseCurrency(req), req.query as never))));
productRoutes.get('/:id/transactions/export', can('products:view'), validate({ params: v.idParam, query: v.transactionsExportQuery }), h(async (req: Request, res: Response) => {
  const { format, ...q } = req.query as unknown as { format: 'xlsx' | 'csv' | 'pdf' } & Record<string, never>; const cur = await baseCurrency(req);
  const data = await tx.transactions(cid(req), pid(req), perms(req), cur, { ...(q as object), page: 1, limit: 5000 } as never); const p = await svc.getOwn(cid(req), pid(req));
  const dec = (await Setting.findOne({ companyId: cid(req) }).lean())?.currencies.find((c) => c.code === cur)?.decimals ?? 3; const m = (x: number | null) => (x == null ? '' : Number((x / 10 ** dec).toFixed(dec)));
  const out = await renderTable(format, `transactions-${p.reference}`, `Transactions — ${p.reference}`, `${data.items.length} opération(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, [
    { header: 'Type', key: 'k', width: 24, value: (r: tx.TxRow) => r.kindLabel }, { header: 'N° document', key: 'n', width: 18, value: (r: tx.TxRow) => r.number }, { header: 'Date', key: 'd', width: 12, value: (r: tx.TxRow) => new Date(r.date).toISOString().slice(0, 10) },
    { header: 'Client', key: 'c', width: 22, value: (r: tx.TxRow) => r.customer }, { header: 'Fournisseur', key: 's', width: 22, value: (r: tx.TxRow) => r.supplier }, { header: 'Quantité', key: 'q', width: 10, align: 'right', value: (r: tx.TxRow) => r.quantity },
    { header: 'Prix unitaire', key: 'u', width: 14, align: 'right', value: (r: tx.TxRow) => m(r.unitPriceMinor) }, { header: 'Devise', key: 'cur', width: 8, value: (r: tx.TxRow) => r.currency }, { header: 'Total', key: 't', width: 14, align: 'right', value: (r: tx.TxRow) => m(r.totalMinor) },
    { header: 'Entrepôt', key: 'w', width: 22, value: (r: tx.TxRow) => r.warehouse }, { header: 'Statut', key: 'st', width: 18, value: (r: tx.TxRow) => r.statusLabel },
  ], data.items);
  await audit(req, { action: 'export', resource: 'product', resourceId: pid(req), meta: { what: 'transactions', format, count: data.items.length } });
  res.setHeader('Content-Type', out.contentType); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(out.body);
}));
productRoutes.get('/:id/activities', can('products:view'), validate({ params: v.idParam, query: v.activitiesQuery }), h(async (req: Request, res: Response) => res.json(await extra.listActivities(cid(req), pid(req), perms(req), access(req), req.query as never))));
productRoutes.post('/:id/activities', can('products:update'), validate({ params: v.idParam, body: v.activityBody }), h(async (req: Request, res: Response) => res.status(201).json(await extra.addActivity(cid(req), pid(req), req.body, actor(req)))));
productRoutes.put('/:id/activities/:activityId', can('products:update'), validate({ params: v.activityParams, body: v.activityUpdateBody }), h(async (req: Request, res: Response) => res.json(await extra.updateActivity(cid(req), pid(req), req.params.activityId as string, req.body))));
productRoutes.delete('/:id/activities/:activityId', can('products:update'), validate({ params: v.activityParams }), h(async (req: Request, res: Response) => { await extra.removeActivity(cid(req), pid(req), req.params.activityId as string); res.status(204).end(); }));
// Documents : fichiers dans MongoDB (GridFS), authentification et appartenance à la société vérifiées à chaque accès
productRoutes.get('/:id/documents', can('products:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => res.json(await extra.listDocuments(cid(req), pid(req), perms(req)))));
productRoutes.post('/:id/documents', can('products:update'), validate({ params: v.idParam }), docUploadOne, validate({ body: v.docMetaBody }), h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier requis (champ « file »)');
  const d = await extra.addDocument(cid(req), pid(req), req.file, req.body, actor(req)); await audit(req, { action: 'document-upload', resource: 'product', resourceId: pid(req), meta: { file: d.name, type: d.type, size: d.size } }); res.status(201).json(d);
}));
productRoutes.get('/:id/photo', can('products:view'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => {
  const { doc, stream } = await extra.mainPhotoStream(cid(req), pid(req));
  res.setHeader('Content-Type', doc.mime ?? 'image/jpeg'); res.setHeader('Content-Disposition', 'inline'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'private, max-age=60');
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
}));
productRoutes.put('/:id/documents/:docId', can('products:update'), validate({ params: v.docParams, body: v.docUpdateBody }), h(async (req: Request, res: Response) => {
  const d = await extra.updateDocument(cid(req), pid(req), req.params.docId as string, req.body); await audit(req, { action: 'document-update', resource: 'product', resourceId: pid(req), meta: { documentId: d.id } }); res.json(d);
}));
productRoutes.post('/:id/documents/:docId/main', can('products:update'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const r = await extra.setMainPhoto(cid(req), pid(req), req.params.docId as string); await audit(req, { action: 'document-main-photo', resource: 'product', resourceId: pid(req), meta: { documentId: r.mainPhotoId } }); res.json(r);
}));
productRoutes.get('/:id/documents/:docId/file', can('products:view'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const { doc, stream, inline } = await extra.documentStream(cid(req), pid(req), req.params.docId as string);
  const asInline = req.query.disposition === 'inline' && inline;
  res.setHeader('Content-Type', doc.mime ?? 'application/octet-stream'); res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'no-store'); if (doc.size) res.setHeader('Content-Length', String(doc.size));
  await audit(req, { action: 'document-download', resource: 'product', resourceId: pid(req), meta: { file: doc.originalName } });
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
}));
productRoutes.delete('/:id/documents/:docId', can('products:update'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const d = await extra.removeDocument(cid(req), pid(req), req.params.docId as string, actor(req)); await audit(req, { action: 'document-delete', resource: 'product', resourceId: pid(req), meta: { file: d.originalName } }); res.status(204).end();
}));
productRoutes.patch('/:id/active', can('products:update'), validate({ params: v.idParam, body: v.activeBody }), h(c.setActive));
productRoutes.post('/:id/duplicate', can('products:create'), validate({ params: v.idParam, body: v.duplicateBody }), h(c.duplicate));
productRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.remove));
productRoutes.get('/:id/serials', can('products:view'), validate({ params: v.idParam, query: v.serialsQuery }), h(c.listSerials));
productRoutes.post('/:id/serials', can('products:update'), validate({ params: v.idParam, body: v.serialsBody }), h(c.addSerials));
productRoutes.delete('/:id/serials/:serialId', can('products:update'), validate({ params: v.serialParam }), h(c.removeSerial));

export const categoryRoutes = Router();
categoryRoutes.use(authenticate);
categoryRoutes.get('/', can('products:view'), h(c.listCategories));
categoryRoutes.post('/', can('products:create'), validate({ body: v.categoryBody }), h(c.createCategory));
categoryRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.categoryUpdateBody }), h(c.renameCategory));
categoryRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.deleteCategory));

export const unitRoutes = Router();
unitRoutes.use(authenticate);
unitRoutes.get('/', can('products:view'), h(c.listUnits));
unitRoutes.post('/', can('products:create'), validate({ body: v.unitBody }), h(c.createUnit));
unitRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.unitUpdateBody }), h(c.updateUnit));
unitRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.deleteUnit));
