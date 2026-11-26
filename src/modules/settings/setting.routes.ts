import { Router } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import * as c from './setting.controller.js';
import { estimateRateBody, updateSettingsBody } from './setting.validator.js';

export const settingRoutes = Router();
settingRoutes.use(authenticate);
// Données de référence non sensibles (devises, taux de TVA actifs) pour les formulaires métier : tout utilisateur authentifié
settingRoutes.get('/reference', h(c.reference));
settingRoutes.get('/', can('settings:view'), h(c.get));
settingRoutes.put('/', can('settings:update'), validate({ body: updateSettingsBody }), h(c.update));
// Taux estimatif de la fiche article : réservé aux utilisateurs autorisés à modifier les paramètres, tracé dans le journal d'audit
settingRoutes.put('/estimate-rates', can('settings:update'), validate({ body: estimateRateBody }), h(c.updateEstimateRate));
