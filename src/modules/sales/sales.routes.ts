import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { docFields, previewTotals, type DocType } from './document.builder.js';

const body = z.object({ docType: z.enum(['quotation', 'proforma', 'invoice', 'creditNote', 'deliveryNote']), issueDate: z.coerce.date().optional(), ...docFields }).strict();
const PERM: Record<DocType, string> = { quotation: 'quotations:create', proforma: 'proformas:create', invoice: 'invoices:create', creditNote: 'invoices:create', deliveryNote: 'deliveryNotes:create' };

/** Aperçu des totaux pour les formulaires : même moteur de calcul que l'enregistrement, aucun calcul côté client. */
export const salesRoutes = Router();
salesRoutes.use(authenticate);
salesRoutes.post('/calculate', validate({ body }), h(async (req: Request, res: Response) => {
  const b = req.body as z.infer<typeof body>;
  if (!req.auth!.permissions.has(PERM[b.docType]) && !req.auth!.permissions.has(PERM[b.docType].replace(':create', ':update'))) throw AppError.forbidden('Accès refusé');
  res.json(await previewTotals(req.auth!.companyId, b.docType, b, b.issueDate ?? new Date()));
}));
void requirePermission;
