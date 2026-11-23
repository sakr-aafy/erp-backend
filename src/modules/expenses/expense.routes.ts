import { Router, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import { exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { Setting } from '../../models/setting.model.js';
import { EXPENSE_STATUSES } from '../../models/finance.model.js';
import { renderTable, type ExportFormat } from '../../services/export.service.js';
import { dateRange, idParam } from '../sales/document.http.js';
import * as svc from './expense.service.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next(); if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (5 Mo max)' : 'Fichier invalide', 'UPLOAD_ERROR')); next(err);
});
const reason = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const sub = z.object({ id: objectId, sub: objectId });

export const expenseCategoryRoutes = Router();
expenseCategoryRoutes.use(authenticate);
expenseCategoryRoutes.get('/', can('expenses:view'), h(async (req: Request, res: Response) => res.json(await svc.listCategories(cid(req)))));
expenseCategoryRoutes.post('/', can('expenses:create'), validate({ body: svc.categoryBody }), h(async (req: Request, res: Response) => { const c = await svc.createCategory(cid(req), req.body); await audit(req, { action: 'create', resource: 'expense-category', resourceId: c.id, meta: { name: c.name } }); res.status(201).json(c); }));
expenseCategoryRoutes.put('/:id', can('expenses:update'), validate({ params: idParam, body: svc.categoryBody }), h(async (req: Request, res: Response) => { const c = await svc.updateCategory(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'expense-category', resourceId: c.id }); res.json(c); }));
expenseCategoryRoutes.delete('/:id', can('expenses:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { await svc.removeCategory(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'expense-category', resourceId: pid(req) }); res.status(204).end(); }));

const listQ = paginationQuery.extend({ status: z.enum(EXPENSE_STATUSES).optional(), categoryId: objectId.optional(), ...dateRange, sort: z.string().regex(/^-?(number|date|amountMinor|createdAt)$/).optional() });
export const expenseRoutes = Router();
expenseRoutes.use(authenticate);
expenseRoutes.get('/', can('expenses:view'), validate({ query: listQ }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
expenseRoutes.get('/summary', can('expenses:view'), validate({ query: z.object(dateRange) }), h(async (req: Request, res: Response) => res.json(await svc.summary(cid(req), req.query as never))));
expenseRoutes.get('/export', can('expenses:view'), validate({ query: z.object({ q: z.string().max(100).optional(), status: z.enum(EXPENSE_STATUSES).optional(), categoryId: objectId.optional(), ...dateRange, format: exportFormat }) }), h(async (req: Request, res: Response) => {
  const f = req.query as unknown as { format: ExportFormat }; const rows = await svc.listAll(cid(req), req.query as never); const s = await Setting.findOne({ companyId: cid(req) }).lean(); const d = s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
  const out = await renderTable(f.format, 'depenses', 'Dépenses', `${rows.length} dépense(s)`, [{ header: 'N°', key: 'n', width: 16, value: (e) => e.number }, { header: 'Date', key: 'd', width: 12, value: (e) => e.date }, { header: 'Catégorie', key: 'c', width: 20, value: (e) => e.categoryName },
    { header: 'Bénéficiaire', key: 'b', width: 28, value: (e) => e.beneficiary }, { header: 'Montant', key: 'a', width: 14, align: 'right', value: (e) => e.amountMinor / 10 ** d }, { header: 'Statut', key: 's', width: 12, value: (e) => e.status }], rows);
  await audit(req, { action: 'export', resource: 'expense', meta: { format: f.format, count: rows.length } });
  res.setHeader('Content-Type', out.contentType); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(out.body);
}));
expenseRoutes.post('/', can('expenses:create'), validate({ body: svc.expenseBody }), h(async (req: Request, res: Response) => { const e = await svc.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'expense', resourceId: e.id, meta: { number: e.number, amountMinor: e.amountMinor } }); res.status(201).json(e); }));
expenseRoutes.get('/:id', can('expenses:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
expenseRoutes.put('/:id', can('expenses:update'), validate({ params: idParam, body: svc.expenseBody }), h(async (req: Request, res: Response) => { const e = await svc.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'expense', resourceId: e.id, meta: { number: e.number } }); res.json(e); }));
expenseRoutes.delete('/:id', can('expenses:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const e = await svc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'expense', resourceId: pid(req), meta: { number: e.number } }); res.status(204).end(); }));
expenseRoutes.post('/:id/submit', can('expenses:update'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const e = await svc.submit(cid(req), uid(req), pid(req)); await audit(req, { action: 'submit', resource: 'expense', resourceId: e.id, meta: { number: e.number } }); res.json(e); }));
expenseRoutes.post('/:id/validate', can('expenses:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const e = await svc.validate(cid(req), uid(req), pid(req)); await audit(req, { action: 'validate', resource: 'expense', resourceId: e.id, meta: { number: e.number, amountMinor: e.amountMinor } }); res.json(e); }));
expenseRoutes.post('/:id/reject', can('expenses:validate'), validate({ params: idParam, body: reason }), h(async (req: Request, res: Response) => { const e = await svc.reject(cid(req), uid(req), pid(req), req.body.reason); await audit(req, { action: 'reject', resource: 'expense', resourceId: e.id, meta: { number: e.number, reason: req.body.reason } }); res.json(e); }));
expenseRoutes.post('/:id/cancel', can('expenses:validate'), validate({ params: idParam, body: reason }), h(async (req: Request, res: Response) => { const e = await svc.cancel(cid(req), uid(req), pid(req), req.body.reason); await audit(req, { action: 'cancel', resource: 'expense', resourceId: e.id, meta: { number: e.number, reason: req.body.reason } }); res.json(e); }));
expenseRoutes.post('/:id/attachments', can('expenses:update'), validate({ params: idParam }), uploadOne, h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier manquant (champ « file »)');
  const e = await svc.addAttachment(cid(req), pid(req), req.file); await audit(req, { action: 'upload-attachment', resource: 'expense', resourceId: e.id, meta: { file: req.file.originalname.slice(0, 80), size: req.file.size } }); res.status(201).json(e);
}));
expenseRoutes.get('/:id/attachments/:sub', can('expenses:view'), validate({ params: sub }), h(async (req: Request, res: Response) => {
  const f = await svc.attachmentFile(cid(req), pid(req), req.params.sub as string);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); res.sendFile(f.path);
}));
expenseRoutes.delete('/:id/attachments/:sub', can('expenses:update'), validate({ params: sub }), h(async (req: Request, res: Response) => { const e = await svc.removeAttachment(cid(req), pid(req), req.params.sub as string); await audit(req, { action: 'remove-attachment', resource: 'expense', resourceId: e.id }); res.json(e); }));
