import request from 'supertest';
import { app, authed, companyWithAdmin, seedVat } from './helpers.js';

export const api = () => request(app);
export const J = (t: string) => ({ get: (u: string) => api().get(`/api/v1${u}`).set(authed(t)), post: (u: string, b: object = {}) => api().post(`/api/v1${u}`).set(authed(t)).send(b),
  put: (u: string, b: object = {}) => api().put(`/api/v1${u}`).set(authed(t)).send(b), del: (u: string) => api().delete(`/api/v1${u}`).set(authed(t)) });
export const today = () => new Date().toISOString().slice(0, 10);
export const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export type Ctx = Awaited<ReturnType<typeof salesCompany>>;
/** Société de test : TVA 19/13/7/0/exonéré (règles VALIDÉES insérées), unité, 3 articles + 1 service, 1 client. */
export async function salesCompany(name: string, email: string) {
  const c = await companyWithAdmin(name, email);
  await seedVat(c.companyId, [{ code: 'T19', ratePct: 19 }, { code: 'T13', ratePct: 13 }, { code: 'T7', ratePct: 7 }, { code: 'T0', regime: 'zero' }, { code: 'EXO', regime: 'exempt' }]);
  const j = J(c.token);
  const unitId = (await j.post('/product-units', { code: 'PCE', name: 'Pièce' })).body.id as string;
  const mk = async (reference: string, vatRateCode: string, salePriceMinor: number, kind = 'product') => (await j.post('/products', { reference, name: `Article ${reference}`, unitId, vatRateCode, purchasePriceMinor: 1000, salePriceMinor, kind })).body.id as string;
  const products = { a19: await mk('A19', 'T19', 100_000), b13: await mk('B13', 'T13', 50_000), c7: await mk('C7', 'T7', 20_000), svc: await mk('SRV', 'T19', 80_000, 'service') };
  // Non assujetti : les scénarios fiscaux activent explicitement la retenue (le défaut d’un nouveau client est « assujetti »)
  const customerId = (await j.post('/customers', { name: 'Client Test', taxId: 'CT-1', email: 'client@test.tn', paymentDelayDays: 30, subjectToWithholding: false })).body.id as string;
  return { ...c, j, unitId, products, customerId };
}
export const line = (productId: string, quantity = 1, extra: object = {}) => ({ productId, quantity, ...extra });
export const quoteBody = (ctx: Ctx, lines: object[], extra: object = {}) => ({ customerId: ctx.customerId, validUntil: plusDays(30), lines, ...extra });

import { Product } from '../src/models/product.model.js';
/** Logistique : 2 magasins, 1 fournisseur local, 1 fournisseur étranger, 1 article suivi par série. */
export async function logisticsCompany(name: string, email: string) {
  const c = await salesCompany(name, email);
  await c.j.put('/settings', { baseCurrency: 'TND', currencies: [{ code: 'TND', name: 'Dinar', symbol: 'DT', decimals: 3 }, { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 }] });
  const w1 = (await c.j.post('/warehouses', { code: 'WH1', name: 'Magasin principal' })).body.id as string;
  const w2 = (await c.j.post('/warehouses', { code: 'WH2', name: 'Dépôt secondaire' })).body.id as string;
  const supplierId = (await c.j.post('/suppliers', { name: 'Fournisseur Local', taxId: 'FL-1' })).body.id as string;
  const foreignSupplierId = (await c.j.post('/suppliers', { name: 'Foreign GmbH', taxId: 'DE-1', isForeign: true, currency: 'EUR' })).body.id as string;
  const serialProduct = (await c.j.post('/products', { reference: 'MACH-S', name: 'Machine série', unitId: c.unitId, vatRateCode: 'T19', purchasePriceMinor: 50_000, salePriceMinor: 90_000, hasSerial: true })).body.id as string;
  return { ...c, w1, w2, supplierId, foreignSupplierId, serialProduct };
}
export type LCtx = Awaited<ReturnType<typeof logisticsCompany>>;
/** Entrée manuelle de stock (coût unitaire en plus petite unité). */
export const stockIn = (c: LCtx, productId: string, quantity: number, unitCostMinor: number, warehouseId = c.w1, extra: object = {}) =>
  c.j.post('/stock/movements', { direction: 'in', productId, warehouseId, quantity, unitCostMinor, reason: 'Stock initial de test', ...extra });
export const stockOut = (c: LCtx, productId: string, quantity: number, warehouseId = c.w1, extra: object = {}) =>
  c.j.post('/stock/movements', { direction: 'out', productId, warehouseId, quantity, reason: 'Sortie de test', ...extra });
export const levelOf = async (c: LCtx, productId: string, warehouseId = c.w1) => { const l = (await c.j.get(`/stock/levels?productId=${productId}&warehouseId=${warehouseId}`)).body.items[0]; return l ? { qty: l.qty as number, value: l.valueMinor as number } : { qty: 0, value: 0 }; };
export const costOf = async (productId: string) => (await Product.findById(productId))!.costPriceMinor;
