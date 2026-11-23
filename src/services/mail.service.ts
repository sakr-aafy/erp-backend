import nodemailer, { type Transporter } from 'nodemailer';
import { env, smtpConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

let transport: Transporter | null = null;

export const mailAvailable = () => transport !== null || smtpConfigured;

/** Permet d'injecter un transport (tests : jsonTransport). */
export function setMailTransport(t: Transporter | null) { transport = t; }

function getTransport(): Transporter {
  if (transport) return transport;
  if (!smtpConfigured) throw new AppError(503, 'Envoi d’e-mails non configuré (SMTP)', 'MAIL_DISABLED');
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string, html?: string, attachments?: { filename: string; content: Buffer; contentType?: string }[]) {
  await getTransport().sendMail({ from: env.SMTP_FROM ?? 'no-reply@localhost', to, subject, text, html, attachments });
  logger.info({ subject }, 'e-mail envoyé'); // jamais le contenu ni le destinataire complet
}
