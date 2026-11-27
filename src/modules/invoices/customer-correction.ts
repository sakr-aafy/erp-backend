/**
 * Correction des coordonnées du client imprimées sur une facture VALIDÉE. Seule la copie portée par la facture change :
 * numéro, lignes, montants, échéances et écritures restent identiques. Chaque correction est conservée (avant, après, auteur, motif).
 */
import type { Types } from 'mongoose';
import { Invoice } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/phone.js';
import { withTransaction } from '../../utils/transaction.js';
import * as customers from '../customers/customer.service.js';
import { normalizeTaxId } from '../parties/party.shared.js';
import { get } from './invoice.service.js';

type Id = Types.ObjectId;
export interface CustomerCorrectionInput {
  name: string; taxId: string; phone: string; email: string; reason: string; updateCustomer: boolean;
  address: { street: string; city: string; postalCode: string; country: string };
}
export interface PrintedCustomer { name: string; taxId: string; phone: string; email: string; address: CustomerCorrectionInput['address'] }

type Snapshot = { name?: string | null; taxId?: string | null; phone?: string | null; email?: string | null; address?: Partial<Record<keyof PrintedCustomer['address'], string | null>> | null };
const printed = (s: Snapshot): PrintedCustomer => ({
  name: s.name ?? '', taxId: s.taxId ?? '', phone: s.phone ?? '', email: s.email ?? '',
  address: { street: s.address?.street ?? '', city: s.address?.city ?? '', postalCode: s.address?.postalCode ?? '', country: s.address?.country ?? '' },
});

async function validated(companyId: Id, id: string) {
  const inv = await Invoice.findOne({ _id: id, companyId }).lean();
  if (!inv) throw AppError.notFound('Facture introuvable');
  if (inv.type !== 'invoice' || inv.status !== 'validated') throw AppError.conflict('La correction des coordonnées concerne les factures validées ; un brouillon se modifie directement');
  return inv;
}

export async function correctCustomerDetails(companyId: Id, id: string, b: CustomerCorrectionInput, actor: { userId: Id; name: string }) {
  const inv = await validated(companyId, id);
  const before = printed(inv.customerSnapshot as Snapshot);
  const after = printed({ ...b, taxId: normalizeTaxId(b.taxId) ?? '', phone: b.phone ? normalizePhone(b.phone, b.address.country) : '', email: b.email.toLowerCase() });
  if (JSON.stringify(before) === JSON.stringify(after)) throw AppError.conflict('Aucune modification : les coordonnées sont identiques à celles de la facture');

  // La fiche d'abord : ses contrôles d'unicité (matricule, téléphone, e-mail) doivent réussir avant de toucher la facture
  if (b.updateCustomer) {
    await customers.update(companyId, inv.customerId.toString(), { name: after.name, taxId: after.taxId || null, phone: after.phone || null, email: after.email || null, address: after.address }, actor);
  }

  await withTransaction(async (session) => {
    const $set: Record<string, unknown> = { 'customerSnapshot.name': after.name, 'customerSnapshot.address': after.address };
    const $unset: Record<string, 1> = {};
    for (const k of ['taxId', 'phone', 'email'] as const) { if (after[k]) $set[`customerSnapshot.${k}`] = after[k]; else $unset[`customerSnapshot.${k}`] = 1; }
    const done = await Invoice.updateOne({ _id: inv._id, companyId, status: 'validated', updatedAt: inv.updatedAt }, { $set, ...(Object.keys($unset).length && { $unset }),
      $push: { customerCorrections: { at: new Date(), userId: actor.userId, userName: actor.name, reason: b.reason, before, after } } }, { session });
    if (!done.modifiedCount) throw AppError.conflict('La facture a changé entre-temps : rechargez-la puis recommencez');
  });
  return { invoice: await get(companyId, id), before, after };
}
