import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import { exportFormat, objectId } from '../../utils/pagination.js';
import { Setting } from '../../models/setting.model.js';
import { renderTable, type Column, type ExportFormat } from '../../services/export.service.js';
import { dashboard } from './reports.dashboard.js';
import { canRun, catalog, findReport } from './reports.registry.js';
import { GROUP_BY, MAX_ROWS, type ColType, type Filters, type ReportDef, type Row } from './report.types.js';

const has = (r: Request) => (p: string) => r.auth!.permissions.has(p);
const cid = (r: Request) => r.auth!.companyId;
const date = z.coerce.date();
const filterShape = {
  from: date.optional(), to: date.optional(), asOf: date.optional(), groupBy: z.enum(GROUP_BY).default('month'),
  customerId: objectId.optional(), supplierId: objectId.optional(), productId: objectId.optional(), categoryId: objectId.optional(), warehouseId: objectId.optional(), accountId: objectId.optional(), userId: objectId.optional(),
  status: z.string().trim().max(40).optional(), currency: z.string().trim().regex(/^[A-Za-z]{3,4}$/).optional(), reason: z.string().trim().max(40).optional(),
};
const ordered = (v: { from?: Date | undefined; to?: Date | undefined }) => !v.from || !v.to || v.from <= v.to;
const filterQuery = z.object(filterShape).strict().refine(ordered, { message: 'La date de début doit précéder la date de fin', path: ['from'] });
const runQuery = z.object({ ...filterShape, page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict().refine(ordered, { message: 'La date de début doit précéder la date de fin', path: ['from'] });
const exportQuery = z.object({ ...filterShape, format: exportFormat }).strict().refine(ordered, { message: 'La date de début doit précéder la date de fin', path: ['from'] });
const dashQuery = z.object({ from: date.optional(), to: date.optional() }).strict().refine(ordered, { message: 'La date de début doit précéder la date de fin', path: ['from'] });

/** Ne conserve que les filtres que le rapport déclare (les autres sont ignorés, jamais appliqués silencieusement). */
function pick(def: ReportDef, q: Record<string, unknown>): Filters {
  const f: Record<string, unknown> = { groupBy: def.filters.includes('groupBy') ? q['groupBy'] : 'month' };
  for (const k of def.filters) { if (k === 'period') { f['from'] = q['from']; f['to'] = q['to']; } else if (k !== 'groupBy') f[k] = q[k]; }
  return f as unknown as Filters;
}
function authorize(req: Request, key: string): ReportDef {
  const def = findReport(key); if (!def) throw AppError.notFound('Rapport introuvable');
  if (!canRun(has(req), def)) throw AppError.forbidden(`Permission requise : ${['reports:view', ...def.perms].join(', ')}`);
  return def;
}
const decimalsOf = async (companyId: Request['auth'] extends infer A ? (A extends { companyId: infer C } ? C : never) : never) => { const s = await Setting.findOne({ companyId }).lean(); return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3; };
const cell = (t: ColType | undefined, v: unknown, d: number): string | number | Date | null => {
  if (v === null || v === undefined) return '';
  if (t === 'money') return Number(v) / 10 ** d; if (t === 'qty' || t === 'int' || t === 'pct') return Number(v); if (t === 'date') return v instanceof Date ? v : new Date(String(v)); return String(v);
};

export const reportRoutes = Router();
reportRoutes.use(authenticate);
// Tableau de bord : ouvert à tout utilisateur authentifié ; chaque bloc exige les permissions de son module source.
reportRoutes.get('/dashboard', validate({ query: dashQuery }), h(async (req: Request, res: Response) => res.json(await dashboard(cid(req), has(req), req.query as never))));
reportRoutes.get('/catalog', can('reports:view'), h(async (req: Request, res: Response) => res.json(catalog(has(req)))));
reportRoutes.get('/:key', can('reports:view'), validate({ query: runQuery }), h(async (req: Request, res: Response) => {
  const def = authorize(req, req.params.key as string); const q = req.query as unknown as Record<string, unknown> & { page: number; limit: number };
  const t0 = Date.now(); const r = await def.run({ companyId: cid(req), f: pick(def, q) });
  res.json({ key: def.key, title: def.title, group: def.group, description: def.description, columns: def.columns, filters: def.filters, rows: r.rows.slice((q.page - 1) * q.limit, q.page * q.limit), total: r.rows.length, page: q.page, limit: q.limit,
    totals: r.totals ?? null, kpis: r.kpis ?? [], chart: r.chart ?? null, note: r.note ?? null, truncated: !!r.truncated, generatedAt: new Date().toISOString(), tookMs: Date.now() - t0 });
}));
reportRoutes.get('/:key/export', can('reports:view'), validate({ query: exportQuery }), h(async (req: Request, res: Response) => {
  const def = authorize(req, req.params.key as string); const q = req.query as unknown as Record<string, unknown> & { format: ExportFormat };
  const f = pick(def, q); const r = await def.run({ companyId: cid(req), f }); const d = await decimalsOf(cid(req) as never);
  const cols: Column<Row>[] = def.columns.map((c) => ({ header: c.label, key: c.key, ...(c.type === 'money' || c.type === 'qty' || c.type === 'int' || c.type === 'pct' ? { align: 'right' as const } : {}), width: c.type === 'text' || !c.type ? 26 : 16, value: (row: Row) => cell(c.type, row[c.key], d) }));
  const rows = r.totals ? [...r.rows, r.totals] : r.rows;
  const sub = [f.from && `du ${f.from.toISOString().slice(0, 10)}`, f.to && `au ${f.to.toISOString().slice(0, 10)}`, `${r.rows.length} ligne(s)`, r.truncated && `limité à ${MAX_ROWS} lignes`].filter(Boolean).join(' — ');
  const out = await renderTable(q.format, def.key, def.title, sub, cols, rows);
  await audit(req, { action: 'export', resource: 'report', resourceId: def.key, meta: { report: def.key, format: q.format, rows: r.rows.length, filters: Object.keys(f).filter((k) => (f as unknown as Record<string, unknown>)[k] !== undefined) } });
  res.setHeader('Content-Type', out.contentType); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(out.body);
}));
void filterQuery;
