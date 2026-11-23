import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { boolQuery, exportFormat, objectId, paginationQuery } from '../../utils/pagination.js';
import { Setting } from '../../models/setting.model.js';
import { MOVEMENT_KINDS } from '../../models/finance.model.js';
import { renderTable, type Column, type ExportFormat } from '../../services/export.service.js';
import { dateRange, idParam } from '../sales/document.http.js';
import * as t from './treasury.service.js';
import * as sp from './supplier-payment.service.js';

const cid = (r: Request) => r.auth!.companyId; const uid = (r: Request) => r.auth!.userId; const pid = (r: Request) => r.params.id as string;
const decimals = async (r: Request) => { const s = await Setting.findOne({ companyId: cid(r) }).lean(); return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3; };
const send = (res: Response, o: { body: Buffer; contentType: string; filename: string }) => { res.setHeader('Content-Type', o.contentType); res.setHeader('Content-Disposition', `attachment; filename="${o.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(o.body); };
const reason = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
type Mv = Awaited<ReturnType<typeof t.allMovements>>[number];
const money = (d: number) => (v: number) => v / 10 ** d;
const mvColumns = (d: number): Column<Mv>[] => [{ header: 'Date', key: 'date', width: 12, value: (m) => m.date }, { header: 'Compte', key: 'account', width: 20, value: (m) => m.accountName }, { header: 'Libellé', key: 'label', width: 40, value: (m) => m.label },
  { header: 'Référence', key: 'ref', width: 16, value: (m) => m.reference ?? m.source?.number ?? '' }, { header: 'Entrée', key: 'in', width: 14, align: 'right', value: (m) => (m.direction === 'in' ? money(d)(m.amountMinor) : '') },
  { header: 'Sortie', key: 'out', width: 14, align: 'right', value: (m) => (m.direction === 'out' ? money(d)(m.amountMinor) : '') }, { header: 'Rapproché', key: 'rec', width: 10, value: (m) => (m.reconciled ? 'Oui' : 'Non') }];

const mvQuery = paginationQuery.extend({ accountId: objectId.optional(), direction: z.enum(['in', 'out']).optional(), kind: z.enum(MOVEMENT_KINDS).optional(), reconciled: boolQuery.optional(), sourceId: objectId.optional(), ...dateRange });
export const treasuryRoutes = Router();
treasuryRoutes.use(authenticate);
// Comptes
treasuryRoutes.get('/accounts', can('treasury:view'), validate({ query: z.object({ type: z.enum(['bank', 'cash']).optional(), active: boolQuery.optional() }) }), h(async (req: Request, res: Response) => res.json(await t.listAccounts(cid(req), req.query as never))));
treasuryRoutes.post('/accounts', can('treasury:create'), validate({ body: t.accountBody }), h(async (req: Request, res: Response) => { const a = await t.createAccount(cid(req), req.body); await audit(req, { action: 'create', resource: 'treasury-account', resourceId: a.id, meta: { code: a.code, type: a.type, openingBalanceMinor: a.openingBalanceMinor } }); res.status(201).json(a); }));
treasuryRoutes.put('/accounts/:id', can('treasury:update'), validate({ params: idParam, body: t.accountUpdateBody }), h(async (req: Request, res: Response) => { const a = await t.updateAccount(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'treasury-account', resourceId: a.id, meta: Object.keys(req.body) as never }); res.json(a); }));
treasuryRoutes.patch('/accounts/:id/active', can('treasury:update'), validate({ params: idParam, body: z.object({ isActive: z.boolean() }).strict() }), h(async (req: Request, res: Response) => { const a = await t.setAccountActive(cid(req), pid(req), req.body.isActive); await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'treasury-account', resourceId: a.id }); res.json(a); }));
treasuryRoutes.get('/position', can('treasury:view'), h(async (req: Request, res: Response) => res.json(await t.position(cid(req)))));
treasuryRoutes.get('/consistency', can('treasury:view'), h(async (req: Request, res: Response) => res.json(await t.accountsConsistency(cid(req)))));
treasuryRoutes.get('/accounts/:id/statement', can('treasury:view'), validate({ params: idParam, query: z.object({ ...dateRange, format: z.enum(['xlsx', 'csv', 'pdf']).optional() }) }), h(async (req: Request, res: Response) => {
  const q = req.query as unknown as { from?: Date; to?: Date; format?: ExportFormat }; const s = await t.statement(cid(req), pid(req), q.from, q.to);
  if (!q.format) return void res.json(s);
  const d = await decimals(req); const m = money(d);
  const cols: Column<(typeof s.lines)[number]>[] = [...mvColumns(d).slice(0, 6) as never, { header: 'Solde', key: 'run', width: 14, align: 'right', value: (l) => m(l.runningMinor) }];
  const out = await renderTable(q.format, `releve-${s.account.code}`, `Relevé ${s.account.name}`, `Ouverture ${m(s.openingMinor)} — Clôture ${m(s.closingMinor)}`, cols, s.lines);
  await audit(req, { action: 'export', resource: 'treasury', meta: { report: 'statement', account: s.account.code, format: q.format } }); send(res, out);
}));
// Mouvements (immuables : lecture seule)
treasuryRoutes.get('/movements', can('treasury:view'), validate({ query: mvQuery }), h(async (req: Request, res: Response) => res.json(await t.listMovements(cid(req), req.query as never))));
treasuryRoutes.get('/movements/export', can('treasury:view'), validate({ query: z.object({ accountId: objectId.optional(), direction: z.enum(['in', 'out']).optional(), kind: z.enum(MOVEMENT_KINDS).optional(), reconciled: boolQuery.optional(), ...dateRange, format: exportFormat }) }), h(async (req: Request, res: Response) => {
  const f = req.query as unknown as { format: ExportFormat }; const rows = await t.allMovements(cid(req), req.query as never); const out = await renderTable(f.format, 'mouvements-tresorerie', 'Mouvements de trésorerie', `${rows.length} mouvement(s)`, mvColumns(await decimals(req)), rows);
  await audit(req, { action: 'export', resource: 'treasury', meta: { report: 'movements', format: f.format, count: rows.length } }); send(res, out);
}));
// Virements internes
treasuryRoutes.get('/transfers', can('treasury:view'), validate({ query: paginationQuery.extend({ accountId: objectId.optional() }) }), h(async (req: Request, res: Response) => res.json(await t.listTransfers(cid(req), req.query as never))));
treasuryRoutes.post('/transfers', can('treasury:create'), validate({ body: t.transferBody }), h(async (req: Request, res: Response) => { const r = await t.createTransfer(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'treasury-transfer', resourceId: r.id, meta: { number: r.number, amountMinor: r.amountMinor } }); res.status(201).json(r); }));
treasuryRoutes.post('/transfers/:id/cancel', can('treasury:validate'), validate({ params: idParam, body: reason }), h(async (req: Request, res: Response) => { const r = await t.cancelTransfer(cid(req), uid(req), pid(req), req.body.reason); await audit(req, { action: 'cancel', resource: 'treasury-transfer', resourceId: r.id, meta: { number: r.number, reason: req.body.reason } }); res.json(r); }));
// Rapprochement bancaire
treasuryRoutes.get('/reconciliations', can('treasury:view'), validate({ query: paginationQuery.extend({ accountId: objectId.optional() }) }), h(async (req: Request, res: Response) => res.json(await t.listReconciliations(cid(req), req.query as never))));
treasuryRoutes.get('/reconciliations/candidates/:id', can('treasury:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await t.candidates(cid(req), pid(req)))));
treasuryRoutes.get('/reconciliations/:id', can('treasury:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await t.getReconciliation(cid(req), pid(req)))));
treasuryRoutes.post('/reconciliations', can('treasury:validate'), validate({ body: t.reconcileBody }), h(async (req: Request, res: Response) => { const r = await t.reconcile(cid(req), uid(req), req.body); await audit(req, { action: 'reconcile', resource: 'treasury-reconciliation', resourceId: r.id, meta: { number: r.number, accountId: r.accountId, movements: r.movementCount, statementBalanceMinor: r.statementBalanceMinor } }); res.status(201).json(r); }));

// Règlements fournisseurs
export const supplierPaymentRoutes = Router();
supplierPaymentRoutes.use(authenticate);
supplierPaymentRoutes.get('/', can('treasury:view'), validate({ query: paginationQuery.extend({ supplierId: objectId.optional(), status: z.enum(['active', 'cancelled']).optional(), ...dateRange }) }), h(async (req: Request, res: Response) => res.json(await sp.list(cid(req), req.query as never))));
supplierPaymentRoutes.post('/', can('treasury:create'), validate({ body: sp.paymentBody }), h(async (req: Request, res: Response) => { const p = await sp.record(cid(req), uid(req), req.body); await audit(req, { action: 'create', resource: 'supplier-payment', resourceId: p.id, meta: { number: p.number, amountMinor: p.amountMinor, supplierId: p.supplierId } }); res.status(201).json(p); }));
supplierPaymentRoutes.get('/:id', can('treasury:view'), validate({ params: idParam }), h(async (req: Request, res: Response) => res.json(await sp.get(cid(req), pid(req)))));
supplierPaymentRoutes.post('/:id/cancel', can('treasury:validate'), validate({ params: idParam, body: reason }), h(async (req: Request, res: Response) => { const p = await sp.cancel(cid(req), uid(req), pid(req), req.body.reason); await audit(req, { action: 'cancel', resource: 'supplier-payment', resourceId: p.id, meta: { number: p.number, reason: req.body.reason } }); res.json(p); }));
