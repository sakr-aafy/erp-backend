import { Types, type ClientSession, type QueryFilter as FilterQuery } from 'mongoose';
import { Setting } from '../../models/setting.model.js';
import { Supplier, SupplierActivity, SupplierCategory, SupplierDocument, SUPPLIER_STATUSES, type SupplierDoc } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex } from '../../utils/pagination.js';
import { assertNotReferenced } from '../../services/reference-guard.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { withTransaction } from '../../utils/transaction.js';
import { dropNulls, normalizeContacts, normalizeTaxId } from '../parties/party.shared.js';
import { addressDto, addressesOf } from '../parties/delivery-address.js';
import { deleteFile, SUPPLIER_BUCKET } from '../customers/customer.files.js';
import { normalizePhone, phoneDisplay, phoneInfo } from '../../utils/phone.js';
import type { Column } from '../../services/export.service.js';

type Id = Types.ObjectId;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export type Lean = SupplierDoc & { _id: Id; createdAt?: Date };
export interface Actor { userId?: Id | undefined; name?: string | undefined }
export interface SupplierFilters {
  q?: string | undefined; supplierId?: string | undefined; status: 'open' | 'all' | SupplierStatus; categoryId?: string | undefined; country?: string | undefined;
  withBalance?: boolean | undefined; foreign?: boolean | undefined;
}

/** Statut effectif (les fournisseurs d'avant la fiche détaillée n'ont que `isArchived`). */
export const effectiveStatus = (s: { status?: string | null; isArchived?: boolean | null }): SupplierStatus => (s.isArchived ? 'archived' : (s.status as SupplierStatus | undefined) ?? 'active');
export const STATUS_LABEL: Record<SupplierStatus, string> = { active: 'Actif', inactive: 'Inactif', archived: 'Archivé', blocked: 'Bloqué' };

/** Pays servant à interpréter un numéro local : jamais l'indicatif tunisien pour un fournisseur étranger sans pays renseigné. */
const phoneContext = (country: string | null | undefined, isForeign: boolean | null | undefined) => country || (isForeign ? 'inconnu' : undefined);

/** Seuil effectif : celui du fournisseur, sinon celui de la société ; undefined = pas de blocage. */
const effectiveThreshold = (s: { blockThresholdMinor?: number | null }, companyThreshold?: number | null) => s.blockThresholdMinor ?? companyThreshold ?? undefined;

export interface CategoryRef { name: string; isActive: boolean }
export const toDto = (s: Lean, companyThreshold?: number | null, categories?: Map<string, CategoryRef>) => {
  const th = effectiveThreshold(s, companyThreshold);
  const status = effectiveStatus(s);
  const country = phoneContext(s.address?.country, s.isForeign);
  const contacts = (s.contacts ?? []).map((k) => ({ _id: (k as { _id?: Id })._id?.toString(), name: k.name, role: k.role ?? null, email: k.email ?? null, phone: k.phone ?? null, phoneInfo: phoneInfo(k.phone, country), isPrimary: !!k.isPrimary }));
  const primary = contacts.find((k) => k.isPrimary) ?? contacts[0];
  const cat = s.categoryId ? categories?.get(String(s.categoryId)) : undefined;
  const ordersBlocked = th !== undefined && (s.balanceMinor ?? 0) > th;
  return {
    id: s._id.toString(), code: s.code ?? null, categoryId: s.categoryId ? String(s.categoryId) : null, categoryName: cat?.name ?? null, categoryActive: cat?.isActive ?? null,
    name: s.name, tradeName: s.tradeName ?? null, taxId: s.taxId ?? null,
    address: { street: s.address?.street ?? '', city: s.address?.city ?? '', postalCode: s.address?.postalCode ?? '', country: s.address?.country ?? '' },
    deliveryAddresses: addressesOf(s).map(addressDto),
    phone: s.phone ?? null, secondaryPhone: s.secondaryPhone ?? null, phoneInfo: phoneInfo(s.phone, country), secondaryPhoneInfo: phoneInfo(s.secondaryPhone, country),
    email: s.email ?? null, website: s.website ?? null,
    social: { facebook: s.social?.facebook ?? null, linkedin: s.social?.linkedin ?? null, instagram: s.social?.instagram ?? null }, mapsUrl: s.mapsUrl ?? null,
    contacts, primaryContact: primary ? { name: primary.name, role: primary.role, phone: primary.phone, phoneInfo: primary.phoneInfo, email: primary.email } : null,
    leadTimeDays: s.leadTimeDays ?? null, paymentTerms: s.paymentTerms ?? null, paymentTermsCustom: !!s.paymentTermsCustom, paymentDelayDays: s.paymentDelayDays ?? 0,
    paymentMethod: s.paymentMethod ?? null, discountPct: s.discountPct ?? 0,
    balanceMinor: s.balanceMinor ?? 0 as number | null, blockThresholdMinor: s.blockThresholdMinor ?? null, effectiveThresholdMinor: th ?? null,
    ordersBlocked,
    isForeign: !!s.isForeign, currency: s.currency ?? null, notes: s.notes ?? null,
    status, statusLabel: STATUS_LABEL[status], statusReason: s.statusReason ?? null, statusChangedAt: s.statusChangedAt ?? null,
    /** Une nouvelle commande n'est possible que pour un fournisseur actif dont le seuil d'impayés n'est pas dépassé. */
    canOrder: status === 'active' && !ordersBlocked,
    isArchived: status === 'archived', archivedAt: s.archivedAt ?? null, createdAt: s.createdAt,
  };
};
export type Dto = ReturnType<typeof toDto>;

/** Les montants (solde, seuil, blocage) exigent une permission financière : « consulter les fournisseurs » ne suffit pas. */
export const FINANCE_PERMISSIONS = ['purchases:view', 'treasury:view', 'accounting:view'] as const;
export const canSeeAmounts = (perms: ReadonlySet<string>) => FINANCE_PERMISSIONS.some((p) => perms.has(p));
export const redact = <T extends Dto>(d: T, perms: ReadonlySet<string>): T => (canSeeAmounts(perms) ? d
  : { ...d, balanceMinor: null, blockThresholdMinor: null, effectiveThresholdMinor: null, ordersBlocked: false, canOrder: d.status === 'active' });

export const companyThresholdOf = async (companyId: Id, session?: ClientSession) =>
  (await Setting.findOne({ companyId }).session(session ?? null).lean())?.supplierBlockThresholdMinor ?? null;
export async function categoryMap(companyId: Id): Promise<Map<string, CategoryRef>> {
  return new Map((await SupplierCategory.find({ companyId }).select('name isActive').lean()).map((c) => [c._id.toString(), { name: c.name, isActive: c.isActive !== false }]));
}
const dtoOf = async (companyId: Id, s: Lean) => { const [th, cats] = await Promise.all([companyThresholdOf(companyId), categoryMap(companyId)]); return toDto(s, th, cats); };

export function buildFilter(companyId: Id, f: SupplierFilters): FilterQuery<SupplierDoc> {
  const filter: FilterQuery<SupplierDoc> = { companyId };
  const and: FilterQuery<SupplierDoc>[] = [];
  // Les fournisseurs créés avant l'ajout du statut n'ont que `isArchived` : les deux représentations sont couvertes
  if (f.status === 'archived') and.push({ $or: [{ status: 'archived' }, { isArchived: true }] });
  else if (f.status === 'open') and.push({ status: { $ne: 'archived' }, isArchived: { $ne: true } });
  else if (f.status === 'active') and.push({ $or: [{ status: 'active' }, { status: { $exists: false } }], isArchived: { $ne: true } });
  else if (f.status !== 'all') and.push({ status: f.status, isArchived: { $ne: true } });
  if (f.supplierId) filter._id = new Types.ObjectId(f.supplierId) as never;
  if (f.categoryId === 'none') filter.categoryId = null; else if (f.categoryId) filter.categoryId = new Types.ObjectId(f.categoryId) as never;
  if (f.country) filter['address.country'] = new RegExp(`^${escapeRegex(f.country)}$`, 'i');
  if (f.withBalance) filter.balanceMinor = { $gt: 0 };
  if (f.foreign !== undefined) filter.isForeign = f.foreign ? true : { $ne: true };
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), 'i');
    // Les numéros sont enregistrés sans espaces (+21623108065) : une saisie « 23 108 065 » doit les retrouver
    const digits = f.q.replace(/[\s().\-/]/g, ''); const phones = /^\+?\d{4,}$/.test(digits) ? new RegExp(escapeRegex(digits)) : null;
    and.push({ $or: [{ code: rx }, { name: rx }, { tradeName: rx }, { taxId: rx }, { email: rx }, { phone: rx }, { secondaryPhone: rx }, { 'contacts.name': rx }, { 'contacts.email': rx }, { 'address.city': rx },
      ...(phones ? [{ phone: phones }, { secondaryPhone: phones }, { 'contacts.phone': phones }] : [])] });
  }
  if (and.length) filter.$and = and;
  return filter;
}

const SORTABLE = ['code', 'name', 'taxId', 'balanceMinor', 'leadTimeDays', 'createdAt', 'status', 'address.city', 'address.country'];
export async function list(companyId: Id, f: SupplierFilters & { page: number; limit: number; sort?: string | undefined }) {
  const filter = buildFilter(companyId, f);
  const sortKey = f.sort?.replace(/city$/, 'address.city').replace(/country$/, 'address.country');
  const sort = buildSort(sortKey, SORTABLE, { name: 1, _id: 1 });
  const [items, total, agg, th, cats] = await Promise.all([
    Supplier.find(filter).sort(sort).skip((f.page - 1) * f.limit).limit(f.limit).lean(),
    Supplier.countDocuments(filter),
    Supplier.aggregate<{ totalBalanceMinor: number }>([{ $match: filter }, { $group: { _id: null, totalBalanceMinor: { $sum: '$balanceMinor' } } }]),
    companyThresholdOf(companyId), categoryMap(companyId),
  ]);
  return { items: items.map((s) => toDto(s as Lean, th, cats)), total, page: f.page, limit: f.limit, summary: { totalBalanceMinor: agg[0]?.totalBalanceMinor ?? 0 as number | null } };
}

export async function countries(companyId: Id): Promise<string[]> {
  return ((await Supplier.distinct('address.country', { companyId })) as string[]).filter((c) => !!c).sort((a, b) => a.localeCompare(b, 'fr'));
}

export async function getOwn(companyId: Id, id: string, session?: ClientSession) {
  const s = await Supplier.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!s) throw AppError.notFound('Fournisseur introuvable');
  return s as Lean;
}
export const get = async (companyId: Id, id: string) => dtoOf(companyId, await getOwn(companyId, id));

export type Input = Partial<{
  categoryId: string | null; name: string; tradeName: string | null; taxId: string | null; address: { country?: string | undefined }; phone: string | null; secondaryPhone: string | null; email: string | null;
  website: string | null; social: Record<string, string | null | undefined>; mapsUrl: string | null; contacts: { isPrimary?: boolean }[];
  paymentTerms: string | null; paymentTermsCustom: boolean; paymentDelayDays: number; paymentMethod: string | null; discountPct: number; notes: string | null;
  leadTimeDays: number | null; blockThresholdMinor: number | null; isForeign: boolean; currency: string | null;
}>;

/** Règle métier côté serveur (le formulaire ne fait que l'anticiper) : un fournisseur étranger est facturé dans une devise. */
const foreignNeedsCurrency = (foreign: boolean | undefined, currency: string | null | undefined) => { if (foreign && !currency) throw AppError.badRequest('Devise obligatoire pour un fournisseur étranger'); };

async function prepare(companyId: Id, d: Input, existing?: Lean) {
  const isForeign = 'isForeign' in d ? d.isForeign : existing?.isForeign ?? false;
  foreignNeedsCurrency(isForeign, 'currency' in d ? d.currency : existing?.currency);
  const out: Record<string, unknown> = { ...d };
  const country = phoneContext(d.address ? d.address.country : existing?.address?.country, isForeign);
  if ('taxId' in d) out.taxId = normalizeTaxId(d.taxId);
  for (const k of ['phone', 'secondaryPhone'] as const) if (d[k]) out[k] = normalizePhone(d[k], country);
  if (d.contacts) out.contacts = normalizeContacts(d.contacts.map((c) => withPhone(c as { phone?: string; isPrimary?: boolean }, country)));
  // À la création, un réseau vide n'est pas enregistré ; à la modification, null efface la valeur
  if (d.social && !existing) out.social = Object.fromEntries(Object.entries(d.social).filter(([, v]) => v != null));
  if (d.currency && d.currency !== existing?.currency) {
    const s = await Setting.findOne({ companyId }).lean();
    if (!s?.currencies.some((c) => c.code === d.currency)) throw AppError.badRequest(`Devise « ${d.currency} » non configurée dans les paramètres`);
  }
  // Catégorie de la société, active pour une nouvelle association (la classification existante reste valable)
  if (d.categoryId && d.categoryId !== (existing?.categoryId ? String(existing.categoryId) : undefined)) {
    const c = await SupplierCategory.findOne({ _id: d.categoryId, companyId }).lean();
    if (!c) throw AppError.badRequest('Catégorie de fournisseurs introuvable');
    if (c.isActive === false) throw AppError.badRequest(`La catégorie « ${c.name} » est désactivée`);
  }
  return out;
}
const withPhone = <T extends { phone?: string | null | undefined }>(k: T, country?: string | null): T => (k.phone ? { ...k, phone: normalizePhone(k.phone, country) } : k);

/** Événement automatique de la fiche (jamais modifiable à la main). */
export async function logAuto(companyId: Id, supplierId: Id | string, kind: string, title: string, actor: Actor, meta?: Record<string, unknown>, session?: ClientSession) {
  await SupplierActivity.create([{ companyId, supplierId, auto: true, kind: kind as never, title, occurredAt: new Date(), userId: actor.userId, userName: actor.name, ...(meta && { meta }) }], { session });
}

export async function create(companyId: Id, d: Input, actor: Actor = {}) {
  const data = await prepare(companyId, d);
  await ensureCounter(companyId, 'supplier');
  const s = await withTransaction(async (session) => {
    const code = await nextDocumentNumber(companyId, 'supplier', session);
    const [c] = await Supplier.create([{ ...dropNulls(data), companyId, code, status: 'active' }], { session });
    await logAuto(companyId, c!._id, 'supplier_created', 'Fournisseur créé', actor, { code }, session);
    return c!;
  });
  return dtoOf(companyId, s.toObject() as Lean);
}

export async function update(companyId: Id, id: string, d: Input, actor: Actor = {}) {
  const existing = await getOwn(companyId, id);
  if (effectiveStatus(existing) === 'archived') throw AppError.conflict('Fournisseur archivé : réactivez-le avant de le modifier');
  const p = await prepare(companyId, d, existing);
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
  if (!Object.keys($set).length && !Object.keys($unset).length) return dtoOf(companyId, existing);
  const s = await Supplier.findOneAndUpdate({ _id: id, companyId }, { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }, { returnDocument: 'after', runValidators: true }).lean();
  const from = existing.categoryId ? String(existing.categoryId) : null; const to = s!.categoryId ? String(s!.categoryId) : null;
  if (from !== to) {
    const cats = await categoryMap(companyId); const label = (x: string | null) => (x ? cats.get(x)?.name ?? '?' : 'Non classé');
    await logAuto(companyId, id, 'category_changed', `Catégorie : ${label(from)} → ${label(to)}`, actor, { from: label(from), to: label(to) });
  }
  const others = Object.keys(d).filter((k) => k !== 'categoryId');
  if (others.length) await logAuto(companyId, id, 'supplier_updated', 'Informations du fournisseur modifiées', actor, { fields: others });
  return dtoOf(companyId, s as Lean);
}

/**
 * Transitions de statut : tout statut peut passer à un autre, sauf qu'un fournisseur archivé ne peut être que réactivé (→ actif).
 * Conséquences : seuls les fournisseurs ACTIFS peuvent recevoir une nouvelle commande ou un nouveau dossier d'importation ;
 * consultation, factures des opérations passées et règlement des dettes restent possibles.
 */
export async function setStatus(companyId: Id, id: string, status: SupplierStatus, actor: Actor = {}, reason?: string) {
  const s = await getOwn(companyId, id); const from = effectiveStatus(s);
  if (from === status) throw AppError.conflict(`Le fournisseur est déjà « ${STATUS_LABEL[status].toLowerCase()} »`);
  if (from === 'archived' && status !== 'active') throw AppError.conflict('Un fournisseur archivé ne peut être que réactivé (statut Actif)');
  const $set: Record<string, unknown> = { status, isArchived: status === 'archived', statusChangedAt: new Date() };
  const $unset: Record<string, 1> = {};
  if (status === 'archived') $set.archivedAt = new Date(); else $unset.archivedAt = 1;
  if (reason) $set.statusReason = reason; else $unset.statusReason = 1;
  const u = await Supplier.findOneAndUpdate({ _id: id, companyId }, { $set, $unset }, { returnDocument: 'after' }).lean();
  await logAuto(companyId, id, 'status_changed', `Statut : ${STATUS_LABEL[from]} → ${STATUS_LABEL[status]}`, actor, { from, to: status, ...(reason && { reason }) });
  return dtoOf(companyId, u as Lean);
}
export const setArchived = (companyId: Id, id: string, archived: boolean, actor: Actor = {}) => setStatus(companyId, id, archived ? 'archived' : 'active', actor);

export async function remove(companyId: Id, id: string) {
  const s = await getOwn(companyId, id);
  if ((s.balanceMinor ?? 0) !== 0) throw AppError.conflict('Suppression impossible : le solde du fournisseur n’est pas nul. Utilisez l’archivage.');
  await assertNotReferenced('supplier', companyId, s._id);
  const docs = await SupplierDocument.find({ companyId, supplierId: s._id }).select('fileId').lean();
  await Supplier.deleteOne({ _id: id, companyId });
  await Promise.all([SupplierActivity.deleteMany({ companyId, supplierId: s._id }), SupplierDocument.deleteMany({ companyId, supplierId: s._id }), ...docs.map((d) => deleteFile(d.fileId, SUPPLIER_BUCKET))]);
}

/** Un fournisseur inactif, bloqué ou archivé ne peut pas faire l'objet d'une NOUVELLE commande (les opérations passées restent traitables). */
export function assertSupplierActive(s: { status?: string | null; isArchived?: boolean | null }) {
  const st = effectiveStatus(s);
  if (st === 'archived') throw new AppError(409, 'Fournisseur archivé : commande impossible', 'SUPPLIER_ARCHIVED');
  if (st === 'inactive') throw new AppError(409, 'Fournisseur inactif : commande impossible', 'SUPPLIER_INACTIVE');
  if (st === 'blocked') throw new AppError(409, 'Fournisseur bloqué : commande impossible', 'SUPPLIER_BLOCKED');
}
/**
 * Règle métier : refuse une commande si le fournisseur n'est pas actif ou si son solde impayé dépasse le seuil paramétré
 * (fournisseur, sinon société). Appelée par les modules Achats / Importations dans leur transaction.
 */
export async function assertCanOrder(companyId: Id, supplierId: Id | string, session?: ClientSession) {
  const s = await Supplier.findOne({ _id: supplierId, companyId }).session(session ?? null).lean();
  if (!s) throw AppError.notFound('Fournisseur introuvable');
  assertSupplierActive(s);
  const th = effectiveThreshold(s, await companyThresholdOf(companyId, session));
  if (th !== undefined && (s.balanceMinor ?? 0) > th) {
    throw new AppError(409, 'Seuil d’impayés dépassé : commandes bloquées pour ce fournisseur', 'SUPPLIER_BLOCKED', { thresholdMinor: th, balanceMinor: s.balanceMinor ?? 0 });
  }
}

// ---------- Contacts (un seul contact principal à tout instant) ----------
type ContactInput = { name: string; role?: string | undefined; email?: string | undefined; phone?: string | undefined; isPrimary?: boolean | undefined };
const withPrimary = (list: { isPrimary?: boolean | null | undefined }[], primaryIdx: number) => list.map((k, i) => ({ ...k, isPrimary: i === primaryIdx }));
async function saveContacts(companyId: Id, id: string, contacts: unknown[]) {
  const s = await Supplier.findOneAndUpdate({ _id: id, companyId }, { $set: { contacts } }, { returnDocument: 'after', runValidators: true }).lean();
  return dtoOf(companyId, s as Lean);
}
async function editable(companyId: Id, id: string) {
  const s = await getOwn(companyId, id);
  if (effectiveStatus(s) === 'archived') throw AppError.conflict('Fournisseur archivé : réactivez-le avant de modifier ses contacts');
  return s;
}
const MAX_CONTACTS = 20;
export async function addContact(companyId: Id, id: string, k: ContactInput, actor: Actor = {}) {
  const s = await editable(companyId, id);
  const list = (s.contacts ?? []) as unknown as Record<string, unknown>[];
  if (list.length >= MAX_CONTACTS) throw AppError.conflict(`${MAX_CONTACTS} contacts maximum par fournisseur`);
  const next = [...list, withPhone(k, phoneContext(s.address?.country, s.isForeign))];
  // Le premier contact, ou un contact marqué principal, devient l'unique contact principal
  const primary = k.isPrimary || !list.length ? next.length - 1 : next.findIndex((x) => (x as ContactInput).isPrimary);
  const out = await saveContacts(companyId, id, withPrimary(next as { isPrimary?: boolean }[], primary < 0 ? 0 : primary));
  await logAuto(companyId, id, 'supplier_updated', `Contact ajouté : ${k.name}`, actor);
  return out;
}
const indexOfContact = (s: Lean, contactId: string) => {
  const i = (s.contacts ?? []).findIndex((k) => String((k as unknown as { _id: Id })._id) === contactId);
  if (i < 0) throw AppError.notFound('Contact introuvable');
  return i;
};
export async function updateContact(companyId: Id, id: string, contactId: string, k: Partial<ContactInput>, actor: Actor = {}) {
  const s = await editable(companyId, id); const i = indexOfContact(s, contactId);
  const list = (s.contacts ?? []).map((x) => ({ ...x }));
  const merged = { ...list[i], ...withPhone(k, phoneContext(s.address?.country, s.isForeign)) } as Record<string, unknown>;
  for (const f of ['role', 'email', 'phone'] as const) if (f in k && !k[f]) delete merged[f];
  list[i] = merged as never;
  // Retirer « principal » à l'unique contact principal le laisse principal : il faut en désigner un autre
  const primary = k.isPrimary ? i : list.findIndex((x, j) => x.isPrimary && (j !== i || k.isPrimary !== false));
  const out = await saveContacts(companyId, id, withPrimary(list, primary < 0 ? i : primary));
  await logAuto(companyId, id, 'supplier_updated', `Contact modifié : ${merged.name as string}`, actor);
  return out;
}
export async function setPrimaryContact(companyId: Id, id: string, contactId: string, actor: Actor = {}) {
  const s = await editable(companyId, id); const i = indexOfContact(s, contactId);
  const out = await saveContacts(companyId, id, withPrimary((s.contacts ?? []).map((x) => ({ ...x })), i));
  await logAuto(companyId, id, 'supplier_updated', `Contact principal : ${s.contacts![i]!.name}`, actor);
  return out;
}
export async function removeContact(companyId: Id, id: string, contactId: string, actor: Actor = {}) {
  const s = await editable(companyId, id); const i = indexOfContact(s, contactId);
  const removed = s.contacts![i]!; const list = (s.contacts ?? []).filter((_, j) => j !== i).map((x) => ({ ...x }));
  const primary = list.findIndex((x) => x.isPrimary);
  const out = await saveContacts(companyId, id, list.length ? withPrimary(list, primary < 0 ? 0 : primary) : []);
  await logAuto(companyId, id, 'supplier_updated', `Contact supprimé : ${removed.name}`, actor);
  return out;
}

// ---------- Export ----------
export async function exportRows(companyId: Id, f: SupplierFilters) {
  const [th, cats] = await Promise.all([companyThresholdOf(companyId), categoryMap(companyId)]);
  return (await Supplier.find(buildFilter(companyId, f)).sort({ name: 1 }).limit(20000).lean()).map((s) => toDto(s as Lean, th, cats));
}
export const exportColumns = (decimals: number, withAmounts: boolean): Column<Dto>[] => [
  { header: 'Code', key: 'code', width: 11, value: (s) => s.code },
  { header: 'Raison sociale', key: 'name', width: 30, value: (s) => s.name },
  { header: 'Nom commercial', key: 'tradeName', width: 22, value: (s) => s.tradeName },
  { header: 'Catégorie', key: 'category', width: 24, value: (s) => s.categoryName ?? 'Non classé' },
  { header: 'Matricule fiscal', key: 'taxId', width: 18, value: (s) => s.taxId },
  { header: 'Contact principal', key: 'contact', width: 22, value: (s) => s.primaryContact?.name },
  { header: 'Téléphone', key: 'phone', width: 18, value: (s) => phoneDisplay(s.phone, s.address.country || (s.isForeign ? 'inconnu' : undefined)) },
  { header: 'E-mail', key: 'email', width: 26, value: (s) => s.email },
  { header: 'Ville', key: 'city', width: 14, value: (s) => s.address.city },
  { header: 'Pays', key: 'country', width: 14, value: (s) => s.address.country },
  { header: 'Étranger', key: 'foreign', width: 9, value: (s) => (s.isForeign ? 'Oui' : 'Non') },
  { header: 'Devise', key: 'currency', width: 8, value: (s) => s.currency },
  { header: 'Délai livraison (j)', key: 'lead', width: 12, value: (s) => s.leadTimeDays },
  { header: 'Conditions de paiement', key: 'terms', width: 28, value: (s) => s.paymentTerms },
  ...(withAmounts ? [{ header: 'Solde dû', key: 'balance', width: 14, align: 'right' as const, value: (s: Dto) => ((s.balanceMinor ?? 0) / 10 ** decimals).toFixed(decimals) }] : []),
  { header: 'Statut', key: 'status', width: 10, value: (s) => s.statusLabel },
];
