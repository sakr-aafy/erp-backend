import mongoose from 'mongoose';
import express from 'express';
import helmetModule from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env, swaggerEnabled } from './config/env.js';
import { logger } from './config/logger.js';
import { openApiSpec } from './config/swagger.js';
import { noSqlSanitize } from './middlewares/sanitize.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { roleRoutes } from './modules/roles/role.routes.js';
import { companyRoutes } from './modules/companies/company.routes.js';
import { settingRoutes } from './modules/settings/setting.routes.js';
import { customerRoutes } from './modules/customers/customer.routes.js';
import { supplierRoutes } from './modules/suppliers/supplier.routes.js';
import { productRoutes, categoryRoutes, unitRoutes } from './modules/products/product.routes.js';
import { fiscalRoutes } from './modules/fiscal/fiscal.routes.js';
import { quotationRoutes } from './modules/quotations/quotation.routes.js';
import { proformaRoutes } from './modules/proformas/proforma.routes.js';
import { invoiceRoutes } from './modules/invoices/invoice.routes.js';
import { deliveryRoutes } from './modules/delivery-notes/delivery.routes.js';
import { salesRoutes } from './modules/sales/sales.routes.js';
import { warehouseRoutes, stockRoutes, transferRoutes, inventoryRoutes } from './modules/stock/stock.routes.js';
import { registerFinanceHandlers } from './modules/finance/finance.handlers.js';
import { registerStockHandlers } from './modules/stock/stock.handlers.js';
import { orderRoutes, receiptRoutes, purchaseInvoiceRoutes } from './modules/purchases/purchases.routes.js';
import { registerLogisticsReferences } from './modules/purchases/purchases.references.js';
import { importRoutes, exchangeRoutes } from './modules/imports/import.routes.js';
import { costRoutes } from './modules/costs/cost.routes.js';
import { registerSalesReferences } from './modules/sales/sales.references.js';
import { treasuryRoutes, supplierPaymentRoutes } from './modules/treasury/treasury.routes.js';
import { expenseRoutes, expenseCategoryRoutes } from './modules/expenses/expense.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { accountingRoutes } from './modules/accounting/accounting.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';

// Interop ESM/CJS : selon la résolution TypeScript (Vercel compile en CJS), le défaut de helmet est la fonction ou { default }.
const helmet = ((helmetModule as unknown as { default?: unknown }).default ?? helmetModule) as unknown as () => express.RequestHandler;

let referencesRegistered = false;
export function createApp() {
  if (!referencesRegistered) { registerSalesReferences(); registerLogisticsReferences(); referencesRegistered = true; registerStockHandlers(); registerFinanceHandlers(); }
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean), credentials: true }));
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test' }));
  app.use(rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 100_000 : env.RATE_LIMIT_PER_MIN, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(noSqlSanitize);

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  // Sonde de disponibilité (≠ liveness) : 200 seulement si MongoDB répond ; 503 sinon (orchestrateur / répartiteur de charge)
  app.get('/api/ready', async (_req, res) => {
    try { if (mongoose.connection.readyState !== 1) throw new Error('db'); await mongoose.connection.db!.admin().ping(); res.json({ status: 'ready', db: 'up', uptimeSeconds: Math.round(process.uptime()) }); }
    catch { res.status(503).json({ status: 'unavailable', db: 'down' }); }
  });
  if (swaggerEnabled(env)) app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/roles', roleRoutes);
  api.use('/companies', companyRoutes);
  api.use('/settings', settingRoutes);
  api.use('/audit-logs', auditRoutes);
  api.use('/fiscal', fiscalRoutes);
  api.use('/sales', salesRoutes);
  api.use('/quotations', quotationRoutes);
  api.use('/proformas', proformaRoutes);
  api.use('/invoices', invoiceRoutes);
  api.use('/delivery-notes', deliveryRoutes);
  api.use('/purchase-orders', orderRoutes);
  api.use('/goods-receipts', receiptRoutes);
  api.use('/purchase-invoices', purchaseInvoiceRoutes);
  api.use('/imports', importRoutes);
  api.use('/exchange-rates', exchangeRoutes);
  api.use('/costs', costRoutes);
  api.use('/warehouses', warehouseRoutes);
  api.use('/stock', stockRoutes);
  api.use('/stock-transfers', transferRoutes);
  api.use('/inventories', inventoryRoutes);
  api.use('/treasury', treasuryRoutes);
  api.use('/supplier-payments', supplierPaymentRoutes);
  api.use('/expenses', expenseRoutes);
  api.use('/expense-categories', expenseCategoryRoutes);
  api.use('/accounting', accountingRoutes);
  api.use('/reports', reportRoutes);
  api.use('/customers', customerRoutes);
  api.use('/suppliers', supplierRoutes);
  api.use('/products', productRoutes);
  api.use('/product-categories', categoryRoutes);
  api.use('/product-units', unitRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
