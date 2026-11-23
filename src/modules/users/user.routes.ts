import { Router } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import * as c from './user.controller.js';
import * as v from './user.validator.js';

export const userRoutes = Router();
userRoutes.use(authenticate);
userRoutes.get('/', can('users:view'), validate({ query: v.listQuery }), h(c.list));
userRoutes.get('/stats', can('users:view'), h(c.stats));
userRoutes.get('/:id', can('users:view'), validate({ params: v.idParam }), h(c.get));
userRoutes.post('/', can('users:create'), validate({ body: v.createUserBody }), h(c.create));
userRoutes.put('/:id', can('users:update'), validate({ params: v.idParam, body: v.updateUserBody }), h(c.update));
userRoutes.patch('/:id/active', can('users:update'), validate({ params: v.idParam, body: v.setActiveBody }), h(c.setActive));
userRoutes.post('/:id/reset-password', can('users:update'), validate({ params: v.idParam, body: v.resetPasswordBody }), h(c.resetPassword));
