import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../services/audit.service.js';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { boolQuery, objectId } from '../../utils/pagination.js';
import * as svc from './payment-term.service.js';

const label = z.string().trim().min(1, 'Libellé requis').max(500);
const delayDays = z.number().int().min(0).max(365).nullable().optional();
const createBody = z.object({ label, delayDays }).strict();
const updateBody = z.object({ label: label.optional(), delayDays }).strict();
const idParam = z.object({ id: objectId });
const listQuery = z.object({ q: z.string().trim().max(100).optional(), active: boolQuery.optional() });
const defaultBody = z.object({ isDefault: z.boolean() }).strict();

const cid = (r: Request) => r.auth!.companyId; const pid = (r: Request) => r.params.id as string;
const log = (r: Request, action: string, id: string, meta?: Record<string, unknown>) => audit(r, { action, resource: 'payment-term', resourceId: id, ...(meta && { meta }) });

export const paymentTermRoutes = Router();
paymentTermRoutes.use(authenticate);
// Liste de référence : tout utilisateur authentifié (formulaires clients et documents)
paymentTermRoutes.get('/', validate({ query: listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
paymentTermRoutes.post('/', can('customers:create'), validate({ body: createBody }), h(async (req: Request, res: Response) => { const t = await svc.create(cid(req), req.body); await log(req, 'create', t.id, { label: t.label }); res.status(201).json(t); }));
paymentTermRoutes.put('/:id', can('customers:update'), validate({ params: idParam, body: updateBody }), h(async (req: Request, res: Response) => { const t = await svc.update(cid(req), pid(req), req.body); await log(req, 'update', t.id, { label: t.label }); res.json(t); }));
paymentTermRoutes.post('/:id/activate', can('customers:update'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const t = await svc.setActive(cid(req), pid(req), true); await log(req, 'activate', t.id); res.json(t); }));
paymentTermRoutes.post('/:id/deactivate', can('customers:update'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const t = await svc.setActive(cid(req), pid(req), false); await log(req, 'deactivate', t.id); res.json(t); }));
paymentTermRoutes.post('/:id/default', can('customers:update'), validate({ params: idParam, body: defaultBody }), h(async (req: Request, res: Response) => { const t = await svc.setDefault(cid(req), pid(req), req.body.isDefault); await log(req, 'default', t.id, { isDefault: t.isDefault }); res.json(t); }));
paymentTermRoutes.delete('/:id', can('customers:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const t = await svc.remove(cid(req), pid(req)); await log(req, 'delete', pid(req), { label: t.label }); res.status(204).end(); }));
