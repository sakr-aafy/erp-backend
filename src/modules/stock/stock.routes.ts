import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { Setting } from '../../models/setting.model.js';
import { renderTable, type ExportFormat } from '../../services/export.service.js';
import { minorInt } from '../parties/party.shared.js';
import { dateRange, idParam, sendPdf } from '../sales/document.http.js';
import * as wh from './warehouse.service.js';
import * as q from './stock.queries.js';
import * as tr from './transfer.service.js';
import * as inv from './inventory.service.js';
import * as ev from './stock.events.js';

void sendPdf; void boolQuery;
const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const decimals = async (r: Request) => { const s = await Setting.findOne({ companyId: cid(r) }).lean(); return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3; };
const send = (res: Response, o: { body: Buffer; contentType: string; filename: string }) => { res.setHeader('Content-Type', o.contentType); res.setHeader('Content-Disposition', `attachment; filename="${o.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(o.body); };

export const warehouseRoutes = Router();
warehouseRoutes.use(authenticate);
warehouseRoutes.get('/', can('inventory:view'), h(async (req: Request, res: Response) => res.json(await wh.list(cid(req)))));
warehouseRoutes.post('/', can('inventory:create'), validate({ body: wh.warehouseBody }), h(async (req: Request, res: Response) => { const w = await wh.create(cid(req), req.body); await audit(req, { action: 'create', resource: 'warehouse', resourceId: w.id, meta: { code: w.code } }); res.status(201).json(w); }));
warehouseRoutes.put('/:id', can('inventory:update'), validate({ params: idParam, body: wh.warehouseUpdateBody }), h(async (req: Request, res: Response) => { const w = await wh.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'warehouse', resourceId: w.id }); res.json(w); }));
warehouseRoutes.patch('/:id/active', can('inventory:update'), validate({ params: idParam, body: z.object({ isActive: z.boolean() }).strict() }), h(async (req: Request, res: Response) => { const w = await wh.setActive(cid(req), pid(req), req.body.isActive); await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'warehouse', resourceId: w.id }); res.json(w); }));
warehouseRoutes.delete('/:id', can('inventory:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const w = await wh.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'warehouse', resourceId: pid(req), meta: { code: w.code } }); res.status(204).end(); }));

const listQ = paginationQuery.extend({ warehouseId: objectId.optional(), productId: objectId.optional(), status: z.enum(['ok', 'low', 'out', 'alert']).optional() });
const mvQ = paginationQuery.extend({ productId: objectId.optional(), warehouseId: objectId.optional(), reason: z.enum(q.MOVEMENT_REASONS).optional(), direction: z.enum(['in', 'out']).optional(), sourceId: objectId.optional(), ...dateRange });
const exportQ = z.object({ q: z.string().max(100).optional(), warehouseId: objectId.optional(), status: z.enum(['ok', 'low', 'out', 'alert']).optional(), format: exportFormat });
const mvExportQ = z.object({ productId: objectId.optional(), warehouseId: objectId.optional(), reason: z.enum(q.MOVEMENT_REASONS).optional(), direction: z.enum(['in', 'out']).optional(), ...dateRange, format: exportFormat });

export const stockRoutes = Router();
stockRoutes.use(authenticate);
stockRoutes.get('/overview', can('inventory:view'), validate({ query: listQ }), h(async (req: Request, res: Response) => res.json(await q.overview(cid(req), req.query as never))));
stockRoutes.get('/overview/export', can('inventory:view'), validate({ query: exportQ }), h(async (req: Request, res: Response) => {
  const f = req.query as unknown as { q?: string; warehouseId?: string; status?: string; format: ExportFormat }; const rows = await q.overviewAll(cid(req), f);
  const out = await renderTable(f.format, 'etat-du-stock', 'État du stock', `${rows.length} article(s) — ${new Date().toLocaleDateString('fr-FR')}`, q.overviewColumns(await decimals(req)), rows);
  await audit(req, { action: 'export', resource: 'stock', meta: { report: 'overview', format: f.format, count: rows.length } }); send(res, out);
}));
stockRoutes.get('/levels', can('inventory:view'), validate({ query: listQ }), h(async (req: Request, res: Response) => res.json(await q.levels(cid(req), req.query as never))));
stockRoutes.get('/valuation', can('inventory:view'), h(async (req: Request, res: Response) => res.json(await q.valuation(cid(req)))));
stockRoutes.get('/movements', can('inventory:view'), validate({ query: mvQ }), h(async (req: Request, res: Response) => res.json(await q.movements(cid(req), req.query as never))));
stockRoutes.get('/movements/export', can('inventory:view'), validate({ query: mvExportQ }), h(async (req: Request, res: Response) => {
  const f = req.query as unknown as { format: ExportFormat }; const rows = await q.movementsAll(cid(req), req.query as never);
  const out = await renderTable(f.format, 'mouvements-de-stock', 'Mouvements de stock', `${rows.length} mouvement(s)`, q.movementColumns(await decimals(req)), rows);
  await audit(req, { action: 'export', resource: 'stock', meta: { report: 'movements', format: f.format, count: rows.length } }); send(res, out);
}));
const manualBody = z.object({ direction: z.enum(['in', 'out']), productId: objectId, warehouseId: objectId, quantity: z.number().gt(0).max(1e9), unitCostMinor: minorInt.optional(), reason: z.string().trim().min(3).max(300),
  serials: z.array(z.string().trim().min(1)).max(1000).optional(), allowNegativeStock: z.boolean().optional() }).strict();
stockRoutes.post('/movements', can('inventory:create'), validate({ body: manualBody }), h(async (req: Request, res: Response) => {
  if (req.body.allowNegativeStock && !req.auth!.permissions.has('inventory:validate')) throw AppError.forbidden('Autorisation de stock négatif : permission inventory:validate requise');
  const r = await q.manualMovement(cid(req), uid(req), req.body);
  await audit(req, { action: req.body.direction === 'in' ? 'manual-in' : 'manual-out', resource: 'stock', resourceId: r.id, meta: { productId: req.body.productId, quantity: req.body.quantity, reason: req.body.reason, forced: r.forced } }); res.status(201).json(r);
}));
// Reprise et réconciliation (administration du stock)
stockRoutes.get('/events', can('inventory:validate'), validate({ query: paginationQuery.extend({ status: z.enum(['processed', 'failed']).optional(), event: z.string().max(60).optional() }) }), h(async (req: Request, res: Response) => res.json(await ev.listEvents(cid(req), req.query as never))));
stockRoutes.post('/events/:id/retry', can('inventory:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const r = await ev.retryEvent(cid(req), uid(req), pid(req)); await audit(req, { action: 'retry-event', resource: 'stock', resourceId: pid(req), meta: { event: r.event, status: r.status } }); res.json(r); }));
stockRoutes.post('/reconcile', can('inventory:validate'), h(async (req: Request, res: Response) => { const r = await ev.reconcile(cid(req), uid(req)); await audit(req, { action: 'reconcile', resource: 'stock', meta: { replayed: r.replayed.length, failed: r.failed.length, consistent: r.consistency.consistent } }); res.json(r); }));
stockRoutes.get('/consistency', can('inventory:view'), h(async (req: Request, res: Response) => res.json(await ev.consistency(cid(req)))));

export const transferRoutes = Router();
transferRoutes.use(authenticate);
transferRoutes.get('/', can('inventory:view'), validate({ query: paginationQuery.extend({ status: z.enum(['draft', 'validated']).optional() }) }), h(async (req: Request, res: Response) => res.json(await tr.list(cid(req), req.query as never))));
transferRoutes.post('/', can('inventory:create'), validate({ body: tr.transferBody }), h(async (req: Request, res: Response) => { const t = await tr.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'stock-transfer', resourceId: t.id, meta: { number: t.number } }); res.status(201).json(t); }));
transferRoutes.get('/:id', can('inventory:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await tr.get(cid(req), pid(req)))));
transferRoutes.put('/:id', can('inventory:update'), validate({ params: idParam, body: tr.transferBody }), h(async (req: Request, res: Response) => { const t = await tr.update(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'stock-transfer', resourceId: t.id }); res.json(t); }));
transferRoutes.delete('/:id', can('inventory:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const t = await tr.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'stock-transfer', resourceId: pid(req), meta: { number: t.number } }); res.status(204).end(); }));
transferRoutes.post('/:id/validate', can('inventory:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const t = await tr.validate(cid(req), uid(req), pid(req)); await audit(req, { action: 'validate', resource: 'stock-transfer', resourceId: t.id, meta: { number: t.number } }); res.json(t); }));

export const inventoryRoutes = Router();
inventoryRoutes.use(authenticate);
inventoryRoutes.get('/', can('inventory:view'), validate({ query: paginationQuery.extend({ status: z.enum(['draft', 'validated']).optional(), warehouseId: objectId.optional() }) }), h(async (req: Request, res: Response) => res.json(await inv.list(cid(req), req.query as never))));
inventoryRoutes.post('/', can('inventory:create'), validate({ body: inv.createBody }), h(async (req: Request, res: Response) => { const i = await inv.create(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'inventory', resourceId: i.id, meta: { number: i.number } }); res.status(201).json(i); }));
inventoryRoutes.get('/:id', can('inventory:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await inv.get(cid(req), pid(req)))));
inventoryRoutes.put('/:id', can('inventory:update'), validate({ params: idParam, body: inv.updateBody }), h(async (req: Request, res: Response) => { const i = await inv.saveCounts(cid(req), pid(req), req.body); await audit(req, { action: 'count', resource: 'inventory', resourceId: i.id }); res.json(i); }));
inventoryRoutes.delete('/:id', can('inventory:delete'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const i = await inv.remove(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'inventory', resourceId: pid(req), meta: { number: i.number } }); res.status(204).end(); }));
inventoryRoutes.post('/:id/validate', can('inventory:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const i = await inv.validate(cid(req), uid(req), pid(req)); await audit(req, { action: 'validate', resource: 'inventory', resourceId: i.id, meta: { number: i.number, variances: i.lines.filter((l) => l.appliedDelta !== 0).length, reason: i.reason } }); res.json(i); }));
