import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { User } from '../../models/user.model.js';
import { Role } from '../../models/role.model.js';
import { Company } from '../../models/company.model.js';
import { ALL_PERMISSIONS } from '../../config/permissions.js';
import { hashPassword, verifyPassword } from '../../services/password.service.js';
import { issueRefreshToken, revokeAllUserTokens, revokeRefreshToken, revokeSession, rotateRefreshToken, sha256, signAccessToken, verifyAccessToken } from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../config/logger.js';
import { env, passwordResetEnabled } from '../../config/env.js';
import { mailAvailable, sendMail } from '../../services/mail.service.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
type Meta = { ip?: string; userAgent?: string };
const INVALID = 'Identifiants invalides';
// Hash factice pour égaliser le temps de réponse quand l'utilisateur n'existe pas
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5JkyeA0z6p5yq8Qm0nFk2m8yFvT8cWa';

export async function buildProfile(userId: Types.ObjectId | string) {
  const user = await User.findById(userId).lean();
  if (!user) throw AppError.unauthorized();
  const [role, company] = await Promise.all([Role.findById(user.roleId).lean(), Company.findById(user.companyId).lean()]);
  return {
    id: user._id.toString(), name: user.name, username: user.username, email: user.email,
    mustChangePassword: user.mustChangePassword, isPlatformAdmin: user.isPlatformAdmin,
    company: { id: user.companyId.toString(), name: company?.name ?? '' },
    role: { id: role?._id.toString() ?? '', name: role?.name ?? '', isSystem: role?.isSystem ?? false },
    permissions: role?.isSystem ? ALL_PERMISSIONS : role?.permissions ?? [],
  };
}

export async function login(email: string, password: string, meta: Meta) {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) { await verifyPassword(password, DUMMY_HASH); throw AppError.unauthorized(INVALID); }
  if (user.lockUntil && user.lockUntil > new Date()) throw new AppError(423, 'Compte temporairement verrouillé, réessayez plus tard', 'LOCKED');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    user.failedLogins += 1;
    if (user.failedLogins >= MAX_FAILED) { user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60_000); user.failedLogins = 0; }
    await user.save();
    throw AppError.unauthorized(INVALID);
  }
  if (!user.isActive) throw AppError.forbidden('Compte désactivé');
  const company = await Company.findById(user.companyId).lean();
  if (!company?.isActive) throw AppError.forbidden('Société désactivée');
  user.failedLogins = 0; user.lockUntil = undefined; user.lastLoginAt = new Date();
  await user.save();
  const session = await issueRefreshToken(user._id, meta);
  return { user, accessToken: signAccessToken(user._id, session.family), refreshToken: session.token, profile: await buildProfile(user._id) };
}

export async function refresh(raw: string, meta: Meta) {
  const { userId, token, family } = await rotateRefreshToken(raw, meta);
  const user = await User.findById(userId).lean();
  if (!user?.isActive) { await revokeAllUserTokens(userId); throw AppError.unauthorized('Compte désactivé'); }
  return { accessToken: signAccessToken(userId, family), refreshToken: token, profile: await buildProfile(userId) };
}

/** Déconnexion : révoque la session via le cookie de refresh et/ou l'access token présenté (révocation immédiate des deux). */
export async function logout(raw?: string, accessToken?: string) {
  let userId = raw ? await revokeRefreshToken(raw) : undefined;
  if (accessToken) {
    try {
      const { userId: uid, sid } = verifyAccessToken(accessToken);
      await revokeSession(sid);
      userId ??= new Types.ObjectId(uid);
    } catch { /* jeton invalide/expiré : rien à révoquer */ }
  }
  return userId;
}

export async function changePassword(userId: Types.ObjectId, current: string, next: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw AppError.badRequest('Mot de passe actuel incorrect');
  if (await verifyPassword(next, user.passwordHash)) throw AppError.badRequest('Le nouveau mot de passe doit être différent');
  user.passwordHash = await hashPassword(next); user.mustChangePassword = false; user.passwordChangedAt = new Date();
  await user.save();
  await revokeAllUserTokens(user._id);
}

/**
 * Génère un jeton de réinitialisation et l'envoie par e-mail (SMTP). Réponse identique que le compte existe ou non.
 * Désactivé en production tant que SMTP n'est pas configuré. En dev sans SMTP, le lien n'est journalisé que si DEV_LOG_RESET_TOKEN=true.
 * Renvoie le jeton uniquement hors production (tests).
 */
export async function forgotPassword(email: string) {
  if (!passwordResetEnabled) throw new AppError(503, 'La réinitialisation par e-mail n’est pas disponible. Contactez un administrateur.', 'RESET_DISABLED');
  const user = await User.findOne({ email, isActive: true });
  if (!user) return;
  const raw = crypto.randomBytes(32).toString('base64url');
  user.resetTokenHash = sha256(raw); user.resetTokenExpires = new Date(Date.now() + 3600_000);
  await user.save();
  const link = `${env.APP_URL}/reset-password?token=${raw}`;
  if (mailAvailable()) {
    await sendMail(user.email, 'Réinitialisation de votre mot de passe',
      `Bonjour ${user.name},\n\nPour choisir un nouveau mot de passe (lien valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`);
  } else if (env.DEV_LOG_RESET_TOKEN) {
    logger.warn({ link }, 'LIEN DE RÉINITIALISATION (développement, SMTP non configuré)');
  }
  return env.NODE_ENV === 'production' ? undefined : raw;
}

export async function resetPassword(token: string, newPassword: string) {
  const user = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } }).select('+resetTokenHash +resetTokenExpires');
  if (!user) throw AppError.badRequest('Jeton invalide ou expiré');
  user.passwordHash = await hashPassword(newPassword); user.mustChangePassword = false; user.passwordChangedAt = new Date();
  user.resetTokenHash = undefined; user.resetTokenExpires = undefined; user.failedLogins = 0; user.lockUntil = undefined;
  await user.save();
  await revokeAllUserTokens(user._id);
  return user;
}
