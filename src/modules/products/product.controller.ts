import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, toPdfFiche, type ExportFormat, MIME } from '../../services/export.service.js';
import * as svc from './product.service.js';
import * as cat from './catalog.service.js';
import { buildTemplate, importProducts } from './product-import.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;
export const actor = (req: Request): svc.Actor => ({ userId: req.auth!.userId, name: req.auth!.name });
export const access = (req: Request) => svc.accessOf(req.auth!.permissions);
const send = (res: Response, r: { body: Buffer; contentType: string; filename: string }) => {
  res.setHeader('Content-Type', r.contentType); res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(r.body);
};
const decimalsOf = async (req: Request) => {
  const s = await Setting.findOne({ companyId: cid(req) }).lean();
  return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
};

export const list = async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never, access(req)));
export const get = async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req), access(req)));
export async function create(req: Request, res: Response) {
  const p = await svc.create(cid(req), req.body, access(req), actor(req));
  await audit(req, { action: 'create', resource: 'product', resourceId: p.id, meta: { reference: p.reference, belowCost: p.belowCost } });
  res.status(201).json(p);
}
export async function update(req: Request, res: Response) {
  const before = await svc.getOwn(cid(req), pid(req));
  const p = await svc.update(cid(req), pid(req), req.body, access(req), actor(req));
  const price = ('salePriceMinor' in req.body || 'purchasePriceMinor' in req.body || 'minSalePriceMinor' in req.body) && { prices: { saleFrom: before.salePriceMinor, saleTo: p.salePriceMinor, purchaseFrom: before.purchasePriceMinor, purchaseTo: p.purchasePriceMinor, minFrom: before.minSalePriceMinor ?? null, minTo: p.minSalePriceMinor } };
  await audit(req, { action: 'update', resource: 'product', resourceId: p.id, meta: { fields: Object.keys(req.body), ...price } });
  res.json(p);
}
export async function setStatus(req: Request, res: Response) {
  const before = await svc.getOwn(cid(req), pid(req));
  const p = await svc.setStatus(cid(req), pid(req), req.body.status, actor(req), req.body.reason, access(req));
  await audit(req, { action: 'status', resource: 'product', resourceId: p.id, meta: { from: svc.effectiveStatus(before), to: p.status, ...(req.body.reason && { reason: req.body.reason }) } }); res.json(p);
}
export async function setActive(req: Request, res: Response) {
  const p = await svc.setActive(cid(req), pid(req), req.body.isActive, actor(req), access(req));
  await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'product', resourceId: p.id }); res.json(p);
}
export async function duplicate(req: Request, res: Response) {
  const p = await svc.duplicate(cid(req), pid(req), req.body, access(req), actor(req));
  await audit(req, { action: 'duplicate', resource: 'product', resourceId: p.id, meta: { from: pid(req), reference: p.reference } }); res.status(201).json(p);
}
export async function remove(req: Request, res: Response) {
  const p = await svc.remove(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'product', resourceId: pid(req), meta: { reference: p.reference } }); res.status(204).end();
}
export async function exportList(req: Request, res: Response) {
  const q = req.query as unknown as svc.ProductFilters & { format: ExportFormat }; const ac = access(req);
  const rows = await svc.exportRows(cid(req), q, ac);
  const out = await renderTable(q.format, 'catalogue-produits', 'Catalogue produits', `${rows.length} article(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, svc.exportColumns(await decimalsOf(req), ac, q.format === 'pdf'), rows);
  await audit(req, { action: 'export', resource: 'product', meta: { format: q.format, count: rows.length } }); send(res, out);
}
/** Fiche article imprimable : uniquement les informations que l'utilisateur est autorisé à voir (prix d'achat, marges, douane selon ses permissions). */
export async function fichePdf(req: Request, res: Response) {
  const ac = access(req); const p = await svc.get(cid(req), pid(req), ac); const d = await decimalsOf(req);
  const m = (v: number | null | undefined) => (v == null ? '—' : (v / 10 ** d).toFixed(d)); const n = (v: number | null | undefined, u = '') => (v == null ? '—' : `${v}${u}`);
  const pk = p.packaging;
  const sections: { title: string; rows: [string, string][] }[] = [
    { title: 'Général', rows: [['Code article', p.reference], ['Nom', p.name], ['Catégorie', [p.familyName, p.subName].filter(Boolean).join(' › ') || '—'], ['Marque', p.brand ?? '—'], ['Modèle', p.model ?? '—'], ['Unité de vente', p.unitCode ?? '—'], ['Type', p.kind === 'service' ? 'Service' : 'Produit'], ['Statut', p.statusLabel], ['Description', p.description ?? '—']] },
    ...(pk ? [{ title: 'Dimension de packaging et poids', rows: [['Dimensions (mm)', [pk.lengthMm, pk.widthMm, pk.heightMm].every((x) => x != null) ? `${pk.lengthMm} × ${pk.widthMm} × ${pk.heightMm}` : '—'], ['Poids net / brut (kg)', `${n(pk.netWeightKg)} / ${n(pk.grossWeightKg)}`], ['Type d’emballage', pk.typeLabel ?? pk.type ?? '—'], ['Nombre de colis', n(pk.parcelCount)], ['Volume unitaire (m³)', n(pk.volumeM3)], ['Volume total (m³)', n(pk.totalVolumeM3)]] as [string, string][] }] : []),
    { title: 'Prix', rows: [...(ac.purchase ? [['Prix d’achat HT', m(p.purchasePriceMinor)] as [string, string]] : []), ['Prix de vente HT', m(p.salePriceMinor)], ['TVA', p.vatRatePct == null ? p.vatRateCode : `${p.vatRateCode} (${p.vatRatePct} %)`], ['Prix de vente TTC', m(p.saleTtcMinor)], ['Prix minimum de vente HT', m(p.minSalePriceMinor)], ['Remise maximale', n(p.maxDiscountPct, ' %')],
      ...(ac.cost ? [['Coût de revient', m(p.effectiveCostMinor)], ['Marge HT', `${m(p.marginMinor)} (marge ${n(p.marginRatePct, ' %')}, marque ${n(p.markPct, ' %')})`]] as [string, string][] : [])] },
    ...(ac.customs && p.customs ? [{ title: 'Douane', rows: [['Code NGP fournisseur', p.customs.supplierHsCode ?? '—'], ['Code NGP tunisien', p.customs.tnHsCode ?? '—'], ['DD / FODEC / RPD (%)', `${n(p.customs.ddPct)} / ${n(p.customs.fodecPct)} / ${n(p.customs.rpdPct)}`], ['TVA', p.vatRatePct == null ? p.vatRateCode : `${p.vatRatePct} %`], ['Pays d’origine', p.customs.originCountry ?? '—'], ['Pays de provenance', p.customs.provenanceCountry ?? '—'], ['Règlement particulier', p.customs.specialRegulation ?? '—']] as [string, string][] }] : []),
  ];
  const body = await toPdfFiche(`Fiche article — ${p.reference}`, sections);
  await audit(req, { action: 'print', resource: 'product', resourceId: p.id });
  send(res, { body, contentType: 'application/pdf', filename: `fiche-article-${p.reference.replace(/[^\w.-]/g, '_')}.pdf` });
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
