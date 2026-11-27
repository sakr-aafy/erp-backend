import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { audit } from '../../services/audit.service.js';
import { mailAvailable, sendMail } from '../../services/mail.service.js';
import { AppError } from '../../utils/errors.js';
import { boolQuery, objectId, paginationQuery } from '../../utils/pagination.js';

export const sendPdf = (res: Response, body: Buffer, filename: string) => {
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(body);
};
export const sendBody = z.object({ to: z.email().optional(), message: z.string().trim().max(2000).optional() }).strict();

/** Envoi d'un document par e-mail (PDF joint). Nécessite SMTP ; le destinataire par défaut est l'e-mail du client. */
export async function emailDocument(req: Request, res: Response, p: { resource: string; id: string; label: string; number: string; pdf: Buffer; customerEmail?: string | null | undefined; markSent: (to: string) => Promise<unknown> }) {
  if (!mailAvailable()) throw new AppError(503, 'Envoi d’e-mails non configuré (SMTP)', 'MAIL_DISABLED');
  const to = (req.body as { to?: string }).to ?? p.customerEmail;
  if (!to) throw AppError.badRequest('Aucune adresse e-mail : renseignez l’e-mail du client ou le destinataire');
  const msg = (req.body as { message?: string }).message;
  try {
    await sendMail(to, `${p.label} ${p.number}`, `${msg ? msg + '\n\n' : ''}Veuillez trouver ci-joint ${p.label.toLowerCase()} ${p.number}.`, undefined,
      [{ filename: `${p.number}.pdf`, content: p.pdf, contentType: 'application/pdf' }]);
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Aucun envoi n'est simulé : le document garde son statut
    logger.warn({ err: e, resource: p.resource, number: p.number }, 'échec de l’envoi d’e-mail');
    throw new AppError(502, 'L’envoi de l’e-mail a échoué : le document n’a pas été marqué comme envoyé. Vérifiez la configuration SMTP et le destinataire.', 'MAIL_FAILED');
  }
  await p.markSent(to);
  await audit(req, { action: 'send', resource: p.resource, resourceId: p.id, meta: { number: p.number } });
  res.json({ sent: true, to });
}

export const dateRange = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };
export const idParam = z.object({ id: objectId });
export const baseListQuery = paginationQuery.extend({ customerId: objectId.optional(), ...dateRange });
export { boolQuery };
export const rangeFilter = (from?: Date, to?: Date) => (from || to ? { ...(from && { $gte: from }), ...(to && { $lte: to }) } : undefined);
