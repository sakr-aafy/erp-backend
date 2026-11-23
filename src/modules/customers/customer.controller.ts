import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { audit } from '../../services/audit.service.js';
import { renderTable, toPdfFiche, type ExportFormat } from '../../services/export.service.js';
import * as svc from './customer.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;

export const list = async (req: Request, res: Response) => res.json(await svc.list(cid(req), req.query as never));
export const get = async (req: Request, res: Response) => res.json(await svc.get(cid(req), pid(req)));
export async function create(req: Request, res: Response) {
  const c = await svc.create(cid(req), req.body);
  await audit(req, { action: 'create', resource: 'customer', resourceId: c.id, meta: { name: c.name } });
  res.status(201).json(c);
}
export async function update(req: Request, res: Response) {
  const before = await svc.get(cid(req), pid(req));
  const c = await svc.update(cid(req), pid(req), req.body);
  const changed = Object.keys(req.body);
  // Les changements de limite de crédit sont sensibles : valeur avant/après tracée
  await audit(req, { action: 'update', resource: 'customer', resourceId: c.id, meta: { fields: changed, ...('creditLimitMinor' in req.body && { creditLimit: { from: before.creditLimitMinor, to: c.creditLimitMinor } }) } });
  res.json(c);
}
export async function archive(req: Request, res: Response) {
  const c = await svc.setArchived(cid(req), pid(req), true);
  await audit(req, { action: 'archive', resource: 'customer', resourceId: c.id }); res.json(c);
}
export async function reactivate(req: Request, res: Response) {
  const c = await svc.setArchived(cid(req), pid(req), false);
  await audit(req, { action: 'reactivate', resource: 'customer', resourceId: c.id }); res.json(c);
}
export async function remove(req: Request, res: Response) {
  const c = await svc.getOwn(cid(req), pid(req));
  await svc.remove(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'customer', resourceId: pid(req), meta: { name: c.name } });
  res.status(204).end();
}

const decimalsOf = async (req: Request) => {
  const s = await Setting.findOne({ companyId: cid(req) }).lean();
  return s?.currencies.find((c) => c.code === s.baseCurrency)?.decimals ?? 3;
};
const send = (res: Response, r: { body: Buffer; contentType: string; filename: string }) => {
  res.setHeader('Content-Type', r.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(r.body);
};

export async function exportList(req: Request, res: Response) {
  const q = req.query as unknown as svc.CustomerFilters & { format: ExportFormat };
  const rows = await svc.exportRows(cid(req), q);
  const label = q.debtors ? 'Clients débiteurs' : 'Liste des clients';
  const out = await renderTable(q.format, q.debtors ? 'clients-debiteurs' : 'clients', label, `${rows.length} client(s) — édité le ${new Date().toLocaleDateString('fr-FR')}`, svc.exportColumns(await decimalsOf(req)), rows);
  await audit(req, { action: 'export', resource: 'customer', meta: { format: q.format, count: rows.length, debtors: !!q.debtors } });
  send(res, out);
}

export async function fichePdf(req: Request, res: Response) {
  const c = await svc.get(cid(req), pid(req)); const d = await decimalsOf(req);
  const m = (v: number | null) => (v == null ? 'Illimitée' : (v / 10 ** d).toFixed(d));
  const a = c.address as { street?: string; city?: string; postalCode?: string; country?: string };
  const body = await toPdfFiche(`Fiche client — ${c.name}`, [
    { title: 'Identification', rows: [['Raison sociale', c.name], ['Matricule fiscal', c.taxId ?? ''], ['Statut', c.isArchived ? 'Archivé' : 'Actif']] },
    { title: 'Coordonnées', rows: [['Adresse', [a.street, a.postalCode, a.city, a.country].filter(Boolean).join(', ')], ['Téléphone', c.phone ?? ''], ['E-mail', c.email ?? '']] },
    { title: 'Conditions commerciales', rows: [['Conditions de paiement', c.paymentTerms ?? ''], ['Délai de paiement', `${c.paymentDelayDays} jour(s)`], ['Limite de crédit', m(c.creditLimitMinor)], ['Solde courant', m(c.balanceMinor)]] },
    { title: 'Contacts', rows: c.contacts.length ? c.contacts.map((k) => [k.name + (k.isPrimary ? ' (principal)' : ''), [k.role, k.phone, k.email].filter(Boolean).join(' · ')] as [string, string]) : [['—', 'Aucun contact']] },
  ]);
  await audit(req, { action: 'print', resource: 'customer', resourceId: c.id });
  send(res, { body, contentType: 'application/pdf', filename: `fiche-client-${c.id}.pdf` });
}
