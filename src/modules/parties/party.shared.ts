import { Schema } from 'mongoose';
import { z } from 'zod';

export const normalizeTaxId = (v: string | undefined | null) => {
  const s = (v ?? '').replace(/\s+/g, '').toUpperCase();
  return s || undefined;
};

export const contactSchema = new Schema(
  { name: { type: String, required: true, trim: true }, role: { type: String, trim: true }, email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true }, isPrimary: { type: Boolean, default: false } },
  { _id: true },
);
export const addressSchema = new Schema(
  { street: { type: String, trim: true }, city: { type: String, trim: true }, postalCode: { type: String, trim: true }, country: { type: String, trim: true } },
  { _id: false },
);

export const contactZ = z.object({
  _id: z.string().optional(), name: z.string().trim().min(1).max(100), role: z.string().trim().max(80).optional(),
  email: z.email().optional().or(z.literal('').transform(() => undefined)), phone: z.string().trim().max(30).optional(), isPrimary: z.boolean().optional(),
}).strict();
export const addressZ = z.object({
  street: z.string().trim().max(200).optional(), city: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(20).optional(), country: z.string().trim().max(60).optional(),
}).strict();

/** Champs communs client / fournisseur. */
export const partyFields = {
  name: z.string().trim().min(2).max(150),
  // null = effacer la valeur (modification)
  taxId: z.string().trim().max(40).nullable().optional().or(z.literal('').transform(() => undefined)),
  address: addressZ.optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.email().nullable().optional().or(z.literal('').transform(() => undefined)),
  contacts: z.array(contactZ).max(20).optional(),
  paymentTerms: z.string().trim().max(80).nullable().optional(),
  paymentDelayDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
};
export const minorInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Un seul contact principal. */
export function normalizeContacts<T extends { isPrimary?: boolean }>(contacts: T[] | undefined): T[] | undefined {
  if (!contacts) return contacts;
  let seen = false;
  return contacts.map((c) => { const p = !!c.isPrimary && !seen; if (p) seen = true; return { ...c, isPrimary: p }; });
}

/** Retire les valeurs null/undefined d'un objet (création). */
export const dropNulls = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
