import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { AppError } from '../../utils/errors.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { boolQuery, objectId } from '../../utils/pagination.js';
import { baseListQuery, idParam } from '../sales/document.http.js';
import * as svc from './import.service.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next(); if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo max)' : 'Fichier invalide', 'UPLOAD_ERROR')); next(err);
});
const sub = z.object({ id: objectId, sub: objectId });

export const importRoutes = Router();
importRoutes.use(authenticate);
importRoutes.get('/', can('imports:view'), validate({ query: baseListQuery.omit({ customerId: true }).extend({ supplierId: objectId.optional(), status: z.enum(['draft', 'ordered', 'shipped', 'customs', 'arrived', 'closed', 'integrated', 'cancelled']).optional(), open: boolQuery.optional(), sort: z.string().regex(/^-?(number|orderDate|createdAt)$/).optional() }) }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
importRoutes.post('/', can('imports:create'), validate({ body: svc.createBody }), h(async (req: Request, res: Response) => { const f = await svc.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'import-file', resourceId: f.id, meta: { number: f.number, currency: f.currency, rate: f.exchangeRate } }); res.status(201).json(f); }));
importRoutes.get('/:id', can('imports:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
importRoutes.get('/:id/cost-sheet', can('imports:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.costSheet(cid(req), pid(req)))));
importRoutes.put('/:id', can('imports:update'), validate({ params: idParam, body: svc.createBody }), h(async (req: Request, res: Response) => { const f = await svc.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'import-file', resourceId: f.id, meta: { number: f.number } }); res.json(f); }));
importRoutes.delete('/:id', can('imports:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const f = await svc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'import-file', resourceId: pid(req), meta: { number: f.number } }); res.status(204).end(); }));
importRoutes.post('/:id/status', can('imports:update'), validate({ params: idParam, body: z.object({ status: z.enum(['ordered', 'shipped', 'customs', 'arrived', 'cancelled']), reason: z.string().trim().max(300).optional() }).strict() }), h(async (req: Request, res: Response) => { const f = await svc.setStatus(cid(req), pid(req), req.body.status, req.body.reason); await audit(req, { action: `status-${req.body.status}`, resource: 'import-file', resourceId: f.id, meta: { number: f.number } }); res.json(f); }));
importRoutes.post('/:id/charges', can('imports:update'), validate({ params: idParam, body: svc.chargeBody }), h(async (req: Request, res: Response) => { const f = await svc.addCharge(cid(req), pid(req), req.body); await audit(req, { action: 'add-charge', resource: 'import-file', resourceId: f.id, meta: { type: req.body.type, amountMinor: req.body.amountMinor, landedMinor: f.totals?.landedMinor } }); res.status(201).json(f); }));
importRoutes.put('/:id/charges/:sub', can('imports:update'), validate({ params: sub, body: svc.chargeBody }), h(async (req: Request, res: Response) => { const f = await svc.updateCharge(cid(req), pid(req), req.params.sub as string, req.body); await audit(req, { action: 'update-charge', resource: 'import-file', resourceId: f.id }); res.json(f); }));
importRoutes.delete('/:id/charges/:sub', can('imports:update'), validate({ params: sub }), h(async (req: Request, res: Response) => { const f = await svc.removeCharge(cid(req), pid(req), req.params.sub as string); await audit(req, { action: 'remove-charge', resource: 'import-file', resourceId: f.id }); res.json(f); }));
importRoutes.post('/:id/close', can('imports:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const f = await svc.close(cid(req), pid(req)); await audit(req, { action: 'close', resource: 'import-file', resourceId: f.id, meta: { number: f.number, landedMinor: f.totals?.landedMinor } }); res.json(f); }));
importRoutes.post('/:id/integrate', can('imports:validate'), validate({ params: idParam, body: z.object({ warehouseId: objectId, serials: z.record(z.string(), z.array(z.string().trim().min(1)).max(1000)).optional() }).strict() }), h(async (req: Request, res: Response) => {
  const f = await svc.integrate(cid(req), uid(req), pid(req), req.body); await audit(req, { action: 'integrate', resource: 'import-file', resourceId: f.id, meta: { number: f.number, warehouseId: req.body.warehouseId, landedMinor: f.totals?.landedMinor } }); res.json(f);
}));
importRoutes.post('/:id/documents', can('imports:update'), validate({ params: idParam, body: svc.docBody }), h(async (req: Request, res: Response) => { const f = await svc.addDocument(cid(req), pid(req), req.body); await audit(req, { action: 'add-document', resource: 'import-file', resourceId: f.id, meta: { name: req.body.name } }); res.status(201).json(f); }));
importRoutes.patch('/:id/documents/:sub', can('imports:update'), validate({ params: sub, body: z.object({ status: z.enum(['pending', 'received']) }).strict() }), h(async (req: Request, res: Response) => res.json(await svc.setDocumentStatus(cid(req), pid(req), req.params.sub as string, req.body.status))));
importRoutes.post('/:id/documents/:sub/file', can('imports:update'), validate({ params: sub }), uploadOne, h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier manquant (champ « file »)');
  const f = await svc.storeDocumentFile(cid(req), pid(req), req.params.sub as string, req.file); await audit(req, { action: 'upload-document', resource: 'import-file', resourceId: f.id, meta: { file: req.file.originalname.slice(0, 80), size: req.file.size } }); res.status(201).json(f);
}));
importRoutes.get('/:id/documents/:sub/file', can('imports:view'), validate({ params: sub }), h(async (req: Request, res: Response) => {
  const f = await svc.documentFile(cid(req), pid(req), req.params.sub as string);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); res.sendFile(f.path);
}));

export const exchangeRoutes = Router();
exchangeRoutes.use(authenticate);
exchangeRoutes.get('/', can('imports:view'), validate({ query: z.object({ currency: z.string().length(3).toUpperCase().optional() }) }), h(async (req: Request, res: Response) => res.json(await svc.listRates(cid(req), (req.query as { currency?: string }).currency))));
exchangeRoutes.get('/resolve', can('imports:view'), validate({ query: z.object({ currency: z.string().length(3).toUpperCase(), date: z.coerce.date().optional() }) }), h(async (req: Request, res: Response) => { const q = req.query as unknown as { currency: string; date?: Date }; res.json(await svc.resolveRate(cid(req), q.currency, q.date ?? new Date())); }));
exchangeRoutes.post('/', can('imports:create'), validate({ body: svc.rateBody }), h(async (req: Request, res: Response) => { const r = await svc.saveRate(cid(req), req.body); await audit(req, { action: 'save-rate', resource: 'exchange-rate', resourceId: r.id, meta: { currency: r.currency, rate: r.rate } }); res.status(201).json(r); }));
