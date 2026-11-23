import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, toPdfFiche, type ExportFormat } from '../../services/export.service.js';
import * as svc from './supplier.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;

export const list = async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never));
export const get = async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)));
export async function create(req: Request, res: Response) {
  const s = await svc.create(cid(req), req.body);
  await audit(req, { action: 'create', resource: 'supplier', resourceId: s.id, meta: { name: s.name } });
  res.status(201).json(s);
}
export async function update(req: Request, res: Response) {
  const before = await svc.get(cid(req), pid(req));
  const s = await svc.update(cid(req), pid(req), req.body);
  await audit(req, { action: 'update', resource: 'supplier', resourceId: s.id, meta: { fields: Object.keys(req.body), ...('blockThresholdMinor' in req.body && { blockThreshold: { from: before.blockThresholdMinor, to: s.blockThresholdMinor } }) } });
  res.json(s);
}
export async function archive(req: Request, res: Response) {
  const s = await svc.setArchived(cid(req), pid(req), true); await audit(req, { action: 'archive', resource: 'supplier', resourceId: s.id }); res.json(s);
}
export async function reactivate(req: Request, res: Response) {
  const s = await svc.setArchived(cid(req), pid(req), false); await audit(req, { action: 'reactivate', resource: 'supplier', resourceId: s.id }); res.json(s);
}
export async function remove(req: Request, res: Response) {
  const s = await svc.getOwn(cid(req), pid(req));
  await svc.remove(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'supplier', resourceId: pid(req), meta: { name: s.name } });
  res.status(204).end();
}
const decimalsOf = async (req: Request) => {
  const s = await Setting.findOne({ companyId: cid(req) }).lean();
  return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
};
const send = (res: Response, r: { body: Buffer; contentType: string; filename: string }) => {
  res.setHeader('Content-Type', r.contentType); res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`); res.setHeader('Cache-Control', 'no-store'); res.send(r.body);
};
export async function exportList(req: Request, res: Response) {
  const q = req.query as unknown as svc.SupplierFilters & { format: ExportFormat };
  const rows = await svc.exportRows(cid(req), q);
  const name = q.withBalance ? 'balance-fournisseurs' : 'fournisseurs';
  const out = await renderTable(q.format, name, q.withBalance ? 'Balance fournisseurs' : 'Liste des fournisseurs', `${rows.length} fournisseur(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, svc.exportColumns(await decimalsOf(req)), rows);
  await audit(req, { action: 'export', resource: 'supplier', meta: { format: q.format, count: rows.length, withBalance: !!q.withBalance } });
  send(res, out);
}
export async function fichePdf(req: Request, res: Response) {
  const s = await svc.get(cid(req), pid(req)); const d = await decimalsOf(req);
  const m = (v: number | null) => (v == null ? '—' : (v / 10 ** d).toFixed(d));
  const a = s.address as { street?: string; city?: string; postalCode?: string; country?: string };
  const body = await toPdfFiche(`Fiche fournisseur — ${s.name}`, [
    { title: 'Identification', rows: [['Raison sociale', s.name], ['Matricule fiscal', s.taxId ?? ''], ['Fournisseur étranger', s.isForeign ? `Oui (${s.currency ?? '—'})` : 'Non'], ['Statut', s.isArchived ? 'Archivé' : 'Actif']] },
    { title: 'Coordonnées', rows: [['Adresse', [a.street, a.postalCode, a.city, a.country].filter(Boolean).join(', ')], ['Téléphone', s.phone ?? ''], ['E-mail', s.email ?? '']] },
    { title: 'Conditions d’achat', rows: [['Délai de livraison habituel', s.leadTimeDays == null ? '' : `${s.leadTimeDays} jour(s)`], ['Conditions de paiement', s.paymentTerms ?? ''], ['Délai de paiement', `${s.paymentDelayDays} jour(s)`], ['Solde dû', m(s.balanceMinor)], ['Seuil de blocage', m(s.effectiveThresholdMinor)]] },
    { title: 'Contacts', rows: s.contacts.length ? s.contacts.map((k) => [k.name + (k.isPrimary ? ' (principal)' : ''), [k.role, k.phone, k.email].filter(Boolean).join(' · ')] as [string, string]) : [['—', 'Aucun contact']] },
  ]);
  await audit(req, { action: 'print', resource: 'supplier', resourceId: s.id });
  send(res, { body, contentType: 'application/pdf', filename: `fiche-fournisseur-${s.id}.pdf` });
}
