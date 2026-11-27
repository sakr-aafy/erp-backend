import type { ClientSession, QueryFilter as FilterQuery, Types } from 'mongoose';
import { CUSTOMER_STATUSES, Customer, CustomerActivity, CustomerDocument, type CustomerDoc } from '../../models/customer.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { dropNulls, normalizeContacts, normalizeTaxId } from '../parties/party.shared.js';
import type { Column } from '../../services/export.service.js';
import { deleteFile } from './customer.files.js';
import { addressDto, addressesOf } from '../parties/delivery-address.js';
import { normalizePhone, phoneDisplay, phoneInfo } from '../../utils/phone.js';
import { claim, releaseAll, writeUnique } from './contact-keys.js';
import { PaymentTerm } from '../../models/payment-term.model.js';

type Id = Types.ObjectId;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export interface CustomerFilters { q?: string | undefined; status: 'open' | 'all' | CustomerStatus; type?: 'company' | 'walk_in' | undefined; city?: string | undefined; debtors?: boolean | undefined; customerId?: string | undefined }
type Lean = CustomerDoc & { _id: Id; createdAt?: Date };
export interface Actor { userId?: Id | undefined; name?: string | undefined }

/** Statut effectif (les clients d'avant la fiche détaillée n'ont que `isArchived`). */
export const effectiveStatus = (c: { status?: string | null; isArchived?: boolean | null }): CustomerStatus => (c.status as CustomerStatus | undefined) ?? (c.isArchived ? 'archived' : 'active');
export const STATUS_LABEL: Record<CustomerStatus, string> = { active: 'Actif', inactive: 'Inactif', archived: 'Archivé', blocked: 'Bloqué' };

const addr = (a?: { street?: string | null; city?: string | null; postalCode?: string | null; country?: string | null } | null) => ({
  street: a?.street ?? '', city: a?.city ?? '', postalCode: a?.postalCode ?? '', country: a?.country ?? '',
});

export const toDto = (c: Lean) => {
  const status = effectiveStatus(c);
  const country = c.address?.country;
  const contacts = (c.contacts ?? []).map((k) => ({ _id: (k as { _id?: Id })._id?.toString(), name: k.name, role: k.role ?? null, email: k.email ?? null, phone: k.phone ?? null, phoneInfo: phoneInfo(k.phone, country), isPrimary: !!k.isPrimary }));
  const primary = contacts.find((k) => k.isPrimary) ?? contacts[0];
  return {
    id: c._id.toString(), code: c.code ?? null, type: (c.type ?? 'company') as 'company' | 'walk_in', name: c.name, tradeName: c.tradeName ?? null,
    taxId: c.taxId ?? null,
    address: addr(c.address), deliveryAddresses: addressesOf(c).map(addressDto),
    phoneInfo: phoneInfo(c.phone, country), secondaryPhoneInfo: phoneInfo(c.secondaryPhone, country),
    phone: c.phone ?? null, secondaryPhone: c.secondaryPhone ?? null, email: c.email ?? null, website: c.website ?? null,
    social: { facebook: c.social?.facebook ?? null, linkedin: c.social?.linkedin ?? null, instagram: c.social?.instagram ?? null }, mapsUrl: c.mapsUrl ?? null,
    contacts,
    primaryContact: primary ? { name: primary.name, role: primary.role, phone: primary.phone, phoneInfo: primary.phoneInfo, email: primary.email } : null,
    paymentTerms: c.paymentTerms ?? null, paymentTermsCustom: !!c.paymentTermsCustom, paymentDelayDays: c.paymentDelayDays ?? 0, paymentMethod: c.paymentMethod ?? null, discountPct: c.discountPct ?? 0,
    creditLimitMinor: c.creditLimitMinor ?? null, balanceMinor: c.balanceMinor ?? 0,
    availableCreditMinor: c.creditLimitMinor == null ? null : Math.max(0, c.creditLimitMinor - (c.balanceMinor ?? 0)),
    creditExceeded: c.creditLimitMinor != null && (c.balanceMinor ?? 0) > c.creditLimitMinor,
    subjectToWithholding: !!c.subjectToWithholding, stampExempt: !!c.stampExempt,
    notes: c.notes ?? null, status, statusLabel: STATUS_LABEL[status], statusReason: c.statusReason ?? null, statusChangedAt: c.statusChangedAt ?? null,
    isArchived: status === 'archived', archivedAt: c.archivedAt ?? null, canSell: status === 'active', createdAt: c.createdAt,
  };
};

export function buildFilter(companyId: Id, f: CustomerFilters): FilterQuery<CustomerDoc> {
  const filter: FilterQuery<CustomerDoc> = { companyId };
  const and: FilterQuery<CustomerDoc>[] = [];
  // Les clients créés avant l'ajout du statut n'ont que `isArchived` : les deux représentations sont couvertes
  if (f.status === 'archived') and.push({ $or: [{ status: 'archived' }, { status: { $exists: false }, isArchived: true }] });
  else if (f.status === 'open') and.push({ status: { $ne: 'archived' }, isArchived: { $ne: true } });
  else if (f.status === 'active') and.push({ $or: [{ status: 'active' }, { status: { $exists: false }, isArchived: { $ne: true } }] });
  else if (f.status !== 'all') filter.status = f.status;
  if (f.type) and.push(f.type === 'company' ? { $or: [{ type: 'company' }, { type: { $exists: false } }] } : { type: f.type });
  if (f.city) filter['address.city'] = new RegExp(`^${escapeRegex(f.city)}$`, 'i');
  if (f.debtors) filter.balanceMinor = { $gt: 0 };
  if (f.customerId) filter._id = f.customerId as never;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), 'i');
    // Les numéros sont enregistrés sans espaces (+21623108065) : une saisie « 23 108 065 » doit les retrouver
    const digits = f.q.replace(/[\s().\-/]/g, ''); const phones = /^\+?\d{4,}$/.test(digits) ? new RegExp(escapeRegex(digits)) : null;
    and.push({ $or: [{ code: rx }, { name: rx }, { tradeName: rx }, { taxId: rx }, { email: rx }, { phone: rx }, { secondaryPhone: rx }, { 'contacts.name': rx }, { 'address.city': rx },
      ...(phones ? [{ phone: phones }, { secondaryPhone: phones }, { 'contacts.phone': phones }] : [])] });
  }
  if (and.length) filter.$and = and;
  return filter;
}

const SORTABLE = ['name', 'code', 'type', 'taxId', 'balanceMinor', 'creditLimitMinor', 'createdAt', 'status'];
export async function list(companyId: Id, f: CustomerFilters & { page: number; limit: number; sort?: string | undefined }) {
  const filter = buildFilter(companyId, f);
  const sortKey = f.sort?.replace(/city$/, 'address.city');
  const sort = buildSort(sortKey, [...SORTABLE, 'address.city'], { name: 1, _id: 1 });
  const [items, total, agg] = await Promise.all([
    Customer.find(filter).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Customer.countDocuments(filter),
    Customer.aggregate<{ _id: null; totalBalanceMinor: number }>([{ $match: filter }, { $group: { _id: null, totalBalanceMinor: { $sum: '$balanceMinor' } } }]),
  ]);
  return { items: items.map((c) => toDto(c as Lean)), total, page: f.page, limit: f.limit, summary: { totalBalanceMinor: agg[0]?.totalBalanceMinor ?? 0 } };
}

export async function cities(companyId: Id): Promise<string[]> {
  return ((await Customer.distinct('address.city', { companyId })) as string[]).filter((c) => !!c).sort((a, b) => a.localeCompare(b, 'fr'));
}

export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const c = await Customer.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!c) throw AppError.notFound('Client introuvable');
  return c as Lean;
}
export const get = async (companyId: Id, id: string) => toDto(await getOwn(companyId, id));

type Input = Partial<{
  type: 'company' | 'walk_in'; name: string; tradeName: string | null; taxId: string | null; address: { country?: string | undefined }; paymentTermsCustom: boolean;
  phone: string | null; secondaryPhone: string | null; email: string | null; website: string | null; social: Record<string, string | null | undefined>; mapsUrl: string | null; contacts: { isPrimary?: boolean }[];
  paymentTerms: string | null; paymentDelayDays: number; paymentMethod: string | null; discountPct: number; notes: string | null; creditLimitMinor: number | null; subjectToWithholding: boolean; stampExempt: boolean;
}>;

/** `country` = pays du client : détermine l'indicatif des numéros saisis au format local. */
function prepare(d: Input, country?: string | null, creating = false) {
  const out: Record<string, unknown> = { ...d };
  if ('taxId' in d) out.taxId = normalizeTaxId(d.taxId);
  for (const k of ['phone', 'secondaryPhone'] as const) if (d[k]) out[k] = normalizePhone(d[k], country);
  if (d.contacts) out.contacts = normalizeContacts(d.contacts.map((c) => withPhone(c as { phone?: string; isPrimary?: boolean }, country)));
  // À la création, un réseau vide n'est pas enregistré ; à la modification, null efface la valeur
  if (d.social && creating) out.social = Object.fromEntries(Object.entries(d.social).filter(([, v]) => v != null));
  return out;
}

const withPhone = <T extends { phone?: string | null | undefined }>(k: T, country?: string | null): T => (k.phone ? { ...k, phone: normalizePhone(k.phone, country) } : k);

/** Événement automatique de la fiche (jamais modifiable à la main). */
export async function logAuto(companyId: Id, customerId: Id | string, kind: string, title: string, actor: Actor, meta?: Record<string, unknown>, session?: ClientSession) {
  await CustomerActivity.create([{ companyId, customerId, auto: true, kind: kind as never, title, occurredAt: new Date(), userId: actor.userId, userName: actor.name, ...(meta && { meta }) }], { session });
}

export async function create(companyId: Id, d: Input, actor: Actor = {}) {
  await ensureCounter(companyId, 'customer');
  // Condition de paiement par défaut de la société, lorsqu'aucune n'est indiquée
  const preset = d.paymentTerms === undefined ? await PaymentTerm.findOne({ companyId, isDefault: true, isActive: true }).lean() : null;
  const data: Input = preset ? { ...d, paymentTerms: preset.label, paymentTermsCustom: preset.delayDays === null || preset.delayDays === undefined, ...(preset.delayDays != null && { paymentDelayDays: preset.delayDays }) } : d;
  const customer = await writeUnique(companyId, async (session) => {
    const code = await nextDocumentNumber(companyId, 'customer', session);
    const [c] = await Customer.create([{ ...dropNulls(prepare(data, data.address?.country, true)), companyId, code, status: 'active' }], { session });
    await claim(companyId, c!._id, c!.toObject(), null, session);
    await logAuto(companyId, c!._id, 'customer_created', 'Client créé', actor, { code }, session);
    return c!;
  });
  return toDto(customer.toObject() as Lean);
}

export async function update(companyId: Id, id: string, d: Input, actor: Actor = {}) {
  const existing = await getOwn(companyId, id);
  if (effectiveStatus(existing) === 'archived') throw AppError.conflict('Client archivé : réactivez-le avant de le modifier');
  const p = prepare(d, d.address?.country ?? existing.address?.country);
  const $set: Record<string, unknown> = {}; const $unset: Record<string, 1> = {};
  const flat = (obj: Record<string, unknown>, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = `${prefix}${k}`;
      if (v === undefined || v === null) $unset[key] = 1;
      else if (['address', 'social'].includes(k) && typeof v === 'object' && !prefix) flat(v as Record<string, unknown>, `${key}.`);
      else $set[key] = v;
    }
  };
  flat(p);
  if (!Object.keys($set).length && !Object.keys($unset).length) return toDto(existing);
  const c = await writeUnique(companyId, async (session) => {
    const before = await getOwn(companyId, id, session);
    const after = await Customer.findOneAndUpdate({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true, session }).lean();
    await claim(companyId, existing._id, after!, before, session);
    return after;
  });
  await logAuto(companyId, id, 'customer_updated', 'Informations du client modifiées', actor, { fields: Object.keys(d) });
  return toDto(c as Lean);
}

/**
 * Transitions de statut : tout statut peut passer à un autre, sauf qu'un client archivé ne peut être que réactivé (→ actif).
 * Conséquences : seuls les clients ACTIFS peuvent faire l'objet d'une nouvelle vente (voir assertCanSell et le constructeur de documents).
 */
export async function setStatus(companyId: Id, id: string, status: CustomerStatus, actor: Actor = {}, reason?: string) {
  const c = await getOwn(companyId, id); const from = effectiveStatus(c);
  if (from === status) throw AppError.conflict(`Le client est déjà « ${STATUS_LABEL[status].toLowerCase()} »`);
  if (from === 'archived' && status !== 'active') throw AppError.conflict('Un client archivé ne peut être que réactivé (statut Actif)');
  const $set: Record<string, unknown> = { status, isArchived: status === 'archived', statusChangedAt: new Date() };
  const $unset: Record<string, 1> = {};
  if (status === 'archived') $set.archivedAt = new Date(); else $unset.archivedAt = 1;
  if (reason) $set.statusReason = reason; else $unset.statusReason = 1;
  const u = await Customer.findOneAndUpdate({ _id: id, companyId }, { $set, $unset }, { returnDocument: 'after' }).lean();
  await logAuto(companyId, id, 'status_changed', `Statut : ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`, actor, { from, to: status, ...(reason && { reason }) });
  return toDto(u as Lean);
}
export const setArchived = (companyId: Id, id: string, archived: boolean, actor: Actor = {}) => setStatus(companyId, id, archived ? 'archived' : 'active', actor);

export async function remove(companyId: Id, id: string) {
  const c = await getOwn(companyId, id);
  if ((c.balanceMinor ?? 0) !== 0) throw AppError.conflict('Suppression impossible : le solde du client n’est pas nul. Utilisez l’archivage.');
  await assertNotReferenced('customer', companyId, c._id);
  const docs = await CustomerDocument.find({ companyId, customerId: c._id }).select('fileId').lean();
  await withTransaction(async (session) => { await Customer.deleteOne({ _id: id, companyId }, { session }); await releaseAll(companyId, c._id, session); });
  await Promise.all([CustomerActivity.deleteMany({ companyId, customerId: c._id }), CustomerDocument.deleteMany({ companyId, customerId: c._id }), ...docs.map((d) => deleteFile(d.fileId))]);
}

/**
 * Règle métier : seul un client ACTIF peut faire l'objet d'une nouvelle vente ; la limite de crédit est contrôlée en plus.
 * Appelée par les modules de vente dans leur transaction (validation de facture, de bon de livraison).
 */
export async function assertCanSell(companyId: Id, customerId: Id | string, newAmountMinor = 0, session?: ClientSession) {
  const c = await Customer.findOne({ _id: customerId, companyId }).session(session ?? null).lean();
  if (!c) throw AppError.notFound('Client introuvable');
  const st = effectiveStatus(c);
  if (st === 'archived') throw new AppError(409, 'Client archivé : vente impossible', 'CUSTOMER_ARCHIVED');
  if (st === 'blocked') throw new AppError(409, 'Client bloqué : vente impossible', 'CUSTOMER_BLOCKED');
  if (st === 'inactive') throw new AppError(409, 'Client inactif : vente impossible', 'CUSTOMER_INACTIVE');
  if (c.creditLimitMinor != null && (c.balanceMinor ?? 0) + newAmountMinor > c.creditLimitMinor) {
    throw new AppError(409, 'Limite de crédit dépassée : vente bloquée', 'CREDIT_LIMIT_EXCEEDED', { creditLimitMinor: c.creditLimitMinor, balanceMinor: c.balanceMinor ?? 0, newAmountMinor });
  }
}

// ---------- Contacts (un seul contact principal à tout instant) ----------
type ContactInput = { name: string; role?: string | undefined; email?: string | undefined; phone?: string | undefined; isPrimary?: boolean | undefined };
const withPrimary = (list: { isPrimary?: boolean | null | undefined }[], primaryIdx: number) => list.map((k, i) => ({ ...k, isPrimary: i === primaryIdx }));
type Stored = { _id?: Id; isPrimary?: boolean | null; name?: string };
/** Modification des contacts : lecture, contrôle d'unicité et écriture dans la même transaction. */
async function mutateContacts(companyId: Id, id: string, change: (list: Stored[], customer: Lean) => Stored[]) {
  const updated = await writeUnique(companyId, async (session) => {
    const c = await getOwn(companyId, id, session);
    if (effectiveStatus(c) === 'archived') throw AppError.conflict('Client archivé : réactivez-le avant de le modifier');
    const contacts = change([...((c.contacts ?? []) as unknown as Stored[])], c);
    const after = await Customer.findOneAndUpdate({ _id: id, companyId }, { $set: { contacts } }, { returnDocument: 'after', runValidators: true, session }).lean();
    await claim(companyId, c._id, after!, c, session);
    return after;
  });
  return toDto(updated as Lean);
}
export async function addContact(companyId: Id, id: string, k: ContactInput, actor: Actor = {}) {
  const out = await mutateContacts(companyId, id, (list, c) => {
    if (list.length >= 20) throw AppError.conflict('20 contacts maximum par client');
    list.push({ ...withPhone(k, c.address?.country), isPrimary: !!k.isPrimary || list.length === 0 } as Stored);
    return withPrimary(list, k.isPrimary || list.length === 1 ? list.length - 1 : list.findIndex((x) => x.isPrimary));
  });
  await logAuto(companyId, id, 'customer_updated', `Contact ajouté : ${k.name}`, actor, { contact: k.name });
  return out;
}
export async function updateContact(companyId: Id, id: string, contactId: string, k: Partial<ContactInput>, actor: Actor = {}) {
  let name = '';
  const out = await mutateContacts(companyId, id, (list, c) => {
    const i = list.findIndex((x) => String(x._id) === contactId); if (i < 0) throw AppError.notFound('Contact introuvable');
    const merged = { ...(list[i] as object), ...withPhone(k, c.address?.country) } as Stored; name = merged.name ?? '';
    const next = [...list]; next[i] = merged;
    // Un seul contact principal : en retirer le statut à l'actuel désigne le premier autre contact (ou lui-même s'il est seul)
    const other = list.findIndex((_, j) => j !== i);
    return withPrimary(next, k.isPrimary === true ? i : k.isPrimary === false && list[i]!.isPrimary ? (other >= 0 ? other : i) : list.findIndex((x) => x.isPrimary));
  });
  await logAuto(companyId, id, 'customer_updated', `Contact modifié : ${name}`, actor);
  return out;
}
export async function setPrimaryContact(companyId: Id, id: string, contactId: string, actor: Actor = {}) {
  return updateContact(companyId, id, contactId, { isPrimary: true }, actor);
}
export async function removeContact(companyId: Id, id: string, contactId: string, actor: Actor = {}) {
  let name = '';
  const out = await mutateContacts(companyId, id, (list) => {
    const i = list.findIndex((x) => String(x._id) === contactId); if (i < 0) throw AppError.notFound('Contact introuvable');
    const wasPrimary = !!list[i]!.isPrimary; name = list[i]!.name ?? ''; const next = list.filter((_, j) => j !== i);
    return next.length ? withPrimary(next, wasPrimary ? 0 : next.findIndex((x) => x.isPrimary)) : [];
  });
  await logAuto(companyId, id, 'customer_updated', `Contact supprimé : ${name}`, actor);
  return out;
}

export async function exportRows(companyId: Id, f: CustomerFilters) {
  return (await Customer.find(buildFilter(companyId, f)).sort({ name: 1 }).limit(20000).lean()).map((c) => toDto(c as Lean));
}
type Dto = ReturnType<typeof toDto>;
export const exportColumns = (decimals: number): Column<Dto>[] => [
  { header: 'Code', key: 'code', width: 11, value: (c) => c.code },
  { header: 'Raison sociale / Nom', key: 'name', width: 30, value: (c) => c.name },
  { header: 'Type', key: 'type', width: 10, value: (c) => (c.type === 'walk_in' ? 'Passager' : 'Société') },
  { header: 'Matricule fiscal', key: 'taxId', width: 18, value: (c) => c.taxId },
  { header: 'Contact principal', key: 'contact', width: 24, value: (c) => c.primaryContact?.name ?? '' },
  { header: 'Téléphone', key: 'phone', width: 18, value: (c) => phoneDisplay(c.phone ?? c.primaryContact?.phone, c.address.country) },
  { header: 'E-mail', key: 'email', width: 26, value: (c) => c.email ?? c.primaryContact?.email ?? '' },
  { header: 'Ville', key: 'city', width: 16, value: (c) => c.address.city },
  { header: 'Conditions de paiement', key: 'terms', width: 20, value: (c) => c.paymentTerms },
  { header: 'Limite de crédit', key: 'limit', width: 16, align: 'right', value: (c) => (c.creditLimitMinor == null ? 'Illimitée' : (c.creditLimitMinor / 10 ** decimals).toFixed(decimals)) },
  { header: 'Solde', key: 'balance', width: 14, align: 'right', value: (c) => (c.balanceMinor / 10 ** decimals).toFixed(decimals) },
  { header: 'Statut', key: 'status', width: 10, value: (c) => c.statusLabel },
];
