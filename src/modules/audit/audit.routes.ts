import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import { AuditLog } from '../../models/audit-log.model.js';
import { paginationQuery, escapeRegex } from '../../utils/pagination.js';

const query = paginationQuery.extend({
  resource: z.string().max(50).optional(), action: z.string().max(50).optional(),
  userId: z.string().regex(/^[a-f\d]{24}$/i).optional(), success: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
});

export const auditRoutes = Router();
auditRoutes.use(authenticate);
/** Ressources effectivement présentes dans le journal de la société (alimente le filtre de l'interface). */
auditRoutes.get('/resources', can('audit:view'), h(async (req, res) => res.json((await AuditLog.distinct('resource', { companyId: req.auth!.companyId })).sort())));
auditRoutes.get('/', can('audit:view'), validate({ query }), h(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof query>;
  const f: Record<string, unknown> = { companyId: req.auth!.companyId };
  if (q.resource) f.resource = q.resource;
  if (q.action) f.action = q.action;
  if (q.userId) f.userId = q.userId;
  if (q.success) f.success = q.success === 'true';
  if (q.from || q.to) f.at = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  if (q.q) f.userName = new RegExp(escapeRegex(q.q), 'i');
  const [items, total] = await Promise.all([
    AuditLog.find(f).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    AuditLog.countDocuments(f),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));
