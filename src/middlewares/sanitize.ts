import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const hasOperatorKey = (v: unknown, depth = 0): boolean => {
  if (depth > 20 || v === null || typeof v !== 'object') return false;
  return Object.entries(v as Record<string, unknown>).some(([k, val]) => k.includes('$') || k.includes('.') || hasOperatorKey(val, depth + 1));
};

/** Protection NoSQL : rejette toute clé commençant par `$` ou contenant `.` dans body/query/params. */
export const noSqlSanitize: RequestHandler = (req, _res, next) => {
  if (hasOperatorKey(req.body) || hasOperatorKey(req.query) || hasOperatorKey(req.params)) {
    return next(AppError.badRequest('Requête invalide (opérateurs interdits)'));
  }
  next();
};
