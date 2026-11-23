import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { paginationQuery } from '../../utils/pagination.js';
import { idParam } from '../sales/document.http.js';
import * as svc from './cost.service.js';

const cid = (r: Request) => r.auth!.companyId; const pid = (r: Request) => r.params.id as string;
export const costRoutes = Router();
costRoutes.use(authenticate);
costRoutes.get('/report', can('costCalculation:view'), validate({ query: svc.reportQuery }), h(async (req: Request, res: Response) => res.json(await svc.report(cid(req), req.query as never))));
costRoutes.post('/simulate', can('costCalculation:view'), validate({ body: svc.simulateBody }), h(async (req: Request, res: Response) => res.json(await svc.simulate(cid(req), req.body))));
costRoutes.get('/products/:id', can('costCalculation:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.sheet(cid(req), pid(req)))));
costRoutes.get('/products/:id/history', can('costCalculation:view'), validate({ params: idParam, query: paginationQuery }), h(async (req: Request, res: Response) => res.json(await svc.history(cid(req), pid(req), req.query as never))));
costRoutes.post('/products/:id/recalculate', can('costCalculation:update'), validate({ params: idParam, body: svc.recalcBody }), h(async (req: Request, res: Response) => {
  const r = await svc.recalculate(cid(req), req.auth!.userId, pid(req), req.body.justification);
  await audit(req, { action: 'recalculate-cost', resource: 'product', resourceId: pid(req), meta: { ...r, justification: req.body.justification } }); res.json(r);
}));
