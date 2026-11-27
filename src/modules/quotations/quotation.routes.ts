import { enforcePriceRules } from '../products/product.rules.js';
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { emailDocument, idParam, sendBody, sendPdf } from '../sales/document.http.js';
import { pdfOf } from '../sales/document.pdf.js';
import { Customer } from '../../models/customer.model.js';
import * as activity from './quotation.activity.js';
import * as svc from './quotation.service.js';
import * as v from './quotation.validator.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const actor = (r: Request): activity.Actor => ({ userId: r.auth!.userId, name: r.auth!.name });
export const quotationRoutes = Router();
quotationRoutes.use(authenticate);
quotationRoutes.get('/', can('quotations:view'), validate({ query: v.listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
quotationRoutes.get('/stats', can('quotations:view'), h(async (req: Request, res: Response) => res.json(await svc.stats(cid(req)))));
quotationRoutes.post('/', can('quotations:create'), validate({ body: v.quotationBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const q = await svc.create(cid(req), uid(req), req.body, actor(req));
  await audit(req, { action: 'create', resource: 'quotation', resourceId: q.id, meta: { number: q.number, totalTtcMinor: q.totals.totalTtcMinor } }); res.status(201).json(q);
}));
quotationRoutes.get('/:id', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
quotationRoutes.get('/:id/activities', can('quotations:view'), validate({ params: idParam, query: v.activitiesQuery }), h(async (req: Request, res: Response) => {
  const q = await svc.getOwn(cid(req), pid(req)); // appartenance à la société
  res.json(await activity.list(cid(req), q._id, req.query as never));
}));
quotationRoutes.put('/:id', can('quotations:update'), validate({ params: idParam, body: v.quotationBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const q = await svc.update(cid(req), pid(req), req.body, actor(req)); await audit(req, { action: 'update', resource: 'quotation', resourceId: q.id, meta: { number: q.number, totalTtcMinor: q.totals.totalTtcMinor } }); res.json(q);
}));
quotationRoutes.delete('/:id', can('quotations:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const q = await svc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'quotation', resourceId: pid(req), meta: { number: q.number } }); res.status(204).end();
}));
quotationRoutes.post('/:id/mark-sent', can('quotations:update'), validate({ params: idParam, body: v.markSentBody }), h(async (req: Request, res: Response) => {
  const q = await svc.markSent(cid(req), pid(req), actor(req), req.body); await audit(req, { action: 'mark-sent', resource: 'quotation', resourceId: q.id, meta: { number: q.number, method: req.body.method } }); res.json(q);
}));
quotationRoutes.post('/:id/accept', can('quotations:update'), validate({ params: idParam, body: v.acceptBody }), h(async (req: Request, res: Response) => {
  const q = await svc.accept(cid(req), pid(req), actor(req), req.body.comment); await audit(req, { action: 'accept', resource: 'quotation', resourceId: q.id, meta: { number: q.number } }); res.json(q);
}));
quotationRoutes.post('/:id/refuse', can('quotations:update'), validate({ params: idParam, body: v.refuseBody }), h(async (req: Request, res: Response) => {
  const q = await svc.refuse(cid(req), pid(req), actor(req), req.body.reason); await audit(req, { action: 'refuse', resource: 'quotation', resourceId: q.id, meta: { number: q.number } }); res.json(q);
}));
quotationRoutes.post('/:id/duplicate', can('quotations:create'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const q = await svc.duplicate(cid(req), uid(req), pid(req), actor(req)); await audit(req, { action: 'duplicate', resource: 'quotation', resourceId: q.id, meta: { from: pid(req), number: q.number } }); res.status(201).json(q);
}));
quotationRoutes.post('/:id/convert-proforma', can('quotations:update'), can('proformas:create'), validate({ params: idParam, body: v.convertBody }), h(async (req: Request, res: Response) => {
  const r = await svc.convertToProforma(cid(req), uid(req), pid(req), req.body.validUntil, actor(req)); await audit(req, { action: 'convert-proforma', resource: 'quotation', resourceId: pid(req), meta: r }); res.status(201).json(r);
}));
quotationRoutes.post('/:id/convert-invoice', can('quotations:update'), can('invoices:create'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const r = await svc.convertToInvoice(cid(req), uid(req), pid(req), actor(req)); await audit(req, { action: 'convert-invoice', resource: 'quotation', resourceId: pid(req), meta: r }); res.status(201).json(r);
}));
quotationRoutes.get('/:id/pdf', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const q = await svc.get(cid(req), pid(req)); const body = await pdfOf(cid(req), 'quotation', q);
  await audit(req, { action: 'print', resource: 'quotation', resourceId: q.id, meta: { number: q.number } }); sendPdf(res, body, `${q.number}.pdf`);
}));
quotationRoutes.post('/:id/send', can('quotations:update'), validate({ params: idParam, body: sendBody }), h(async (req: Request, res: Response) => {
  const q = await svc.get(cid(req), pid(req)); const c = await Customer.findOne({ _id: q.customerId, companyId: cid(req) }).lean();
  await emailDocument(req, res, { resource: 'quotation', id: q.id, label: 'Devis', number: q.number, pdf: await pdfOf(cid(req), 'quotation', q), customerEmail: c?.email,
    markSent: (to) => svc.recordEmail(cid(req), q.id, to, actor(req)) });
}));
