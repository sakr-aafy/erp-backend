import { Router } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission, requirePlatformAdmin } from '../../middlewares/auth.js';
import * as c from './company.controller.js';
import * as v from './company.validator.js';

export const companyRoutes = Router();
companyRoutes.use(authenticate);
companyRoutes.get('/current', h(c.current));
companyRoutes.put('/current', requirePermission('settings:update'), validate({ body: v.updateCompanyBody }), h(c.updateCurrent));
// Multi-tenant : gestion des sociétés réservée à l'administrateur de plateforme
companyRoutes.get('/', requirePlatformAdmin, h(c.list));
companyRoutes.post('/', requirePlatformAdmin, validate({ body: v.createCompanyBody }), h(c.create));
companyRoutes.patch('/:id/active', requirePlatformAdmin, validate({ params: v.idParam, body: v.setActiveBody }), h(c.setActive));
