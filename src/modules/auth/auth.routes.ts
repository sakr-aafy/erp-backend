import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { env } from '../../config/env.js';
import * as c from './auth.controller.js';
import * as v from './auth.validator.js';

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : env.AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Trop de tentatives, réessayez plus tard' } } });

// Le refresh est appelé à chaque chargement de page : limite plus large que les endpoints de saisie d'identifiants
const refreshLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 200, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Trop de requêtes, réessayez plus tard' } } });

export const authRoutes = Router();
authRoutes.post('/login', limiter, validate({ body: v.loginBody }), h(c.login));
authRoutes.get('/config', h(async (req, res) => c.config(req, res)));
authRoutes.post('/refresh', refreshLimiter, h(c.refresh));
authRoutes.post('/logout', h(c.logout));
authRoutes.get('/me', authenticate, h(c.me));
authRoutes.post('/change-password', authenticate, validate({ body: v.changePasswordBody }), h(c.changePassword));
authRoutes.post('/forgot-password', limiter, validate({ body: v.forgotBody }), h(c.forgotPassword));
authRoutes.post('/reset-password', limiter, validate({ body: v.resetBody }), h(c.resetPassword));
