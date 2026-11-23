import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { AppError } from '../utils/errors.js';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** `sid` = famille du refresh token (identifiant de session) : révoquer la session invalide aussitôt l'access token. */
export function signAccessToken(userId: Types.ObjectId | string, sid: string): string {
  return jwt.sign({ sub: userId.toString(), sid }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] });
}
export function verifyAccessToken(token: string): { userId: string; sid: string } {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof p === 'string' || !p.sub || typeof p['sid'] !== 'string') throw new Error();
    return { userId: p.sub, sid: p['sid'] };
  } catch {
    throw AppError.unauthorized('Jeton invalide ou expiré');
  }
}

/** Crée un refresh token opaque (stocké haché). */
export async function issueRefreshToken(userId: Types.ObjectId, meta: { ip?: string; userAgent?: string }, family?: string) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const fam = family ?? crypto.randomUUID();
  await RefreshToken.create({
    userId, family: fam, tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000), ...meta,
  });
  return { token: raw, family: fam };
}

/** Une session est active tant qu'au moins un jeton de sa famille n'est ni révoqué ni expiré. */
export const isSessionActive = async (sid: string) =>
  !!(await RefreshToken.exists({ family: sid, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }));

/** Rotation : invalide l'ancien jeton, émet un nouveau. Rejeu d'un jeton déjà utilisé => révocation de la famille. */
export async function rotateRefreshToken(raw: string, meta: { ip?: string; userAgent?: string }) {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!doc || doc.revokedAt || doc.expiresAt < new Date()) throw AppError.unauthorized('Session expirée');
  if (doc.usedAt) {
    await RefreshToken.updateMany({ family: doc.family }, { revokedAt: new Date() });
    throw AppError.unauthorized('Session invalide');
  }
  // Marquage atomique pour éviter deux rotations concurrentes du même jeton
  const claimed = await RefreshToken.findOneAndUpdate({ _id: doc._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  if (!claimed) throw AppError.unauthorized('Session invalide');
  const next = await issueRefreshToken(doc.userId, meta, doc.family);
  return { userId: doc.userId, token: next.token, family: next.family };
}

/** Révoque toute la session du refresh token fourni ; renvoie l'utilisateur concerné s'il est connu. */
export const revokeRefreshToken = async (raw: string) => {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (doc) await RefreshToken.updateMany({ family: doc.family }, { revokedAt: new Date() });
  return doc?.userId;
};
export const revokeSession = (sid: string) => RefreshToken.updateMany({ family: sid }, { revokedAt: new Date() });
export const revokeAllUserTokens = (userId: Types.ObjectId | string) =>
  RefreshToken.updateMany({ userId, revokedAt: { $exists: false } }, { revokedAt: new Date() });
