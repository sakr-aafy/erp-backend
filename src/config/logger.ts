import { pino } from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' && !process.env.DEBUG_LOG ? 'silent' : 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'password', '*.password', '*.newPassword',
      '*.currentPassword', '*.passwordHash', '*.token', '*.resetToken', '*.refreshToken', '*.accessToken', 'SEED_ADMIN_PASSWORD', 'SMTP_PASS'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development' && !process.env.VERCEL ? { transport: { target: 'pino-pretty' } } : {}),
});
