import type { ClientSession, Types } from 'mongoose';
import { ContactKey, Customer } from '../../models/customer.model.js';
import { Setting } from '../../models/setting.model.js';
import { AppError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/phone.js';
import { withTransaction } from '../../utils/transaction.js';

type Id = Types.ObjectId;
type Kind = 'email' | 'phone';
type Source = 'customer' | 'contact';
export interface Party { address?: { country?: string | null } | null | undefined; email?: string | null | undefined; phone?: string | null | undefined; secondaryPhone?: string | null | undefined; contacts?: { email?: string | null | undefined; phone?: string | null | undefined; name?: string | null | undefined }[] | null | undefined }
export interface Entry { kind: Kind; value: string; source: Source; field: string; key: string; raw: string }

/** E-mail : sans espaces, casse ignorée. */
export const emailKey = (raw: string | null | undefined) => (raw ?? '').trim().toLowerCase() || null;
/**
 * Téléphone : format international (E.164) selon le pays du client — 23108065, +21623108065 et +216 23 108 065 sont identiques
 * pour un client tunisien. Numéro non reconnu : comparaison sur les seuls chiffres, sans présumer d'indicatif.
 */
export function phoneKey(raw: string | null | undefined, country?: string | null) {
  if (!raw?.trim()) return null;
  const n = String(normalizePhone(raw.trim(), country));
  if (/^\+\d{7,15}$/.test(n)) return n;
  const digits = n.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

export function entriesOf(c: Party | null | undefined): Entry[] {
  if (!c) return [];
  const country = c.address?.country; const out: Entry[] = [];
  const add = (kind: Kind, raw: string | null | undefined, source: Source, field: string) => {
    const value = kind === 'email' ? emailKey(raw) : phoneKey(raw, country);
    if (value) out.push({ kind, value, source, field, key: `${kind}|${value}`, raw: raw!.trim() });
  };
  add('email', c.email, 'customer', 'email'); add('phone', c.phone, 'customer', 'phone'); add('phone', c.secondaryPhone, 'customer', 'secondaryPhone');
  (c.contacts ?? []).forEach((k, i) => { add('email', k.email, 'contact', `contacts.${i}.email`); add('phone', k.phone, 'contact', `contacts.${i}.phone`); });
  return out;
}

const MESSAGE: Record<Source, Record<Kind, string>> = {
  customer: { email: 'Cette adresse e-mail est déjà associée à un autre client.', phone: 'Ce numéro de téléphone est déjà associé à un autre client.' },
  contact: { email: 'Cette adresse e-mail est déjà utilisée par un contact.', phone: 'Ce numéro de téléphone est déjà utilisé par un contact.' },
};
/** Aucune information sur l'autre fiche n'est divulguée. */
const conflict = (e: Entry, source: Source) => new AppError(409, MESSAGE[source][e.kind], 'DUPLICATE_CONTACT_DETAILS', { field: e.field, kind: e.kind, usedBy: source });

/** Constitue le registre à partir des fiches existantes (une fois par société, idempotent) : les doublons antérieurs sont conservés. */
export async function ensureContactKeys(companyId: Id) {
  const s = await Setting.findOne({ companyId }).select('contactKeysInitialisedAt').lean();
  if (!s || s.contactKeysInitialisedAt) return;
  for await (const c of Customer.find({ companyId }).sort({ createdAt: 1, _id: 1 }).select('address email phone secondaryPhone contacts').lean().cursor()) {
    for (const e of dedupe(entriesOf(c as Party)).values()) {
      const add = () => ContactKey.updateOne({ companyId, kind: e.kind, value: e.value, 'owners.customerId': { $ne: c._id } }, { $push: { owners: { customerId: c._id, source: e.source } } }, { upsert: true });
      // Doublon d'index : soit la fiche possède déjà la valeur, soit une création concurrente vient d'avoir lieu (nouvel essai)
      await add().catch(async (err) => { if ((err as { code?: number }).code !== 11000) throw err; await add().catch((again) => { if ((again as { code?: number }).code !== 11000) throw again; }); });
    }
  }
  await Setting.updateOne({ companyId }, { contactKeysInitialisedAt: new Date() });
}
/** Une entrée par valeur ; la coordonnée de la société prime sur celle d'un de ses contacts. */
const dedupe = (entries: Entry[]) => { const m = new Map<string, Entry>(); for (const e of entries) if (!m.has(e.key) || e.source === 'customer') m.set(e.key, e); return m; };

/**
 * Réserve les coordonnées d'une fiche dans la transaction d'écriture. Refusé : une valeur NOUVELLE pour cette fiche déjà
 * portée par un autre client ou contact, ou utilisée par deux de ses contacts. Le contact principal peut reprendre les
 * coordonnées de sa propre société (même fiche). Les doublons antérieurs inchangés n'empêchent pas de modifier la fiche.
 */
export async function claim(companyId: Id, customerId: Id, next: Party, previous: Party | null, session: ClientSession) {
  const entries = entriesOf(next); const before = entriesOf(previous);
  const known = new Set(before.map((e) => e.key));
  const count = (list: Entry[], key: string) => list.filter((e) => e.source === 'contact' && e.key === key).length;
  for (const e of entries.filter((x) => x.source === 'contact')) {
    const n = count(entries, e.key);
    if (n > 1 && n > Math.max(1, count(before, e.key))) throw conflict([...entries].reverse().find((x) => x.key === e.key && x.source === 'contact')!, 'contact');
  }
  const wanted = dedupe(entries);
  for (const e of wanted.values()) {
    const doc = await ContactKey.findOne({ companyId, kind: e.kind, value: e.value }).session(session).lean();
    const others = (doc?.owners ?? []).filter((o) => String(o.customerId) !== String(customerId));
    if (others.length && !known.has(e.key)) throw conflict(entries.find((x) => x.key === e.key)!, others.some((o) => o.source === 'customer') ? 'customer' : 'contact');
    const owners = [...others, { customerId, source: e.source }];
    if (doc) await ContactKey.updateOne({ _id: doc._id }, { owners }, { session });
    else await ContactKey.create([{ companyId, kind: e.kind, value: e.value, owners }], { session });
  }
  const held = await ContactKey.find({ companyId, 'owners.customerId': customerId }).session(session).lean();
  for (const k of held.filter((x) => !wanted.has(`${x.kind}|${x.value}`))) await release(k._id, customerId, session);
}
async function release(keyId: Id, customerId: Id, session: ClientSession) {
  await ContactKey.updateOne({ _id: keyId }, { $pull: { owners: { customerId } } }, { session });
  await ContactKey.deleteOne({ _id: keyId, owners: { $size: 0 } }, { session });
}
export async function releaseAll(companyId: Id, customerId: Id, session: ClientSession) {
  for (const k of await ContactKey.find({ companyId, 'owners.customerId': customerId }).session(session).lean()) await release(k._id, customerId, session);
}

/** Transaction d'écriture d'une fiche : une réservation concurrente de la même valeur est rejouée, puis refusée proprement. */
export async function writeUnique<T>(companyId: Id, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  await ensureContactKeys(companyId);
  for (let attempt = 1; ; attempt++) {
    try { return await withTransaction(fn); }
    catch (e) { const err = e as { code?: number; message?: string }; if (attempt >= 5 || err.code !== 11000 || !/contactkeys/i.test(err.message ?? '')) throw e; }
  }
}

export interface DuplicateGroup { kind: Kind; value: string; occurrences: { customerId: string; code: string | null; name: string; source: Source; contactName: string | null; raw: string }[] }
/** Rapport des doublons existants (lecture seule) : coordonnées partagées entre fiches, ou entre deux contacts d'une même fiche. */
export async function findDuplicates(companyId: Id): Promise<DuplicateGroup[]> {
  const groups = new Map<string, DuplicateGroup>();
  for await (const c of Customer.find({ companyId }).sort({ createdAt: 1, _id: 1 }).select('code name address email phone secondaryPhone contacts').lean().cursor()) {
    for (const e of entriesOf(c as Party)) {
      const g = groups.get(e.key) ?? { kind: e.kind, value: e.value, occurrences: [] };
      const idx = /^contacts\.(\d+)\./.exec(e.field)?.[1];
      g.occurrences.push({ customerId: c._id.toString(), code: c.code ?? null, name: c.name, source: e.source, contactName: idx === undefined ? null : c.contacts?.[Number(idx)]?.name ?? null, raw: e.raw });
      groups.set(e.key, g);
    }
  }
  return [...groups.values()].filter((g) => new Set(g.occurrences.map((o) => o.customerId)).size > 1 || g.occurrences.filter((o) => o.source === 'contact').length > 1);
}
