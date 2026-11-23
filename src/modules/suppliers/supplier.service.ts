import type { ClientSession, QueryFilter as FilterQuery, Types } from 'mongoose';
import { Setting } from '../../models/setting.model.js';
import { Supplier, type SupplierDoc } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import { dropNulls, normalizeContacts, normalizeTaxId } from '../parties/party.shared.js';
import type { Column } from '../../services/export.service.js';

type Id = Types.ObjectId;
type Lean = SupplierDoc & { _id: Id; createdAt?: Date };
export interface SupplierFilters { q?: string | undefined; status: 'active' | 'archived' | 'all'; withBalance?: boolean | undefined; foreign?: boolean | undefined }

/** Seuil effectif : celui du fournisseur, sinon celui de la société ; undefined = pas de blocage. */
const effectiveThreshold = (s: { blockThresholdMinor?: number | null }, companyThreshold?: number | null) => s.blockThresholdMinor ?? companyThreshold ?? undefined;

export const toDto = (s: Lean, companyThreshold?: number | null) => {
  const th = effectiveThreshold(s, companyThreshold);
  return {
    id: s._id.toString(), name: s.name, taxId: s.taxId ?? null, address: s.address ?? {}, phone: s.phone ?? null, email: s.email ?? null,
    contacts: (s.contacts ?? []).map((k) => ({ _id: (k as { _id?: Id })._id?.toString(), name: k.name, role: k.role ?? null, email: k.email ?? null, phone: k.phone ?? null, isPrimary: !!k.isPrimary })),
    leadTimeDays: s.leadTimeDays ?? null, paymentTerms: s.paymentTerms ?? null, paymentDelayDays: s.paymentDelayDays ?? 0,
    balanceMinor: s.balanceMinor ?? 0, blockThresholdMinor: s.blockThresholdMinor ?? null, effectiveThresholdMinor: th ?? null,
    ordersBlocked: th !== undefined && (s.balanceMinor ?? 0) > th,
    isForeign: !!s.isForeign, currency: s.currency ?? null, notes: s.notes ?? null,
    isArchived: !!s.isArchived, archivedAt: s.archivedAt ?? null, createdAt: s.createdAt,
  };
};
const companyThresholdOf = async (companyId: Id, session?: ClientSession) =>
  (await Setting.findOne({ companyId }).session(session ?? null).lean())?.supplierBlockThresholdMinor ?? null;

export function buildFilter(companyId: Id, f: SupplierFilters): FilterQuery<SupplierDoc> {
  const filter: FilterQuery<SupplierDoc> = { companyId };
  if (f.status !== 'all') filter.isArchived = f.status === 'archived';
  if (f.withBalance) filter.balanceMinor = { $gt: 0 };
  if (f.foreign !== undefined) filter.isForeign = f.foreign;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), 'i');
    filter.$or = [{ name: rx }, { taxId: rx }, { email: rx }, { phone: rx }, { 'contacts.name': rx }, { 'address.city': rx }];
  }
  return filter;
}

export async function list(companyId: Id, f: SupplierFilters & { page: number; limit: number; sort?: string | undefined }) {
  const filter = buildFilter(companyId, f);
  const sort = buildSort(f.sort, ['name', 'taxId', 'balanceMinor', 'leadTimeDays', 'createdAt'], { name: 1, _id: 1 });
  const [items, total, agg, th] = await Promise.all([
    Supplier.find(filter).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Supplier.countDocuments(filter),
    Supplier.aggregate<{ totalBalanceMinor: number }>([{ $match: filter }, { $group: { _id: null, totalBalanceMinor: { $sum: '$balanceMinor' } } }]),
    companyThresholdOf(companyId),
  ]);
  return { items: items.map((s) => toDto(s as Lean, th)), total, page: f.page, limit: f.limit, summary: { totalBalanceMinor: agg[0]?.totalBalanceMinor ?? 0 } };
}

export async function getOwn(companyId: Id, id: string) {
  const s = await Supplier.findOne({ _id: id, companyId }).lean();
  if (!s) throw AppError.notFound('Fournisseur introuvable');
  return s as Lean;
}
export const get = async (companyId: Id, id: string) => toDto(await getOwn(companyId, id), await companyThresholdOf(companyId));

type Input = Partial<{ name: string; taxId: string | null; address: object; phone: string | null; email: string | null; contacts: { isPrimary?: boolean }[]; paymentTerms: string | null; paymentDelayDays: number; notes: string | null;
  leadTimeDays: number | null; blockThresholdMinor: number | null; isForeign: boolean; currency: string | null }>;

/** Règle métier côté serveur (le formulaire ne fait que l'anticiper) : un fournisseur étranger est facturé dans une devise. */
const foreignNeedsCurrency = (foreign: boolean | undefined, currency: string | null | undefined) => { if (foreign && !currency) throw AppError.badRequest('Devise obligatoire pour un fournisseur étranger'); };

async function prepare(companyId: Id, d: Input, existing?: { isForeign?: boolean | null; currency?: string | null }) {
  foreignNeedsCurrency('isForeign' in d ? d.isForeign : existing?.isForeign ?? false, 'currency' in d ? d.currency : existing?.currency);
  const out: Record<string, unknown> = { ...d };
  if ('taxId' in d) out.taxId = normalizeTaxId(d.taxId);
  if (d.contacts) out.contacts = normalizeContacts(d.contacts);
  if (d.currency) {
    const s = await Setting.findOne({ companyId }).lean();
    if (!s?.currencies.some((c) => c.code === d.currency)) throw AppError.badRequest(`Devise « ${d.currency} » non configurée dans les paramètres`);
  }
  return out;
}

export async function create(companyId: Id, d: Input) {
  const s = await Supplier.create({ ...dropNulls(await prepare(companyId, d)), companyId });
  return toDto(s.toObject() as Lean, await companyThresholdOf(companyId));
}
export async function update(companyId: Id, id: string, d: Input) {
  const existing = await getOwn(companyId, id);
  if (existing.isArchived) throw AppError.conflict('Fournisseur archivé : réactivez-le avant de le modifier');
  const p = await prepare(companyId, d, existing);
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(p)) { if (v === undefined || v === null) $unset[k] = 1; else $set[k] = v; }
  const s = await Supplier.findOneAndUpdate({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true }).lean();
  return toDto(s as Lean, await companyThresholdOf(companyId));
}
export async function setArchived(companyId: Id, id: string, archived: boolean) {
  const s = await getOwn(companyId, id);
  if (archived && s.isArchived) throw AppError.conflict('Fournisseur déjà archivé');
  if (!archived && !s.isArchived) throw AppError.conflict('Fournisseur déjà actif');
  const u = await Supplier.findOneAndUpdate({ _id: id, companyId }, archived ? { isArchived: true, archivedAt: new Date() } : { isArchived: false, $unset: { archivedAt: 1 } }, { returnDocument: 'after' }).lean();
  return toDto(u as Lean, await companyThresholdOf(companyId));
}
export async function remove(companyId: Id, id: string) {
  const s = await getOwn(companyId, id);
  if ((s.balanceMinor ?? 0) !== 0) throw AppError.conflict('Suppression impossible : le solde du fournisseur n’est pas nul. Utilisez l’archivage.');
  await assertNotReferenced('supplier', companyId, s._id);
  await Supplier.deleteOne({ _id: id, companyId });
}

/**
 * Règle métier (module 03) : bloque une nouvelle commande si le fournisseur est archivé ou si son solde impayé
 * dépasse le seuil paramétré (fournisseur, sinon société). À appeler par le module Achats / Importations.
 */
export async function assertCanOrder(companyId: Id, supplierId: Id | string, session?: ClientSession) {
  const s = await Supplier.findOne({ _id: supplierId, companyId }).session(session ?? null).lean();
  if (!s) throw AppError.notFound('Fournisseur introuvable');
  if (s.isArchived) throw new AppError(409, 'Fournisseur archivé : commande impossible', 'SUPPLIER_ARCHIVED');
  const th = effectiveThreshold(s, await companyThresholdOf(companyId, session));
  if (th !== undefined && (s.balanceMinor ?? 0) > th) {
    throw new AppError(409, 'Seuil d’impayés dépassé : commandes bloquées pour ce fournisseur', 'SUPPLIER_BLOCKED', { thresholdMinor: th, balanceMinor: s.balanceMinor ?? 0 });
  }
}

export async function exportRows(companyId: Id, f: SupplierFilters) {
  const th = await companyThresholdOf(companyId);
  return (await Supplier.find(buildFilter(companyId, f)).sort({ name: 1 }).limit(20000).lean()).map((s) => toDto(s as Lean, th));
}
type Dto = ReturnType<typeof toDto>;
export const exportColumns = (decimals: number): Column<Dto>[] => [
  { header: 'Raison sociale', key: 'name', width: 30, value: (s) => s.name },
  { header: 'Matricule fiscal', key: 'taxId', width: 18, value: (s) => s.taxId },
  { header: 'Téléphone', key: 'phone', width: 16, value: (s) => s.phone },
  { header: 'E-mail', key: 'email', width: 26, value: (s) => s.email },
  { header: 'Étranger', key: 'foreign', width: 9, value: (s) => (s.isForeign ? 'Oui' : 'Non') },
  { header: 'Devise', key: 'currency', width: 8, value: (s) => s.currency },
  { header: 'Délai livraison (j)', key: 'lead', width: 12, value: (s) => s.leadTimeDays },
  { header: 'Conditions de paiement', key: 'terms', width: 20, value: (s) => s.paymentTerms },
  { header: 'Solde dû', key: 'balance', width: 14, align: 'right', value: (s) => (s.balanceMinor / 10 ** decimals).toFixed(decimals) },
  { header: 'Statut', key: 'status', width: 10, value: (s) => (s.isArchived ? 'Archivé' : 'Actif') },
];
