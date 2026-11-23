import type { CookieOptions, Request, Response } from 'express';
import { env, passwordResetEnabled } from '../../config/env.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import * as svc from './auth.service.js';
import { User } from '../../models/user.model.js';

export const REFRESH_COOKIE = 'erp_rt';
const cookieOpts = (): CookieOptions => ({
  httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
});
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

export async function login(req: Request, res: Response) {
  try {
    const r = await svc.login(req.body.email, req.body.password, meta(req));
    res.cookie(REFRESH_COOKIE, r.refreshToken, cookieOpts());
    await audit(req, { action: 'login', resource: 'auth', companyId: r.user.companyId, userId: r.user._id, userName: r.user.name });
    res.json({ accessToken: r.accessToken, user: r.profile });
  } catch (e) {
    await audit(req, { action: 'login', resource: 'auth', success: false, meta: { email: req.body.email } });
    throw e;
  }
}
export async function refresh(req: Request, res: Response) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw AppError.unauthorized('Session absente');
  try {
    const r = await svc.refresh(raw, meta(req));
    res.cookie(REFRESH_COOKIE, r.refreshToken, cookieOpts());
    res.json({ accessToken: r.accessToken, user: r.profile });
  } catch (e) { res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' }); throw e; }
}
export async function logout(req: Request, res: Response) {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const userId = await svc.logout(req.cookies?.[REFRESH_COOKIE], bearer);
  if (userId) {
    const u = await User.findById(userId).lean();
    await audit(req, { action: 'logout', resource: 'auth', userId, companyId: u?.companyId, userName: u?.name });
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.status(204).end();
}
export async function me(req: Request, res: Response) {
  res.json(await svc.buildProfile(req.auth!.userId));
}
export async function changePassword(req: Request, res: Response) {
  await svc.changePassword(req.auth!.userId, req.body.currentPassword, req.body.newPassword);
  await audit(req, { action: 'change-password', resource: 'auth', resourceId: req.auth!.userId });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.status(204).end();
}
export const config = (_req: Request, res: Response) => res.json({ passwordResetEnabled });

export async function forgotPassword(req: Request, res: Response) {
  await svc.forgotPassword(req.body.email);
  const u = await User.findOne({ email: req.body.email }).lean();
  await audit(undefined, { action: 'forgot-password', resource: 'auth', companyId: u?.companyId, meta: { email: req.body.email } });
  res.json({ message: 'Si le compte existe, un lien de réinitialisation a été généré.' });
}
export async function resetPassword(req: Request, res: Response) {
  const user = await svc.resetPassword(req.body.token, req.body.newPassword);
  await audit(undefined, { action: 'reset-password', resource: 'auth', resourceId: user._id, companyId: user.companyId, userId: user._id, userName: user.name });
  res.status(204).end();
}
