import { enforcePriceRules } from '../products/product.rules.js';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { AppError } from '../../utils/errors.js';
import { mailAvailable } from '../../services/mail.service.js';
import { MAX_DOC_BYTES } from '../customers/customer.files.js';
import * as extra from './quotation.extra.service.js';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { emailDocument, idParam, sendBody, sendPdf } from '../sales/document.http.js';
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
  const q = await svc.markSent(cid(req), pid(req), actor(req), req.body); await audit(req, { action: 'mark-sent', resource: 'quotation', resourceId: q.id, meta: { number: q.number, version: q.version, method: req.body.method } }); res.json(await svc.get(cid(req), q.id));
}));
quotationRoutes.post('/:id/accept', can('quotations:update'), validate({ params: idParam, body: v.acceptBody }), h(async (req: Request, res: Response) => {
  const q = await svc.accept(cid(req), pid(req), actor(req), req.body.comment); await audit(req, { action: 'accept', resource: 'quotation', resourceId: q.id, meta: { number: q.number, version: q.version } }); res.json(await svc.get(cid(req), q.id));
}));
quotationRoutes.post('/:id/refuse', can('quotations:update'), validate({ params: idParam, body: v.refuseBody }), h(async (req: Request, res: Response) => {
  const q = await svc.refuse(cid(req), pid(req), actor(req), req.body.reason); await audit(req, { action: 'refuse', resource: 'quotation', resourceId: q.id, meta: { number: q.number, version: q.version } }); res.json(await svc.get(cid(req), q.id));
}));
quotationRoutes.post('/:id/duplicate', can('quotations:create'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const q = await svc.duplicate(cid(req), uid(req), pid(req), actor(req)); await audit(req, { action: 'duplicate', resource: 'quotation', resourceId: q.id, meta: { from: pid(req), number: q.number } }); res.status(201).json(q);
}));

// ---- Versions ----
quotationRoutes.get('/:id/versions', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json({ items: await svc.listVersions(cid(req), pid(req)) })));
quotationRoutes.post('/:id/versions', can('quotations:update'), validate({ params: idParam, body: v.newVersionBody }), h(async (req: Request, res: Response) => {
  const q = await svc.newVersion(cid(req), pid(req), actor(req), req.body); await audit(req, { action: 'new-version', resource: 'quotation', resourceId: q.id, meta: { number: q.number, version: q.version } }); res.status(201).json(q);
}));
quotationRoutes.post('/:id/versions/abandon', can('quotations:update'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const q = await svc.abandonVersion(cid(req), pid(req), actor(req)); await audit(req, { action: 'abandon-version', resource: 'quotation', resourceId: q.id, meta: { number: q.number, version: q.version } }); res.json(q);
}));
quotationRoutes.get('/:id/versions/:version', can('quotations:view'), validate({ params: v.versionParams }), h(async (req: Request, res: Response) => res.json(await svc.getVersion(cid(req), pid(req), Number(req.params.version)))));
quotationRoutes.get('/:id/versions/:version/pdf', can('quotations:view'), validate({ params: v.versionParams }), h(async (req: Request, res: Response) => {
  const r = await svc.pdf(cid(req), pid(req), Number(req.params.version));
  await audit(req, { action: 'print', resource: 'quotation', resourceId: pid(req), meta: { number: r.quote.number, version: r.version } }); sendPdf(res, r.body, r.filename);
}));

// ---- Documents ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 5 } });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo maximum)' : 'Téléversement invalide', err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST'));
  next(err);
});
quotationRoutes.get('/:id/documents', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await extra.listDocuments(cid(req), pid(req)))));
quotationRoutes.post('/:id/documents', can('quotations:update'), validate({ params: idParam }), uploadOne, validate({ body: v.docMetaBody }), h(async (req: Request, res: Response) => {
  if (!req.file) throw AppError.badRequest('Fichier requis (champ « file »)');
  const d = await extra.addDocument(cid(req), pid(req), req.file, req.body, actor(req));
  await audit(req, { action: 'document-upload', resource: 'quotation', resourceId: pid(req), meta: { file: d.name, type: d.type, size: d.size } }); res.status(201).json(d);
}));
quotationRoutes.put('/:id/documents/:docId', can('quotations:update'), validate({ params: v.docParams, body: v.docUpdateBody }), h(async (req: Request, res: Response) => {
  const d = await extra.updateDocument(cid(req), pid(req), req.params.docId as string, req.body, actor(req)); await audit(req, { action: 'document-update', resource: 'quotation', resourceId: pid(req), meta: { documentId: d.id } }); res.json(d);
}));
quotationRoutes.get('/:id/documents/:docId/file', can('quotations:view'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const { doc, stream, inline } = await extra.documentStream(cid(req), pid(req), req.params.docId as string);
  const asInline = req.query.disposition === 'inline' && inline;
  res.setHeader('Content-Type', doc.mime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'no-store');
  if (doc.size) res.setHeader('Content-Length', String(doc.size));
  await audit(req, { action: 'document-download', resource: 'quotation', resourceId: pid(req), meta: { file: doc.originalName } });
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }); stream.pipe(res);
}));
quotationRoutes.delete('/:id/documents/:docId', can('quotations:update'), validate({ params: v.docParams }), h(async (req: Request, res: Response) => {
  const d = await extra.removeDocument(cid(req), pid(req), req.params.docId as string, actor(req)); await audit(req, { action: 'document-delete', resource: 'quotation', resourceId: pid(req), meta: { file: d.originalName } }); res.status(204).end();
}));

// ---- Commentaires internes ----
const who = (req: Request): extra.Who => ({ ...actor(req), canWrite: req.auth!.permissions.has('quotations:update'), moderator: req.auth!.permissions.has('quotations:delete') });
quotationRoutes.get('/:id/comments', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await extra.listComments(cid(req), pid(req), who(req)))));
quotationRoutes.post('/:id/comments', can('quotations:update'), validate({ params: idParam, body: v.commentBody }), h(async (req: Request, res: Response) => res.status(201).json(await extra.addComment(cid(req), pid(req), req.body.body, who(req)))));
quotationRoutes.put('/:id/comments/:commentId', can('quotations:update'), validate({ params: v.commentParams, body: v.commentBody }), h(async (req: Request, res: Response) => res.json(await extra.editComment(cid(req), pid(req), req.params.commentId as string, req.body.body, who(req)))));
quotationRoutes.delete('/:id/comments/:commentId', can('quotations:update'), validate({ params: v.commentParams }), h(async (req: Request, res: Response) => res.json(await extra.archiveComment(cid(req), pid(req), req.params.commentId as string, who(req)))));

// ---- Conversion : un devis accepté devient une proforma, rien d'autre ----
quotationRoutes.post('/:id/convert-proforma', can('quotations:update'), can('proformas:create'), validate({ params: idParam, body: v.convertBody }), h(async (req: Request, res: Response) => {
  const r = await svc.convertToProforma(cid(req), uid(req), pid(req), req.body.validUntil, actor(req)); await audit(req, { action: 'convert-proforma', resource: 'quotation', resourceId: pid(req), meta: r }); res.status(201).json(r);
}));
// Anciennes conversions : refusées explicitement (les factures et bons de livraison déjà créés sont conservés)
quotationRoutes.post(['/:id/convert-invoice', '/:id/convert-delivery-note'], can('quotations:update'), () => { throw new AppError(410, 'Un devis se convertit uniquement en facture proforma', 'CONVERSION_REMOVED'); });
quotationRoutes.get('/:id/pdf', can('quotations:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => {
  const r = await svc.pdf(cid(req), pid(req));
  await audit(req, { action: 'print', resource: 'quotation', resourceId: pid(req), meta: { number: r.quote.number, version: r.version } }); sendPdf(res, r.body, r.filename);
}));
quotationRoutes.post('/:id/send', can('quotations:update'), validate({ params: idParam, body: sendBody }), h(async (req: Request, res: Response) => {
  if (!mailAvailable()) throw new AppError(503, 'Envoi d’e-mails non configuré (SMTP)', 'MAIL_DISABLED');
  // Contrôle du statut et verrouillage AVANT tout envoi
  const p = await svc.beginSend(cid(req), pid(req));
  try {
    const c = await Customer.findOne({ _id: p.quote.customerId, companyId: cid(req) }).lean();
    await emailDocument(req, res, { resource: 'quotation', id: pid(req), label: 'Devis', number: p.quote.number, pdf: p.pdf, customerEmail: c?.email,
      markSent: (to) => svc.completeSend(cid(req), p, actor(req), { method: 'email', recipient: to }) });
  } catch (e) { await p.release(); throw e; }
}));
