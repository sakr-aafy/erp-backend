import type { QueryFilter as FilterQuery, Types } from 'mongoose';
import { Customer, type CustomerDoc } from '../../models/customer.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import { dropNulls, normalizeContacts, normalizeTaxId } from '../parties/party.shared.js';
import type { Column } from '../../services/export.service.js';

type Id = Types.ObjectId;
export interface CustomerFilters { q?: string | undefined; status: 'active' | 'archived' | 'all'; debtors?: boolean | undefined }
type Lean = CustomerDoc & { _id: Id; createdAt?: Date };

export const toDto = (c: Lean) => ({
  id: c._id.toString(), name: c.name, taxId: c.taxId ?? null, address: c.address ?? {}, phone: c.phone ?? null, email: c.email ?? null,
  contacts: (c.contacts ?? []).map((k) => ({ _id: (k as { _id?: Id })._id?.toString(), name: k.name, role: k.role ?? null, email: k.email ?? null, phone: k.phone ?? null, isPrimary: !!k.isPrimary })),
  paymentTerms: c.paymentTerms ?? null, paymentDelayDays: c.paymentDelayDays ?? 0,
  creditLimitMinor: c.creditLimitMinor ?? null, balanceMinor: c.balanceMinor ?? 0,
  availableCreditMinor: c.creditLimitMinor == null ? null : Math.max(0, c.creditLimitMinor - (c.balanceMinor ?? 0)),
  creditExceeded: c.creditLimitMinor != null && (c.balanceMinor ?? 0) > c.creditLimitMinor,
  subjectToWithholding: !!c.subjectToWithholding, stampExempt: !!c.stampExempt,
  notes: c.notes ?? null, isArchived: !!c.isArchived, archivedAt: c.archivedAt ?? null, createdAt: c.createdAt,
});

export function buildFilter(companyId: Id, f: CustomerFilters): FilterQuery<CustomerDoc> {
  const filter: FilterQuery<CustomerDoc> = { companyId };
  if (f.status !== 'all') filter.isArchived = f.status === 'archived';
  if (f.debtors) filter.balanceMinor = { $gt: 0 };
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), 'i');
    filter.$or = [{ name: rx }, { taxId: rx }, { email: rx }, { phone: rx }, { 'contacts.name': rx }, { 'address.city': rx }];
  }
  return filter;
}

export async function list(companyId: Id, f: CustomerFilters & { page: number; limit: number; sort?: string | undefined }) {
  const filter = buildFilter(companyId, f);
  const sort = buildSort(f.sort, ['name', 'taxId', 'balanceMinor', 'createdAt'], { name: 1, _id: 1 });
  const [items, total, agg] = await Promise.all([
    Customer.find(filter).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Customer.countDocuments(filter),
    Customer.aggregate<{ _id: null; totalBalanceMinor: number }>([{ $match: filter }, { $group: { _id: null, totalBalanceMinor: { $sum: '$balanceMinor' } } }]),
  ]);
  return { items: items.map((c) => toDto(c as Lean)), total, page: f.page, limit: f.limit, summary: { totalBalanceMinor: agg[0]?.totalBalanceMinor ?? 0 } };
}

export async function getOwn(companyId: Id, id: string) {
  const c = await Customer.findOne({ _id: id, companyId }).lean();
  if (!c) throw AppError.notFound('Client introuvable');
  return c as Lean;
}
export const get = async (companyId: Id, id: string) => toDto(await getOwn(companyId, id));

type Input = Partial<{ name: string; taxId: string | null; address: object; phone: string | null; email: string | null; contacts: { isPrimary?: boolean }[]; paymentTerms: string | null; paymentDelayDays: number; notes: string | null; creditLimitMinor: number | null; subjectToWithholding: boolean; stampExempt: boolean }>;

function prepare(d: Input) {
  const out: Record<string, unknown> = { ...d };
  if ('taxId' in d) out.taxId = normalizeTaxId(d.taxId);
  if (d.contacts) out.contacts = normalizeContacts(d.contacts);
  return out;
}

export async function create(companyId: Id, d: Input) {
  const c = await Customer.create({ ...dropNulls(prepare(d)), companyId });
  return toDto(c.toObject() as Lean);
}

export async function update(companyId: Id, id: string, d: Input) {
  const existing = await getOwn(companyId, id);
  if (existing.isArchived) throw AppError.conflict('Client archivé : réactivez-le avant de le modifier');
  const p = prepare(d);
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(p)) { if (v === undefined || v === null) $unset[k] = 1; else $set[k] = v; }
  const c = await Customer.findOneAndUpdate({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true }).lean();
  return toDto(c as Lean);
}

export async function setArchived(companyId: Id, id: string, archived: boolean) {
  const c = await getOwn(companyId, id);
  if (archived && c.isArchived) throw AppError.conflict('Client déjà archivé');
  if (!archived && !c.isArchived) throw AppError.conflict('Client déjà actif');
  const u = await Customer.findOneAndUpdate({ _id: id, companyId }, archived ? { isArchived: true, archivedAt: new Date() } : { isArchived: false, $unset: { archivedAt: 1 } }, { returnDocument: 'after' }).lean();
  return toDto(u as Lean);
}

export async function remove(companyId: Id, id: string) {
  const c = await getOwn(companyId, id);
  if ((c.balanceMinor ?? 0) !== 0) throw AppError.conflict('Suppression impossible : le solde du client n’est pas nul. Utilisez l’archivage.');
  await assertNotReferenced('customer', companyId, c._id);
  await Customer.deleteOne({ _id: id, companyId });
}

/**
 * Règle métier (module 01) : bloque une nouvelle vente si le client est archivé ou si
 * solde + montant dépasse la limite de crédit. À appeler par les modules de vente (phase 4) dans leur transaction.
 */
export async function assertCanSell(companyId: Id, customerId: Id | string, newAmountMinor = 0, session?: import('mongoose').ClientSession) {
  const c = await Customer.findOne({ _id: customerId, companyId }).session(session ?? null).lean();
  if (!c) throw AppError.notFound('Client introuvable');
  if (c.isArchived) throw new AppError(409, 'Client archivé : vente impossible', 'CUSTOMER_ARCHIVED');
  if (c.creditLimitMinor != null && (c.balanceMinor ?? 0) + newAmountMinor > c.creditLimitMinor) {
    throw new AppError(409, 'Limite de crédit dépassée : vente bloquée', 'CREDIT_LIMIT_EXCEEDED', { creditLimitMinor: c.creditLimitMinor, balanceMinor: c.balanceMinor ?? 0, newAmountMinor });
  }
}

export async function exportRows(companyId: Id, f: CustomerFilters) {
  return (await Customer.find(buildFilter(companyId, f)).sort({ name: 1 }).limit(20000).lean()).map((c) => toDto(c as Lean));
}
type Dto = ReturnType<typeof toDto>;
export const exportColumns = (decimals: number): Column<Dto>[] => [
  { header: 'Raison sociale', key: 'name', width: 30, value: (c) => c.name },
  { header: 'Matricule fiscal', key: 'taxId', width: 18, value: (c) => c.taxId },
  { header: 'Téléphone', key: 'phone', width: 16, value: (c) => c.phone },
  { header: 'E-mail', key: 'email', width: 26, value: (c) => c.email },
  { header: 'Ville', key: 'city', width: 16, value: (c) => (c.address as { city?: string }).city },
  { header: 'Conditions de paiement', key: 'terms', width: 20, value: (c) => c.paymentTerms },
  { header: 'Délai (j)', key: 'delay', width: 9, value: (c) => c.paymentDelayDays },
  { header: 'Limite de crédit', key: 'limit', width: 16, align: 'right', value: (c) => (c.creditLimitMinor == null ? '' : (c.creditLimitMinor / 10 ** decimals).toFixed(decimals)) },
  { header: 'Solde', key: 'balance', width: 14, align: 'right', value: (c) => (c.balanceMinor / 10 ** decimals).toFixed(decimals) },
  { header: 'Statut', key: 'status', width: 10, value: (c) => (c.isArchived ? 'Archivé' : 'Actif') },
];
