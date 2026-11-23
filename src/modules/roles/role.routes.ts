import { Router } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import * as c from './role.controller.js';
import * as v from './role.validator.js';

export const roleRoutes = Router();
roleRoutes.use(authenticate);
roleRoutes.get('/catalog', can('roles:view'), c.catalog);
roleRoutes.get('/', can('roles:view'), h(c.list));
roleRoutes.get('/:id', can('roles:view'), validate({ params: v.idParam }), h(c.get));
roleRoutes.post('/', can('roles:create'), validate({ body: v.createRoleBody }), h(c.create));
roleRoutes.put('/:id', can('roles:update'), validate({ params: v.idParam, body: v.updateRoleBody }), h(c.update));
roleRoutes.delete('/:id', can('roles:delete'), validate({ params: v.idParam }), h(c.remove));
