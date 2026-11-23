import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../utils/errors.js';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

/** Valide et remplace body/query/params par les valeurs parsées (types forcés, champs inconnus retirés). */
export const validate = (schemas: Schemas): RequestHandler => (req, _res, next) => {
  for (const key of ['body', 'query', 'params'] as const) {
    const schema = schemas[key];
    if (!schema) continue;
    const r = schema.safeParse(req[key]);
    if (!r.success) {
      return next(new AppError(422, 'Données invalides', 'VALIDATION_ERROR',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
    }
    // req.query est un getter en Express 5 : on le redéfinit
    Object.defineProperty(req, key, { value: r.data, writable: true, configurable: true, enumerable: true });
  }
  next();
};
