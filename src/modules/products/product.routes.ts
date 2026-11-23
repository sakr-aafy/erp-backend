import type { RequestHandler } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { AppError } from '../../utils/errors.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import * as c from './product.controller.js';
import * as v from './product.validator.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(AppError.badRequest('Format non supporté : .xlsx ou .csv uniquement'))) });
const uploadOne: RequestHandler = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (5 Mo max)' : 'Fichier invalide', 'UPLOAD_ERROR'));
  next(err);
});

export const productRoutes = Router();
productRoutes.use(authenticate);
productRoutes.get('/', can('products:view'), validate({ query: v.listQuery }), h(c.list));
productRoutes.get('/export', can('products:view'), validate({ query: v.exportQuery }), h(c.exportList));
productRoutes.get('/import/template', can('products:view'), h(c.template));
// upsert nécessite aussi products:update : contrôlé dans le middleware ci-dessous
productRoutes.post('/import', can('products:create'), validate({ query: v.importQuery }), ((req, _res, next) =>
  (req.query as { mode?: string }).mode === 'upsert' && !req.auth!.permissions.has('products:update') ? next(AppError.forbidden('Permission requise : products:update')) : next()) as RequestHandler,
  uploadOne, h(c.importFile));
productRoutes.post('/', can('products:create'), validate({ body: v.createProductBody }), h(c.create));
productRoutes.get('/:id', can('products:view'), validate({ params: v.idParam }), h(c.get));
productRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.updateProductBody }), h(c.update));
productRoutes.patch('/:id/active', can('products:update'), validate({ params: v.idParam, body: v.activeBody }), h(c.setActive));
productRoutes.post('/:id/duplicate', can('products:create'), validate({ params: v.idParam, body: v.duplicateBody }), h(c.duplicate));
productRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.remove));
productRoutes.get('/:id/serials', can('products:view'), validate({ params: v.idParam, query: v.serialsQuery }), h(c.listSerials));
productRoutes.post('/:id/serials', can('products:update'), validate({ params: v.idParam, body: v.serialsBody }), h(c.addSerials));
productRoutes.delete('/:id/serials/:serialId', can('products:update'), validate({ params: v.serialParam }), h(c.removeSerial));

export const categoryRoutes = Router();
categoryRoutes.use(authenticate);
categoryRoutes.get('/', can('products:view'), h(c.listCategories));
categoryRoutes.post('/', can('products:create'), validate({ body: v.categoryBody }), h(c.createCategory));
categoryRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.categoryUpdateBody }), h(c.renameCategory));
categoryRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.deleteCategory));

export const unitRoutes = Router();
unitRoutes.use(authenticate);
unitRoutes.get('/', can('products:view'), h(c.listUnits));
unitRoutes.post('/', can('products:create'), validate({ body: v.unitBody }), h(c.createUnit));
unitRoutes.put('/:id', can('products:update'), validate({ params: v.idParam, body: v.unitUpdateBody }), h(c.updateUnit));
unitRoutes.delete('/:id', can('products:delete'), validate({ params: v.idParam }), h(c.deleteUnit));
