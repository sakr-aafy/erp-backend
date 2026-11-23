import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, type ExportFormat, MIME } from '../../services/export.service.js';
import * as svc from './product.service.js';
import * as cat from './catalog.service.js';
import { buildTemplate, importProducts } from './product-import.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;
const send = (res: Response, r: { body: Buffer; contentType: string; filename: string }) => {
  res.setHeader('Content-Type', r.contentType); res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(r.body);
};
const decimalsOf = async (req: Request) => {
  const s = await Setting.findOne({ companyId: cid(req) }).lean();
  return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
};

export const list = async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never));
export const get = async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)));
export async function create(req: Request, res: Response) {
  const p = await svc.create(cid(req), req.body);
  await audit(req, { action: 'create', resource: 'product', resourceId: p.id, meta: { reference: p.reference, belowCost: p.belowCost } });
  res.status(201).json(p);
}
export async function update(req: Request, res: Response) {
  const before = await svc.getOwn(cid(req), pid(req));
  const p = await svc.update(cid(req), pid(req), req.body);
  const price = ('salePriceMinor' in req.body || 'purchasePriceMinor' in req.body) && { prices: { saleFrom: before.salePriceMinor, saleTo: p.salePriceMinor, purchaseFrom: before.purchasePriceMinor, purchaseTo: p.purchasePriceMinor } };
  await audit(req, { action: 'update', resource: 'product', resourceId: p.id, meta: { fields: Object.keys(req.body), ...price } });
  res.json(p);
}
export async function setActive(req: Request, res: Response) {
  const p = await svc.setActive(cid(req), pid(req), req.body.isActive);
  await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'product', resourceId: p.id }); res.json(p);
}
export async function duplicate(req: Request, res: Response) {
  const p = await svc.duplicate(cid(req), pid(req), req.body);
  await audit(req, { action: 'duplicate', resource: 'product', resourceId: p.id, meta: { from: pid(req), reference: p.reference } }); res.status(201).json(p);
}
export async function remove(req: Request, res: Response) {
  const p = await svc.remove(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'product', resourceId: pid(req), meta: { reference: p.reference } }); res.status(204).end();
}
export async function exportList(req: Request, res: Response) {
  const q = req.query as unknown as svc.ProductFilters & { format: ExportFormat };
  const rows = await svc.exportRows(cid(req), q);
  const out = await renderTable(q.format, 'catalogue-produits', 'Catalogue produits', `${rows.length} article(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, svc.exportColumns(await decimalsOf(req), q.format === 'pdf'), rows);
  await audit(req, { action: 'export', resource: 'product', meta: { format: q.format, count: rows.length } }); send(res, out);
}
export async function template(req: Request, res: Response) {
  send(res, { body: await buildTemplate(), contentType: MIME.xlsx, filename: 'modele-import-articles.xlsx' });
}
export async function importFile(req: Request, res: Response) {
  if (!req.file) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Fichier manquant (champ « file »)' } }); return; }
  const q = req.query as unknown as { mode: 'create' | 'upsert'; dryRun: boolean };
  const report = await importProducts(cid(req), req.file.buffer, req.file.originalname, q);
  await audit(req, { action: q.dryRun ? 'import-check' : 'import', resource: 'product', success: report.errors.length === 0, meta: { mode: q.mode, total: report.total, created: report.created, updated: report.updated, errors: report.errors.length, file: req.file.originalname.slice(0, 100) } });
  res.json(report);
}
export const listSerials = async (req: Request, res: Response) => res.json(await svc.listSerials(cid(req), pid(req), req.query as never));
export async function addSerials(req: Request, res: Response) {
  const r = await svc.addSerials(cid(req), pid(req), req.body.serials, req.body.note);
  await audit(req, { action: 'add-serials', resource: 'product', resourceId: pid(req), meta: { count: r.added } }); res.status(201).json(r);
}
export async function removeSerial(req: Request, res: Response) {
  const s = await svc.removeSerial(cid(req), pid(req), req.params.serialId as string);
  await audit(req, { action: 'delete-serial', resource: 'product', resourceId: pid(req), meta: { serial: s.serialNumber } }); res.status(204).end();
}

// Catégories et unités
export const listCategories = async (req: Request, res: Response) => res.json(await cat.listCategories(cid(req)));
export async function createCategory(req: Request, res: Response) {
  const c = await cat.createCategory(cid(req), req.body); await audit(req, { action: 'create', resource: 'category', resourceId: c.id, meta: { name: c.name } }); res.status(201).json(c);
}
export async function renameCategory(req: Request, res: Response) {
  const c = await cat.renameCategory(cid(req), pid(req), req.body.name); await audit(req, { action: 'update', resource: 'category', resourceId: c.id }); res.json(c);
}
export async function deleteCategory(req: Request, res: Response) {
  const c = await cat.deleteCategory(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'category', resourceId: pid(req), meta: { name: c.name } }); res.status(204).end();
}
export const listUnits = async (req: Request, res: Response) => res.json(await cat.listUnits(cid(req)));
export async function createUnit(req: Request, res: Response) {
  const u = await cat.createUnit(cid(req), req.body); await audit(req, { action: 'create', resource: 'unit', resourceId: u.id, meta: { code: u.code } }); res.status(201).json(u);
}
export async function updateUnit(req: Request, res: Response) {
  const u = await cat.updateUnit(cid(req), pid(req), req.body); await audit(req, { action: 'update', resource: 'unit', resourceId: u.id }); res.json(u);
}
export async function deleteUnit(req: Request, res: Response) {
  const u = await cat.deleteUnit(cid(req), pid(req)); await audit(req, { action: 'delete', resource: 'unit', resourceId: pid(req), meta: { code: u.code } }); res.status(204).end();
}
