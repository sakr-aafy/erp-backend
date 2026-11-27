import { enforcePriceRules } from '../products/product.rules.js';
import { Router, type Request, type Response } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { Customer } from '../../models/customer.model.js';
import { Invoice } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { emailDocument, idParam, sendBody, sendPdf } from '../sales/document.http.js';
import { pdfOf } from '../sales/document.pdf.js';
import * as svc from './invoice.service.js';
import * as v from './invoice.validator.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
export const invoiceRoutes = Router();
invoiceRoutes.use(authenticate);
invoiceRoutes.get('/', can('invoices:view'), validate({ query: v.listQuery }), h(async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never))));
invoiceRoutes.get('/summary', can('invoices:view'), validate({ query: v.summaryQuery }), h(async (req: Request, res: Response) => { const q = req.query as { from?: Date; to?: Date }; res.json(await svc.summary(cid(req), q.from, q.to)); }));
invoiceRoutes.get('/payments', can('invoices:view'), validate({ query: v.paymentsQuery }), h(async (req: Request, res: Response) => res.json(await svc.listPayments(cid(req), req.query as never))));
invoiceRoutes.post('/payments/:id/cancel', can('invoices:update'), validate({ params: idParam, body: v.cancelPaymentBody }), h(async (req: Request, res: Response) => {
  const p = await svc.cancelPayment(cid(req), uid(req), pid(req), req.body.reason); await audit(req, { action: 'cancel-payment', resource: 'payment', resourceId: p.id, meta: { invoiceId: p.invoiceId, amountMinor: p.amountMinor, reason: req.body.reason } }); res.json(p);
}));
invoiceRoutes.post('/from-delivery-notes', can('invoices:create'), validate({ body: v.fromDeliveryNotesBody }), h(async (req: Request, res: Response) => {
  const i = await svc.createFromDeliveryNotes(cid(req), uid(req), req.body.deliveryNoteIds, req.body.issueDate); await audit(req, { action: 'create', resource: 'invoice', resourceId: i.id, meta: { fromDeliveryNotes: req.body.deliveryNoteIds } }); res.status(201).json(i);
}));
invoiceRoutes.post('/', can('invoices:create'), validate({ body: v.invoiceBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const i = await svc.createDraft(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'invoice', resourceId: i.id, meta: { totalTtcMinor: i.totals.totalTtcMinor } }); res.status(201).json(i);
}));
invoiceRoutes.get('/:id', can('invoices:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)))));
invoiceRoutes.put('/:id', can('invoices:update'), validate({ params: idParam, body: v.invoiceBody }), enforcePriceRules, h(async (req: Request, res: Response) => {
  const i = await svc.updateDraft(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'invoice', resourceId: i.id, meta: { totalTtcMinor: i.totals.totalTtcMinor } }); res.json(i);
}));
invoiceRoutes.delete('/:id', can('invoices:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const i = await svc.removeDraft(cid(req), pid(req), { userId: req.auth!.userId, name: req.auth!.name }); await audit(req, { action: 'delete', resource: 'invoice', resourceId: pid(req), meta: { type: i.type } }); res.status(204).end();
}));
// Validation = acte fiscal irréversible (numéro légal, solde client) : permission dédiée
invoiceRoutes.post('/:id/validate', can('invoices:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const i = await svc.validate(cid(req), uid(req), pid(req));
  await audit(req, { action: 'validate', resource: i.type === 'credit_note' ? 'credit-note' : 'invoice', resourceId: i.id, meta: { number: i.number, totalPayableMinor: i.totals.totalPayableMinor, customerId: i.customerId } }); res.json(i);
}));
invoiceRoutes.post('/:id/credit-note', can('invoices:create'), validate({ params: idParam, body: v.creditNoteBody }), h(async (req: Request, res: Response) => {
  const c = await svc.createCreditNote(cid(req), uid(req), pid(req), req.body); await audit(req, { action: 'create', resource: 'credit-note', resourceId: c.id, meta: { invoiceId: pid(req), reason: req.body.reason } }); res.status(201).json(c);
}));
invoiceRoutes.post('/:id/payments', can('invoices:update'), validate({ params: idParam, body: v.paymentBody }), h(async (req: Request, res: Response) => {
  const r = await svc.recordPayment(cid(req), uid(req), pid(req), req.body);
  await audit(req, { action: 'record-payment', resource: 'payment', resourceId: r.payment.id, meta: { invoiceId: pid(req), amountMinor: r.payment.amountMinor, method: r.payment.method } }); res.status(201).json(r);
}));
invoiceRoutes.get('/:id/payments', can('invoices:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.listPayments(cid(req), { invoiceId: pid(req), page: 1, limit: 100 }))));
invoiceRoutes.get('/:id/consistency', can('invoices:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await svc.invoiceConsistency(cid(req), pid(req)))));
invoiceRoutes.get('/:id/pdf', can('invoices:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const i = await svc.get(cid(req), pid(req)); const body = await pdfOf(cid(req), 'invoice', i);
  await audit(req, { action: 'print', resource: 'invoice', resourceId: i.id, meta: { number: i.number } }); sendPdf(res, body, `${i.number ?? 'brouillon'}.pdf`);
}));
invoiceRoutes.post('/:id/send', can('invoices:update'), validate({ params: idParam, body: sendBody }), h(async (req: Request, res: Response) => {
  const i = await svc.get(cid(req), pid(req)); if (i.status !== 'validated') throw AppError.conflict('Seule une facture validée peut être envoyée');
  const c = await Customer.findById(i.customerId).lean();
  await emailDocument(req, res, { resource: 'invoice', id: i.id, label: i.type === 'credit_note' ? 'Facture d’avoir' : 'Facture', number: i.number!, pdf: await pdfOf(cid(req), 'invoice', i), customerEmail: c?.email, markSent: () => Invoice.updateOne({ _id: i.id }, { sentAt: new Date() }) });
}));
