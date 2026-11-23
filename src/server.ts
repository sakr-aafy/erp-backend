import { createApp } from './app.js';
import { connectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

import { expireOverdue as expireQuotations } from './modules/quotations/quotation.service.js';
import { expireOverdue as expireProformas } from './modules/proformas/proforma.service.js';

await connectDb();
// Expiration automatique des devis / proformas dont la validité est dépassée (en plus du contrôle à chaque lecture)
const sweep = () => Promise.all([expireQuotations(), expireProformas()]).catch((e) => logger.error({ err: e }, 'expiration des devis'));
void sweep(); setInterval(sweep, 3600_000).unref();
createApp().listen(env.PORT, () => logger.info(`API ERP sur http://localhost:${env.PORT} (docs : /api/docs)`));
