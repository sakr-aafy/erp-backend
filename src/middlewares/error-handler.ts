import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(AppError.notFound('Route introuvable'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err?.code === 11000) {
    const keys = Object.keys(err.keyPattern ?? {}).filter((k) => k !== 'companyId');
    const label: Record<string, string> = { taxId: 'Ce matricule fiscal est déjà utilisé', reference: 'Cette référence est déjà utilisée', serialNumber: 'Numéro de série déjà enregistré',
      email: 'Cette valeur est déjà utilisée (e-mail)', username: 'Cet identifiant est déjà utilisé', code: 'Ce code est déjà utilisé', name: 'Ce nom existe déjà' };
    e = new AppError(409, label[keys[keys.length - 1] ?? ''] ?? `Valeur déjà utilisée : ${keys.join(', ') || 'doublon'}`, 'DUPLICATE');
  } else if (err instanceof mongoose.Error.CastError) e = AppError.badRequest('Identifiant invalide');
  else if (err?.type === 'entity.parse.failed') e = AppError.badRequest('JSON invalide');
  else if (err?.type === 'entity.too.large') e = new AppError(413, 'Corps de requête trop volumineux', 'PAYLOAD_TOO_LARGE');
  else {
    logger.error({ err, path: req.path }, 'erreur non gérée');
    e = new AppError(500, 'Erreur interne du serveur', 'INTERNAL');
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
};
