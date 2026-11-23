import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  /** Limite globale de requêtes par IP et par minute (les routes d'authentification ont leurs propres limites, plus strictes). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(1_000_000).default(300),
  /** Tentatives de connexion / réinitialisation par IP et par fenêtre de 15 minutes (défaut strict : 20). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(3).max(100_000).default(20),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  BCRYPT_ROUNDS: z.coerce.number().min(4).max(15).default(12),
  SEED_COMPANY_NAME: z.string().default('Ma Société'),
  SEED_ADMIN_EMAIL: z.string().default('admin@example.com'),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  // URL publique de l'application (liens dans les e-mails)
  APP_URL: z.string().default('http://localhost:4200'),
  // SMTP (optionnel) : sans SMTP_HOST, l'envoi d'e-mails est désactivé
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Dev uniquement : journaliser le lien de réinitialisation quand SMTP n'est pas configuré
  /** Documentation Swagger (/api/docs) : désactivée par défaut en production (surface d'attaque), activée sinon ; forcer avec true/false. */
  SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
  DEV_LOG_RESET_TOKEN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
}).superRefine((v, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.SMTP_HOST && !v.SMTP_FROM) bad('SMTP_FROM', 'SMTP_FROM requis quand SMTP_HOST est défini');
  if (v.NODE_ENV !== 'production') return;
  // Garde-fous de production : refuse de démarrer avec une configuration dangereuse
  if (!v.COOKIE_SECURE) bad('COOKIE_SECURE', 'doit être true en production (cookie Secure, HTTPS obligatoire)');
  if (/change-?me|example|secret|password/i.test(v.JWT_ACCESS_SECRET + v.JWT_REFRESH_SECRET)) bad('JWT_ACCESS_SECRET', 'secrets JWT par défaut interdits en production');
  if (v.JWT_ACCESS_SECRET === v.JWT_REFRESH_SECRET) bad('JWT_REFRESH_SECRET', 'doit différer de JWT_ACCESS_SECRET');
  if (v.CORS_ORIGIN.includes('*') || !/^https:\/\//.test(v.CORS_ORIGIN.split(',')[0]!)) bad('CORS_ORIGIN', 'origines HTTPS explicites requises (pas de *)');
  if (v.BCRYPT_ROUNDS < 10) bad('BCRYPT_ROUNDS', 'minimum 10 en production');
  if (v.DEV_LOG_RESET_TOKEN) bad('DEV_LOG_RESET_TOKEN', 'interdit en production');
  if (!/^https:\/\//.test(v.APP_URL)) bad('APP_URL', 'doit être en HTTPS en production');
});

// En test, des secrets fixes sont fournis si absents.
const raw: Record<string, string | undefined> = { ...process.env };
// Valeurs collées dans un tableau de bord (Vercel…) : retire espaces et guillemets englobants (ex. "true" ou ' https://… ').
for (const [k, val] of Object.entries(raw)) if (typeof val === 'string') raw[k] = val.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
// Vercel sert toujours en HTTPS : le cookie de session est Secure par défaut (surchargeable explicitement).
if (raw.VERCEL) raw.COOKIE_SECURE ??= 'true';
if (raw.NODE_ENV === 'test') {
  raw.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789-0123456789';
  raw.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789-012345678';
  raw.BCRYPT_ROUNDS ??= '4';
}
const parsed = schema.safeParse(raw);
if (!parsed.success) {
  console.error('Configuration invalide :', z.prettifyError(parsed.error));
  process.exit(1);
}
export const env = parsed.data;
export const swaggerEnabled = (e: { NODE_ENV: string; SWAGGER_ENABLED?: string | undefined }) => (e.SWAGGER_ENABLED ? e.SWAGGER_ENABLED === 'true' : e.NODE_ENV !== 'production');

export const smtpConfigured = !!env.SMTP_HOST;
/** Réinitialisation par e-mail : désactivée en production tant que SMTP n'est pas configuré. */
export const passwordResetEnabled = smtpConfigured || env.NODE_ENV !== 'production';
