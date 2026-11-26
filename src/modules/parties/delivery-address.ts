import { Schema, Types, type Model } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { normalizePhone, phoneInfo } from '../../utils/phone.js';

/**
 * Adresses de livraison multiples, communes aux clients et aux fournisseurs.
 * Les documents n'y font jamais référence « en direct » : ils en conservent une COPIE (addressSnapshotSchema).
 */
const text = { type: String, trim: true };
const baseFields = {
  label: { ...text, required: true }, street: { ...text, required: true }, city: text, postalCode: text, country: text,
  contactName: text, contactPhone: text, mapsUrl: text, instructions: text,
};
export const deliveryAddressSchema = new Schema({ ...baseFields, isDefault: { type: Boolean, default: false }, archivedAt: { type: Date } }, { _id: true });
/** Copie figée portée par un document. */
export const addressSnapshotSchema = new Schema({ addressId: Schema.Types.ObjectId, ...baseFields }, { _id: false });

export interface DeliveryAddressData {
  label: string; street: string; city?: string | null | undefined; postalCode?: string | null | undefined; country?: string | null | undefined;
  contactName?: string | null | undefined; contactPhone?: string | null | undefined; mapsUrl?: string | null | undefined; instructions?: string | null | undefined;
}
export interface DeliveryAddressRow extends DeliveryAddressData { _id: Types.ObjectId; isDefault?: boolean | null | undefined; archivedAt?: Date | null | undefined }
export type AddressSnapshot = DeliveryAddressData & { addressId?: Types.ObjectId | null | undefined };

const DATA_KEYS = ['label', 'street', 'city', 'postalCode', 'country', 'contactName', 'contactPhone', 'mapsUrl', 'instructions'] as const;
export const MAX_ADDRESSES = 30;

const isHttpUrl = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
/** '' ou null = effacer le champ facultatif. */
const opt = (s: z.ZodString) => z.union([s, z.literal('').transform(() => null)]).nullable().optional();
export const deliveryAddressBody = z.object({
  label: z.string().trim().min(2, 'Libellé requis (2 caractères minimum)').max(80),
  street: z.string().trim().min(3, 'Adresse complète requise').max(200),
  city: z.string().trim().min(2, 'Ville requise').max(80),
  postalCode: opt(z.string().trim().max(20)),
  country: z.string().trim().min(2, 'Pays requis').max(60),
  contactName: opt(z.string().trim().max(100)),
  contactPhone: opt(z.string().trim().regex(/^\+?[\d\s().\-/]{6,25}$/, 'Numéro de téléphone invalide')),
  mapsUrl: opt(z.string().trim().max(300).refine(isHttpUrl, 'URL invalide (http:// ou https://)')),
  instructions: opt(z.string().trim().max(500)),
  isDefault: z.boolean().optional(),
}).strict();
export const deliveryAddressUpdateBody = deliveryAddressBody.partial().strict();
export const addressParams = z.object({ id: objectId, addressId: objectId });

type Party = {
  _id: Types.ObjectId; deliveryAddresses?: unknown;
  shippingSameAsBilling?: boolean | null | undefined;
  shippingAddress?: { street?: string | null | undefined; city?: string | null | undefined; postalCode?: string | null | undefined; country?: string | null | undefined } | null | undefined;
};

/** Ancienne adresse de livraison unique d'un client (avant la liste) : son identifiant est celui du client, stable et idempotent. */
export function legacyDeliveryAddress(p: Party): DeliveryAddressRow | null {
  const a = p.shippingAddress;
  if (p.shippingSameAsBilling !== false || !a || ![a.street, a.city, a.postalCode, a.country].some(Boolean)) return null;
  const street = a.street || [a.postalCode, a.city, a.country].filter(Boolean).join(' ');
  return { _id: p._id, label: 'Adresse de livraison', street, city: a.city ?? undefined, postalCode: a.postalCode ?? undefined, country: a.country ?? undefined, isDefault: true };
}

/** Liste enregistrée ; tant qu'un client n'a pas été migré (champ absent), son ancienne adresse reste visible et sélectionnable. */
export function addressesOf(p: Party): DeliveryAddressRow[] {
  const list = p.deliveryAddresses as DeliveryAddressRow[] | undefined | null;
  if (list) return list;
  const legacy = legacyDeliveryAddress(p);
  return legacy ? [legacy] : [];
}

export const addressDto = (a: DeliveryAddressRow) => ({
  id: a._id.toString(), label: a.label, street: a.street, city: a.city ?? null, postalCode: a.postalCode ?? null, country: a.country ?? null,
  contactName: a.contactName ?? null, contactPhone: a.contactPhone ?? null, contactPhoneInfo: phoneInfo(a.contactPhone, a.country), mapsUrl: a.mapsUrl ?? null, instructions: a.instructions ?? null,
  isDefault: !!a.isDefault, archived: !!a.archivedAt,
});

/** Lignes d'une fiche imprimable (adresses actives, par défaut en premier). */
export function addressRows(list: ReturnType<typeof addressDto>[]): [string, string][] {
  const active = list.filter((a) => !a.archived).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  if (!active.length) return [['—', 'Aucune adresse de livraison']];
  return active.map((a) => [a.label + (a.isDefault ? ' (par défaut)' : ''), [
    [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', '),
    [a.contactName, a.contactPhoneInfo?.display].filter(Boolean).join(' · '), a.instructions, a.mapsUrl,
  ].filter(Boolean).join('\n')]);
}

export function snapshotOf(a: DeliveryAddressRow): AddressSnapshot {
  const out: Record<string, unknown> = { addressId: a._id };
  for (const k of DATA_KEYS) if (a[k]) out[k] = a[k];
  return out as unknown as AddressSnapshot;
}

export const snapshotDto = (s: AddressSnapshot | null | undefined) => (s?.label ? {
  addressId: s.addressId?.toString() ?? null, label: s.label, street: s.street, city: s.city ?? null, postalCode: s.postalCode ?? null, country: s.country ?? null,
  contactName: s.contactName ?? null, contactPhone: s.contactPhone ?? null, contactPhoneInfo: phoneInfo(s.contactPhone, s.country), mapsUrl: s.mapsUrl ?? null, instructions: s.instructions ?? null,
} : null);

/**
 * Adresse à figer sur un document. `party` appartient déjà à la société (chargé avec companyId).
 *  - `requested` = identifiant : doit être une adresse ACTIVE de ce tiers (ou celle déjà figée sur le document) ;
 *  - `requested` = null : aucune adresse de livraison ;
 *  - `requested` absent : copie existante conservée (`current`), sinon adresse par défaut du tiers.
 */
export function resolveAddress(party: Party, requested: string | null | undefined, current?: AddressSnapshot | null): AddressSnapshot | null {
  if (requested === null) return null;
  const active = addressesOf(party).filter((a) => !a.archivedAt);
  if (requested !== undefined) {
    const found = active.find((a) => a._id.toString() === requested);
    if (found) return snapshotOf(found);
    if (current?.addressId?.toString() === requested) return current;
    throw new AppError(400, 'Adresse de livraison inconnue pour ce tiers', 'DELIVERY_ADDRESS_INVALID');
  }
  if (current !== undefined) return current;
  const def = active.find((a) => a.isDefault);
  return def ? snapshotOf(def) : null;
}

/** Une seule adresse par défaut, toujours active, dès qu'au moins une adresse est active. */
function withSingleDefault(list: DeliveryAddressRow[], preferred?: string): DeliveryAddressRow[] {
  const usable = list.filter((a) => !a.archivedAt);
  const chosen = usable.find((a) => a._id.toString() === preferred) ?? usable.find((a) => a.isDefault) ?? usable[0];
  return list.map((a) => ({ ...a, isDefault: !!chosen && a._id.toString() === chosen._id.toString() }));
}

/** Nettoie et normalise les données saisies (champs vidés retirés, téléphone au format international). */
function clean(base: Partial<DeliveryAddressRow>, d: Partial<DeliveryAddressData>): DeliveryAddressRow {
  const out: Record<string, unknown> = { ...base };
  for (const k of DATA_KEYS) {
    if (!(k in d)) continue;
    const v = d[k];
    if (v === null || v === undefined || v === '') delete out[k]; else out[k] = v;
  }
  if (d.contactPhone) out.contactPhone = normalizePhone(d.contactPhone, out.country as string | undefined);
  return out as unknown as DeliveryAddressRow;
}

export interface AddressOwner {
  model: Model<any>;
  notFound: string;
  /** Raison empêchant la modification (tiers archivé), sinon null. */
  readOnly: (p: any) => string | null;
  /** Adresse utilisée par au moins un document : elle est alors archivée et non supprimée. */
  isReferenced: (companyId: Types.ObjectId, addressId: Types.ObjectId, partyId: Types.ObjectId) => Promise<boolean>;
}

type Id = Types.ObjectId;
/** Lecture + écriture dans une même transaction : deux modifications simultanées ne peuvent pas laisser deux adresses par défaut. */
async function mutate<R>(o: AddressOwner, companyId: Id, partyId: string, fn: (list: DeliveryAddressRow[], party: any) => Promise<{ list: DeliveryAddressRow[]; result: R }> | { list: DeliveryAddressRow[]; result: R }) {
  return withTransaction(async (session) => {
    const party = await o.model.findOne({ _id: partyId, companyId }).session(session).lean<any>();
    if (!party) throw AppError.notFound(o.notFound);
    const blocked = o.readOnly(party);
    if (blocked) throw AppError.conflict(blocked);
    const { list, result } = await fn([...addressesOf(party)], party);
    await o.model.updateOne({ _id: party._id, companyId }, { $set: { deliveryAddresses: list } }, { session, runValidators: true });
    return result;
  });
}
const indexOf = (list: DeliveryAddressRow[], addressId: string) => {
  const i = list.findIndex((a) => a._id.toString() === addressId);
  if (i < 0) throw AppError.notFound('Adresse de livraison introuvable');
  return i;
};

export const addressService = (o: AddressOwner) => ({
  add: (companyId: Id, partyId: string, d: DeliveryAddressData & { isDefault?: boolean | undefined }) => mutate(o, companyId, partyId, (list) => {
    if (list.filter((a) => !a.archivedAt).length >= MAX_ADDRESSES) throw AppError.conflict(`${MAX_ADDRESSES} adresses de livraison maximum`);
    const row = clean({ _id: new Types.ObjectId() }, d);
    const next = withSingleDefault([...list, row], d.isDefault ? row._id.toString() : undefined);
    return { list: next, result: { id: row._id.toString(), label: row.label } };
  }),
  update: (companyId: Id, partyId: string, addressId: string, d: Partial<DeliveryAddressData> & { isDefault?: boolean | undefined }) => mutate(o, companyId, partyId, (list) => {
    const i = indexOf(list, addressId);
    if (list[i]!.archivedAt) throw AppError.conflict('Adresse archivée : réactivez-la avant de la modifier');
    list[i] = clean(list[i]!, d);
    // Retirer le statut « par défaut » à l'actuelle désigne la première autre adresse active (elle-même si elle est seule)
    const other = list.find((a, j) => j !== i && !a.archivedAt)?._id.toString();
    const preferred = d.isDefault === true ? addressId : d.isDefault === false && list[i]!.isDefault ? other : undefined;
    if (d.isDefault === false && list[i]!.isDefault && other) list[i] = { ...list[i]!, isDefault: false };
    return { list: withSingleDefault(list, preferred), result: { id: addressId, label: list[i]!.label } };
  }),
  setDefault: (companyId: Id, partyId: string, addressId: string) => mutate(o, companyId, partyId, (list) => {
    const i = indexOf(list, addressId);
    if (list[i]!.archivedAt) throw AppError.conflict('Une adresse archivée ne peut pas être l’adresse par défaut');
    return { list: withSingleDefault(list, addressId), result: { id: addressId, label: list[i]!.label } };
  }),
  restore: (companyId: Id, partyId: string, addressId: string) => mutate(o, companyId, partyId, (list) => {
    const i = indexOf(list, addressId);
    if (!list[i]!.archivedAt) throw AppError.conflict('Adresse déjà active');
    const { archivedAt: _a, ...rest } = list[i]!; list[i] = { ...rest, isDefault: false };
    return { list: withSingleDefault(list), result: { id: addressId, label: rest.label } };
  }),
  /** Suppression ; une adresse utilisée par un document (ou déjà archivée mais utilisée) est archivée. */
  remove: (companyId: Id, partyId: string, addressId: string) => mutate(o, companyId, partyId, async (list, party) => {
    const i = indexOf(list, addressId); const row = list[i]!;
    const used = await o.isReferenced(companyId, row._id, party._id);
    if (used && row.archivedAt) throw AppError.conflict('Adresse utilisée par des documents : elle reste archivée');
    if (used) list[i] = { ...row, isDefault: false, archivedAt: new Date() }; else list.splice(i, 1);
    return { list: withSingleDefault(list), result: { id: addressId, label: row.label, archived: used } };
  }),
});
