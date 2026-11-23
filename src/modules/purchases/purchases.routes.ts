import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { boolQuery, objectId } from '../../utils/pagination.js';
import { baseListQuery, idParam } from '../sales/document.http.js';
import * as po from './order.service.js';
import * as rc from './receipt.service.js';
import * as pi from './invoice.service.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const supplierList = baseListQuery.omit({ customerId: true }).extend({ supplierId: objectId.optional() });

export const orderRoutes = Router();
orderRoutes.use(authenticate);
orderRoutes.get('/', can('purchases:view'), validate({ query: supplierList.extend({ status: z.enum(['draft', 'confirmed', 'partially_received', 'received', 'cancelled']).optional(), open: boolQuery.optional(), sort: z.string().regex(/^-?(number|orderDate|createdAt)$/).optional() }) }), h(async (req: Request, res: Response) => res.json(await po.list(cid(req), req.query as never))));
orderRoutes.post('/', can('purchases:create'), validate({ body: po.orderBody }), h(async (req: Request, res: Response) => { const o = await po.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'purchase-order', resourceId: o.id, meta: { number: o.number, totalTtcMinor: o.totals.totalTtcMinor } }); res.status(201).json(o); }));
orderRoutes.get('/:id', can('purchases:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await po.get(cid(req), pid(req)))));
orderRoutes.get('/:id/reconciliation', can('purchases:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await po.reconciliation(cid(req), pid(req)))));
orderRoutes.put('/:id', can('purchases:update'), validate({ params: idParam, body: po.orderBody }), h(async (req: Request, res: Response) => { const o = await po.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'purchase-order', resourceId: o.id, meta: { number: o.number } }); res.json(o); }));
orderRoutes.delete('/:id', can('purchases:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const o = await po.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'purchase-order', resourceId: pid(req), meta: { number: o.number } }); res.status(204).end(); }));
orderRoutes.post('/:id/confirm', can('purchases:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const o = await po.confirm(cid(req), pid(req)); await audit(req, { action: 'confirm', resource: 'purchase-order', resourceId: o.id, meta: { number: o.number } }); res.json(o); }));
orderRoutes.post('/:id/cancel', can('purchases:validate'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() }), h(async (req: Request, res: Response) => { const o = await po.cancel(cid(req), pid(req), req.body.reason); await audit(req, { action: 'cancel', resource: 'purchase-order', resourceId: o.id, meta: { number: o.number, reason: req.body.reason } }); res.json(o); }));

export const receiptRoutes = Router();
receiptRoutes.use(authenticate);
receiptRoutes.get('/', can('purchases:view'), validate({ query: baseListQuery.omit({ customerId: true, from: true, to: true }).extend({ status: z.enum(['draft', 'validated']).optional(), purchaseOrderId: objectId.optional() }) }), h(async (req: Request, res: Response) => res.json(await rc.list(cid(req), req.query as never))));
receiptRoutes.post('/', can('purchases:create'), validate({ body: rc.receiptBody }), h(async (req: Request, res: Response) => { const r = await rc.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'goods-receipt', resourceId: r.id, meta: { number: r.number } }); res.status(201).json(r); }));
receiptRoutes.get('/:id', can('purchases:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await rc.get(cid(req), pid(req)))));
receiptRoutes.put('/:id', can('purchases:update'), validate({ params: idParam, body: rc.receiptBody }), h(async (req: Request, res: Response) => { const r = await rc.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'goods-receipt', resourceId: r.id }); res.json(r); }));
receiptRoutes.delete('/:id', can('purchases:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const r = await rc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'goods-receipt', resourceId: pid(req), meta: { number: r.number } }); res.status(204).end(); }));
receiptRoutes.post('/:id/validate', can('purchases:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const r = await rc.validate(cid(req), uid(req), pid(req)); await audit(req, { action: 'validate', resource: 'goods-receipt', resourceId: r.id, meta: { number: r.number } }); res.json(r); }));

export const purchaseInvoiceRoutes = Router();
purchaseInvoiceRoutes.use(authenticate);
purchaseInvoiceRoutes.get('/', can('purchases:view'), validate({ query: supplierList.extend({ status: z.enum(['draft', 'validated']).optional(), sort: z.string().regex(/^-?(number|invoiceDate|createdAt)$/).optional() }) }), h(async (req: Request, res: Response) => res.json(await pi.list(cid(req), req.query as never))));
purchaseInvoiceRoutes.get('/from-order/:id', can('purchases:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await pi.draftFromOrder(cid(req), pid(req)))));
purchaseInvoiceRoutes.post('/', can('purchases:create'), validate({ body: pi.invoiceBody }), h(async (req: Request, res: Response) => { const i = await pi.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'purchase-invoice', resourceId: i.id, meta: { supplierInvoiceNumber: i.supplierInvoiceNumber } }); res.status(201).json(i); }));
purchaseInvoiceRoutes.get('/:id', can('purchases:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await pi.get(cid(req), pid(req)))));
purchaseInvoiceRoutes.put('/:id', can('purchases:update'), validate({ params: idParam, body: pi.invoiceBody }), h(async (req: Request, res: Response) => { const i = await pi.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'purchase-invoice', resourceId: i.id }); res.json(i); }));
purchaseInvoiceRoutes.delete('/:id', can('purchases:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const i = await pi.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'purchase-invoice', resourceId: pid(req) }); void i; res.status(204).end(); }));
purchaseInvoiceRoutes.post('/:id/validate', can('purchases:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const i = await pi.validate(cid(req), uid(req), pid(req)); await audit(req, { action: 'validate', resource: 'purchase-invoice', resourceId: i.id, meta: { number: i.number, totalTtcMinor: i.totals.totalTtcMinor, variances: i.variances.length } }); res.json(i); }));
