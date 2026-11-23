import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { Setting } from '../../models/setting.model.js';
import { JOURNALS } from '../../models/finance.model.js';
import { renderTable, type ExportFormat } from '../../services/export.service.js';
import { dateRange, idParam } from '../sales/document.http.js';
import * as a from './accounting.service.js';
import * as ev from '../finance/finance.events.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const asOf = z.object({ asOf: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), page: z.coerce.number().int().min(1).default(1) });
const sl = (r: Request) => { const q = r.query as unknown as { limit: number; page: number }; return { limit: q.limit, offset: (q.page - 1) * q.limit }; };
export const accountingRoutes = Router();
accountingRoutes.use(authenticate);
accountingRoutes.get('/settings', can('accounting:view'), h(async (req: Request, res: Response) => res.json(await a.getSettings(cid(req)))));
accountingRoutes.put('/settings', can('accounting:update'), validate({ body: a.settingsBody }), h(async (req: Request, res: Response) => { const r = await a.saveSettings(cid(req), req.body); await audit(req, { action: 'update', resource: 'accounting-settings', meta: { keys: Object.keys(req.body) } }); res.json(r); }));
accountingRoutes.get('/entries', can('accounting:view'), validate({ query: paginationQuery.extend({ journal: z.enum(JOURNALS).optional(), sourceId: objectId.optional(), sourceType: z.string().max(40).optional(), ...dateRange }) }), h(async (req: Request, res: Response) => res.json(await a.listEntries(cid(req), req.query as never))));
accountingRoutes.get('/entries/export', can('accounting:view'), validate({ query: z.object({ journal: z.enum(JOURNALS).optional(), ...dateRange, format: exportFormat }) }), h(async (req: Request, res: Response) => {
  const f = req.query as unknown as { format: ExportFormat; journal?: string }; const entries = await a.allEntries(cid(req), req.query as never); const s = await Setting.findOne({ companyId: cid(req) }).lean(); const d = s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
  const rows = entries.flatMap((e) => e.lines.map((l) => ({ e, l })));
  const out = await renderTable(f.format, f.journal ? `journal-${f.journal}` : 'journaux', 'Journaux comptables', `${entries.length} écriture(s)`, [{ header: 'Journal', key: 'j', width: 10, value: (r) => r.e.journal }, { header: 'N°', key: 'n', width: 14, value: (r) => r.e.number }, { header: 'Date', key: 'd', width: 12, value: (r) => r.e.date },
    { header: 'Libellé', key: 'l', width: 40, value: (r) => r.e.label }, { header: 'Source', key: 's', width: 16, value: (r) => r.e.source?.number ?? '' }, { header: 'Compte', key: 'c', width: 14, value: (r) => r.l.accountCode ?? r.l.roleLabel },
    { header: 'Débit', key: 'db', width: 14, align: 'right', value: (r) => (r.l.debitMinor ? r.l.debitMinor / 10 ** d : '') }, { header: 'Crédit', key: 'cr', width: 14, align: 'right', value: (r) => (r.l.creditMinor ? r.l.creditMinor / 10 ** d : '') }], rows);
  await audit(req, { action: 'export', resource: 'accounting', meta: { report: 'entries', format: f.format, count: entries.length } });
  res.setHeader('Content-Type', out.contentType); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(out.body);
}));
accountingRoutes.get('/entries/:id', can('accounting:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await a.getEntry(cid(req), pid(req)))));
accountingRoutes.get('/trace/:id', can('accounting:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await a.trace(cid(req), pid(req)))));
accountingRoutes.get('/centralizer', can('accounting:view'), validate({ query: z.object(dateRange) }), h(async (req: Request, res: Response) => res.json(await a.centralizer(cid(req), req.query as never))));
accountingRoutes.get('/receivables', can('accounting:view'), validate({ query: asOf }), h(async (req: Request, res: Response) => res.json(await a.receivables(cid(req), (req.query as { asOf?: Date }).asOf, sl(req)))));
accountingRoutes.get('/payables', can('accounting:view'), validate({ query: asOf }), h(async (req: Request, res: Response) => res.json(await a.payables(cid(req), (req.query as { asOf?: Date }).asOf, sl(req)))));
accountingRoutes.get('/customers/:id/statement', can('accounting:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await a.thirdPartyStatement(cid(req), 'customer', pid(req)))));
accountingRoutes.get('/suppliers/:id/statement', can('accounting:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await a.thirdPartyStatement(cid(req), 'supplier', pid(req)))));
accountingRoutes.get('/consistency', can('accounting:view'), h(async (req: Request, res: Response) => res.json(await a.consistency(cid(req)))));
// Journal des événements financiers, reprise et réconciliation
accountingRoutes.get('/events', can('accounting:validate'), validate({ query: paginationQuery.extend({ status: z.enum(['processed', 'failed']).optional(), event: z.string().max(60).optional() }) }), h(async (req: Request, res: Response) => res.json(await ev.listEvents(cid(req), req.query as never))));
accountingRoutes.post('/events/:id/retry', can('accounting:validate'), validate({ params: idParam }), h(async (req: Request, res: Response) => { const r = await ev.retryEvent(cid(req), uid(req), pid(req)); await audit(req, { action: 'retry-event', resource: 'accounting', resourceId: pid(req), meta: { event: r.event, status: r.status } }); res.json(r); }));
accountingRoutes.post('/reconcile', can('accounting:validate'), h(async (req: Request, res: Response) => { const r = await ev.reconcile(cid(req), uid(req)); await audit(req, { action: 'reconcile', resource: 'accounting', meta: { replayed: r.replayed.length, failed: r.failed.length, consistent: r.accounting.consistent && r.treasury.consistent } }); res.json(r); }));
