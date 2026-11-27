import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import { idParam, sendPdf } from '../sales/document.http.js';
import { pdfOf } from '../sales/document.pdf.js';
import * as svc from './delivery.service.js';
import * as returns from './return.service.js';
import * as v from './delivery.validator.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const actor = (r: Request) => ({ userId: r.auth!.userId, name: r.auth!.name });
export const deliveryRoutes = Router();
deliveryRoutes.use(authenticate);
deliveryRoutes.get('/', can('deliveryNotes:view'), validate({ query: v.listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
deliveryRoutes.get('/source-lines', can('deliveryNotes:view'), validate({ query: v.sourceQuery }), h(async (req: Request, res: Response) => {
  const q = req.query as unknown as { type: 'quotation' | 'proforma' | 'invoice'; id: string; excludeId?: string }; res.json(await svc.sourceLines(cid(req), q.type, q.id, q.excludeId));
}));
deliveryRoutes.get('/available-serials', can('deliveryNotes:view'), validate({ query: v.serialsQuery }), h(async (req: Request, res: Response) => res.json(await svc.availableSerials(cid(req), req.query as never))));
deliveryRoutes.post('/', can('deliveryNotes:create'), validate({ body: v.deliveryBody }), h(async (req: Request, res: Response) => {
  const d = await svc.create(cid(req), uid(req), req.body, actor(req)); await audit(req, { action: 'create', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number, source: d.source } }); res.status(201).json(d);
}));
deliveryRoutes.get('/:id', can('deliveryNotes:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
deliveryRoutes.put('/:id', can('deliveryNotes:update'), validate({ params: idParam, body: v.deliveryBody }), h(async (req: Request, res: Response) => {
  const d = await svc.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number } }); res.json(d);
}));
deliveryRoutes.delete('/:id', can('deliveryNotes:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const d = await svc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'delivery-note', resourceId: pid(req), meta: { number: d.number } }); res.status(204).end();
}));
deliveryRoutes.post('/:id/validate', can('deliveryNotes:validate'), validate({ params: idParam, body: v.validateBody }), h(async (req: Request, res: Response) => {
  // Stock négatif : autorisation EXPLICITE, réservée à inventory:validate, auditée
  if (req.body.allowNegativeStock && !req.auth!.permissions.has('inventory:validate')) throw AppError.forbidden('Autorisation de stock négatif : permission inventory:validate requise');
  const d = await svc.validate(cid(req), uid(req), pid(req), req.body, req.auth!.name); await audit(req, { action: 'validate', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number, warehouseId: req.body.warehouseId, allowNegativeStock: !!req.body.allowNegativeStock } }); res.json(d);
}));
deliveryRoutes.post('/:id/cancel', can('deliveryNotes:validate'), validate({ params: idParam, body: v.cancelBody }), h(async (req: Request, res: Response) => {
  const d = await svc.cancel(cid(req), uid(req), pid(req), req.body.reason, req.auth!.name); await audit(req, { action: 'cancel', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number, reason: req.body.reason, returnConfirmed: true } }); res.json(d);
}));
// Retour physique : remet du stock, même permission que la validation et l'annulation
deliveryRoutes.get('/:id/returnable', can('deliveryNotes:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await returns.returnable(cid(req), pid(req)))));
deliveryRoutes.post('/:id/returns', can('deliveryNotes:validate'), validate({ params: idParam, body: v.returnBody }), h(async (req: Request, res: Response) => {
  const d = await returns.create(cid(req), uid(req), pid(req), req.body, actor(req)); await audit(req, { action: 'return', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number, reason: req.body.reason, lines: req.body.lines, returnConfirmed: true } }); res.status(201).json(d);
}));
deliveryRoutes.get('/:id/pdf', can('deliveryNotes:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const d = await svc.get(cid(req), pid(req)); const body = await pdfOf(cid(req), 'deliveryNote', d);
  await audit(req, { action: 'print', resource: 'delivery-note', resourceId: d.id, meta: { number: d.number } }); sendPdf(res, body, `${d.number}.pdf`);
}));
