import { enforcePriceRules } from '../products/product.rules.js';
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { Customer } from '../../models/customer.model.js';
import { AppError } from '../../utils/errors.js';
import { emailDocument, idParam, sendBody, sendPdf } from '../sales/document.http.js';
import { pdfOf } from '../sales/document.pdf.js';
import * as svc from './proforma.service.js';
import * as cycle from './proforma.cycle.js';
import * as v from './proforma.validator.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const actor = (r: Request) => ({ userId: r.auth!.userId, name: r.auth!.name });
export const proformaRoutes = Router();
proformaRoutes.use(authenticate);
proformaRoutes.get('/', can('proformas:view'), validate({ query: v.listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
proformaRoutes.get('/stats', can('proformas:view'), h(async (req: Request, res: Response) => res.json(await svc.stats(cid(req)))));
proformaRoutes.post('/', can('proformas:create'), validate({ body: v.proformaBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const p = await svc.create(cid(req), uid(req), req.body, actor(req)); await audit(req, { action: 'create', resource: 'proforma', resourceId: p.id, meta: { number: p.number, totalTtcMinor: p.totals.totalTtcMinor } }); res.status(201).json(p);
}));
proformaRoutes.get('/:id', can('proformas:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
proformaRoutes.put('/:id', can('proformas:update'), validate({ params: idParam, body: v.proformaBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const p = await svc.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'proforma', resourceId: p.id, meta: { number: p.number, totalTtcMinor: p.totals.totalTtcMinor } }); res.json(p);
}));
// ---- Cycle commercial : suivi, transmission et annulation ----
proformaRoutes.get('/:id/tracking', can('proformas:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await cycle.tracking(cid(req), pid(req)))));
proformaRoutes.get('/:id/cancellation', can('proformas:update'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await cycle.cancellation(cid(req), pid(req)))));
proformaRoutes.post('/:id/cancel', can('proformas:update'), validate({ params: idParam, body: v.cancelBody }), h(async (req: Request, res: Response) => {
  const p = await cycle.cancel(cid(req), pid(req), req.body.reason, actor(req));
  await audit(req, { action: 'cancel', resource: 'proforma', resourceId: p.id, meta: { number: p.number, reason: req.body.reason, quotation: p.effects.quotation, cancelledDeliveries: p.effects.draftDeliveries.map((d) => d.number) } }); res.json(p);
}));
proformaRoutes.post('/:id/mark-sent', can('proformas:update'), validate({ params: idParam, body: v.markSentBody }), h(async (req: Request, res: Response) => {
  const p = await svc.markSent(cid(req), pid(req), req.body, actor(req)); await audit(req, { action: 'mark-sent', resource: 'proforma', resourceId: p.id, meta: { number: p.number, method: req.body.method } }); res.json(p);
}));
proformaRoutes.delete('/:id', can('proformas:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const p = await svc.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'proforma', resourceId: pid(req), meta: { number: p.number } }); res.status(204).end();
}));
// La proforma se livre puis les BL se facturent : l'ancienne conversion directe est refusée (les factures déjà créées sont conservées)
proformaRoutes.post('/:id/convert-invoice', can('proformas:update'), () => { throw new AppError(410, 'Une proforma ne se convertit plus en facture : créez un bon de livraison, puis facturez-le', 'CONVERSION_REMOVED'); });
proformaRoutes.get('/:id/pdf', can('proformas:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const p = await svc.get(cid(req), pid(req)); const body = await pdfOf(cid(req), 'proforma', p);
  await audit(req, { action: 'print', resource: 'proforma', resourceId: p.id, meta: { number: p.number } }); sendPdf(res, body, `${p.number}.pdf`);
}));
proformaRoutes.post('/:id/send', can('proformas:update'), validate({ params: idParam, body: sendBody }), h(async (req: Request, res: Response) => {
  const p = await svc.get(cid(req), pid(req)); const c = await Customer.findById(p.customerId).lean();
  await emailDocument(req, res, { resource: 'proforma', id: p.id, label: 'Facture proforma', number: p.number, pdf: await pdfOf(cid(req), 'proforma', p), customerEmail: c?.email, markSent: (to) => svc.markSent(cid(req), p.id, { method: 'email', recipient: to }, actor(req)) });
}));
