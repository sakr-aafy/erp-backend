import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { Company } from '../models/company.model.js';
import { isSessionActive, verifyAccessToken } from '../services/token.service.js';
import { AppError } from '../utils/errors.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ALL_PERMISSIONS } from '../config/permissions.js';

/**
 * Authentifie la requête. L'utilisateur, son rôle et sa société sont relus en base à CHAQUE requête :
 * un utilisateur désactivé (ou dont le rôle change) perd/modifie immédiatement ses accès.
 */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();
  const { userId, sid } = verifyAccessToken(header.slice(7));
  if (!Types.ObjectId.isValid(userId)) throw AppError.unauthorized();
  // Révocation immédiate : logout / changement de mot de passe / désactivation ferment la session côté serveur
  if (!(await isSessionActive(sid))) throw AppError.unauthorized('Session terminée');
  const user = await User.findById(userId).lean();
  if (!user || !user.isActive) throw AppError.unauthorized('Compte désactivé ou inexistant');
  const [role, company] = await Promise.all([Role.findById(user.roleId).lean(), Company.findById(user.companyId).lean()]);
  if (!role || !company?.isActive) throw AppError.unauthorized('Société ou rôle invalide');
  req.auth = {
    userId: user._id, companyId: user.companyId, name: user.name, email: user.email,
    roleId: role._id, roleName: role.name, isPlatformAdmin: user.isPlatformAdmin,
    permissions: new Set(role.isSystem ? ALL_PERMISSIONS : role.permissions),
  };
  next();
});

/** Vérifie une permission `module:action` côté serveur sur chaque endpoint protégé. */
export const requirePermission = (...perms: string[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) return next(AppError.unauthorized());
  if (!perms.every((p) => req.auth!.permissions.has(p))) return next(AppError.forbidden(`Permission requise : ${perms.join(', ')}`));
  next();
};

export const requirePlatformAdmin: RequestHandler = (req, _res, next) =>
  req.auth?.isPlatformAdmin ? next() : next(AppError.forbidden('Réservé à l’administrateur de plateforme'));
