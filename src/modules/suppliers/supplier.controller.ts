import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, toPdfFiche, type ExportFormat } from '../../services/export.service.js';
import { AppError } from '../../utils/errors.js';
import { addressRows } from '../parties/delivery-address.js';
import * as svc from './supplier.service.js';

export const cid = (req: Request) => req.auth!.companyId;
export const pid = (req: Request) => req.params.id as string;
export const perms = (req: Request) => req.auth!.permissions;
export const actor = (req: Request): svc.Actor => ({ userId: req.auth!.userId, name: req.auth!.name });
const view = (req: Request, d: svc.Dto) => svc.redact(d, perms(req));

/** Sans permission financière : aucun filtre ni tri sur les montants (sinon ils seraient déductibles). */
const guardAmounts = <T extends { withBalance?: boolean | undefined; sort?: string | undefined }>(req: Request): T => {
  const q = { ...(req.query as unknown as T) };
  if (svc.canSeeAmounts(perms(req))) return q;
  if (q.withBalance) throw AppError.forbidden('Permission financière requise pour filtrer par solde');
  if (q.sort && /balanceMinor/.test(q.sort)) delete q.sort;
  return q;
};

export async function list(req: Request, res: Response) {
  const out = await svc.list(cid(req), guardAmounts<Parameters<typeof svc.list>[1]>(req));
  const amounts = svc.canSeeAmounts(perms(req));
  res.json({ ...out, items: out.items.map((s) => view(req, s)), ...(!amounts && { summary: { totalBalanceMinor: null } }) });
}
export const get = async (req: Request, res: Response) => res.json(view(req, await svc.get(cid(req), pid(req))));
export async function create(req: Request, res: Response) {
  const s = await svc.create(cid(req), req.body, actor(req));
  await audit(req, { action: 'create', resource: 'supplier', resourceId: s.id, meta: { name: s.name, code: s.code } });
  res.status(201).json(view(req, s));
}
export async function update(req: Request, res: Response) {
  const before = await svc.get(cid(req), pid(req));
  const s = await svc.update(cid(req), pid(req), req.body, actor(req));
  await audit(req, { action: 'update', resource: 'supplier', resourceId: s.id, meta: { fields: Object.keys(req.body), ...('blockThresholdMinor' in req.body && { blockThreshold: { from: before.blockThresholdMinor, to: s.blockThresholdMinor } }) } });
  res.json(view(req, s));
}
export async function setStatus(req: Request, res: Response) {
  const { status, reason } = req.body as { status: svc.SupplierStatus; reason?: string };
  const s = await svc.setStatus(cid(req), pid(req), status, actor(req), reason);
  await audit(req, { action: 'status', resource: 'supplier', resourceId: s.id, meta: { status, ...(reason && { reason }) } });
  res.json(view(req, s));
}
export async function archive(req: Request, res: Response) {
  const s = await svc.setArchived(cid(req), pid(req), true, actor(req)); await audit(req, { action: 'archive', resource: 'supplier', resourceId: s.id }); res.json(view(req, s));
}
export async function reactivate(req: Request, res: Response) {
  const s = await svc.setArchived(cid(req), pid(req), false, actor(req)); await audit(req, { action: 'reactivate', resource: 'supplier', resourceId: s.id }); res.json(view(req, s));
}
export async function remove(req: Request, res: Response) {
  const s = await svc.getOwn(cid(req), pid(req));
  await svc.remove(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'supplier', resourceId: pid(req), meta: { name: s.name } });
  res.status(204).end();
}
export const decimalsOf = async (req: Request) => {
  const s = await Setting.findOne({ companyId: cid(req) }).lean();
  return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
};
export const send = (res: Response, r: { body: Buffer; contentType: string; filename: string }) => {
  res.setHeader('Content-Type', r.contentType); res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(r.body);
};
export async function exportList(req: Request, res: Response) {
  const q = guardAmounts<svc.SupplierFilters & { format: ExportFormat; sort?: string }>(req);
  const rows = await svc.exportRows(cid(req), q);
  const name = q.withBalance ? 'balance-fournisseurs' : 'fournisseurs';
  const cols = svc.exportColumns(await decimalsOf(req), svc.canSeeAmounts(perms(req)));
  // PDF : les colonnes les plus larges sont réservées au tableur
  const out = await renderTable(q.format, name, q.withBalance ? 'Balance fournisseurs' : 'Liste des fournisseurs', `${rows.length} fournisseur(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`,
    q.format === 'pdf' ? cols.filter((c) => ['code', 'name', 'category', 'taxId', 'phone', 'city', 'balance', 'status'].includes(c.key)) : cols, rows);
  await audit(req, { action: 'export', resource: 'supplier', meta: { format: q.format, count: rows.length, withBalance: !!q.withBalance } });
  send(res, out);
}
export async function fichePdf(req: Request, res: Response) {
  const s = view(req, await svc.get(cid(req), pid(req))); const d = await decimalsOf(req);
  const m = (v: number | null) => (v == null ? '—' : (v / 10 ** d).toFixed(d));
  const a = s.address; const tel = (x: { display: string } | null) => x?.display ?? '';
  const body = await toPdfFiche(`Fiche fournisseur — ${s.name}`, [
    { title: 'Identification', rows: [['Code fournisseur', s.code ?? ''], ['Catégorie', s.categoryName ?? 'Non classé'], ['Raison sociale', s.name], ['Nom commercial', s.tradeName ?? ''], ['Matricule fiscal', s.taxId ?? ''], ['Fournisseur étranger', s.isForeign ? `Oui (${s.currency ?? '—'})` : 'Non'], ['Statut', s.statusLabel]] },
    { title: 'Coordonnées', rows: [['Adresse', [a.street, a.postalCode, a.city, a.country].filter(Boolean).join(', ')], ['Téléphone', tel(s.phoneInfo)], ['Téléphone secondaire', tel(s.secondaryPhoneInfo)], ['E-mail', s.email ?? ''], ['Site web', s.website ?? ''], ['Google Maps', s.mapsUrl ?? ''],
      ['Facebook', s.social.facebook ?? ''], ['LinkedIn', s.social.linkedin ?? ''], ['Instagram', s.social.instagram ?? '']] },
    { title: 'Adresses de livraison et d’enlèvement', rows: addressRows(s.deliveryAddresses) },
    { title: 'Conditions d’achat', rows: [['Délai de livraison habituel', s.leadTimeDays == null ? '' : `${s.leadTimeDays} jour(s)`], ['Conditions de paiement', s.paymentTerms ?? ''], ...(s.paymentTermsCustom ? [] : [['Délai de paiement', `${s.paymentDelayDays} jour(s)`] as [string, string]]), ['Remise habituelle', `${s.discountPct} %`],
      ...(svc.canSeeAmounts(perms(req)) ? [['Solde dû', m(s.balanceMinor)], ['Seuil de blocage', m(s.effectiveThresholdMinor)]] as [string, string][] : [])] },
    { title: 'Contacts', rows: s.contacts.length ? s.contacts.map((k) => [k.name + (k.isPrimary ? ' (principal)' : ''), [k.role, k.phoneInfo?.display, k.email].filter(Boolean).join(' · ')] as [string, string]) : [['—', 'Aucun contact']] },
  ]);
  await audit(req, { action: 'print', resource: 'supplier', resourceId: s.id });
  send(res, { body, contentType: 'application/pdf', filename: `fiche-fournisseur-${(s.code ?? s.id).replace(/[^\w.-]/g, '_')}.pdf` });
}
