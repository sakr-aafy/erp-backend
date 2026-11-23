import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { vatCatalog } from '../../services/fiscal.service.js';
import * as svc from './fiscal.service.js';
import * as v from './fiscal.validator.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;

export const fiscalRoutes = Router();
fiscalRoutes.use(authenticate);
// Catalogue TVA applicable aujourd'hui : lecture ouverte (lignes de documents, articles)
fiscalRoutes.get('/vat-catalog', h(async (req: Request, res: Response) => res.json(await vatCatalog(cid(req)))));
// Types d'opération de retenue à la source configurés ET validés (formulaire de facture)
fiscalRoutes.get('/withholding-types', h(async (req: Request, res: Response) => {
  const all = await svc.list(cid(req), { kind: 'withholding', status: 'validated' });
  res.json(all.filter((r) => r.isCurrent).map((r) => ({ code: r.code, label: r.label, ratePct: r.withholding?.ratePct, base: r.withholding?.base })));
}));
fiscalRoutes.get('/rules', can('settings:view'), validate({ query: v.listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
fiscalRoutes.post('/rules', can('settings:create'), validate({ body: v.ruleBody }), h(async (req: Request, res: Response) => {
  const r = await svc.createDraft(cid(req), uid(req), req.body);
  await audit(req, { action: 'create', resource: 'fiscal-rule', resourceId: r.id, meta: { kind: r.kind, code: r.code, effectiveFrom: r.effectiveFrom } }); res.status(201).json(r);
}));
fiscalRoutes.put('/rules/:id', can('settings:update'), validate({ params: v.idParam, body: v.ruleBody }), h(async (req: Request, res: Response) => {
  const r = await svc.updateDraft(cid(req), pid(req), req.body);
  await audit(req, { action: 'update', resource: 'fiscal-rule', resourceId: r.id, meta: { code: r.code } }); res.json(r);
}));
fiscalRoutes.delete('/rules/:id', can('settings:delete'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => {
  const r = await svc.deleteDraft(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'fiscal-rule', resourceId: pid(req), meta: { code: r.code } }); res.status(204).end();
}));
// La validation d'une règle fiscale est une décision sensible : permission dédiée « validate » + audit
fiscalRoutes.post('/rules/:id/validate', can('settings:validate'), validate({ params: v.idParam }), h(async (req: Request, res: Response) => {
  const r = await svc.validate(cid(req), uid(req), pid(req));
  await audit(req, { action: 'validate', resource: 'fiscal-rule', resourceId: r.id, meta: { kind: r.kind, code: r.code, effectiveFrom: r.effectiveFrom, vat: r.vat, withholding: r.withholding, stamp: r.stamp } }); res.json(r);
}));
fiscalRoutes.post('/templates/vat', can('settings:create'), validate({ body: v.templateBody }), h(async (req: Request, res: Response) => {
  const created = await svc.createVatTemplate(cid(req), uid(req), req.body.effectiveFrom);
  await audit(req, { action: 'create-template', resource: 'fiscal-rule', meta: { count: created.length } }); res.status(201).json(created);
}));
