import { Customer } from '../../models/customer.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { normalizePhone, phoneInfo } from '../../utils/phone.js';
import { legacyDeliveryAddress } from './delivery-address.js';

export interface PhoneIssue { customer: string; field: string; value: string }
export interface PartyMigrationReport {
  dryRun: boolean; customersScanned: number; suppliersScanned: number;
  /** Clients dont la liste d'adresses de livraison a été créée / dont l'ancienne adresse unique a été convertie. */
  addressListsCreated: number; addressesConverted: number; supplierListsCreated: number;
  /** Clients sans réglage fiscal enregistré : leur valeur effective actuelle (non) est écrite, pour que le nouveau défaut ne s'y applique pas. */
  fiscalPreserved: number;
  phonesNormalized: number; phonesUnrecognized: PhoneIssue[];
}

/**
 * Migration NON destructive et idempotente (corrections de la fiche client) :
 *  - ancienne adresse de livraison → liste `deliveryAddresses` (les anciens champs sont conservés) ;
 *  - téléphones reconnus → format international E.164 (saisie d'origine gardée dans `phoneOriginals`) ; les autres restent inchangés et sont listés ;
 *  - réglages fiscaux absents figés à leur valeur effective actuelle ;
 *  - aucun identifiant, aucun document commercial, aucune valeur RC / secteur n'est modifié ou supprimé.
 */
export async function migrateParties(opts: { dryRun?: boolean } = {}): Promise<PartyMigrationReport> {
  const dryRun = !!opts.dryRun;
  const r: PartyMigrationReport = { dryRun, customersScanned: 0, suppliersScanned: 0, addressListsCreated: 0, addressesConverted: 0, supplierListsCreated: 0, fiscalPreserved: 0, phonesNormalized: 0, phonesUnrecognized: [] };

  for await (const c of Customer.find().sort({ _id: 1 }).lean().cursor()) {
    r.customersScanned++;
    const $set: Record<string, unknown> = {};
    if (!c.deliveryAddresses) {
      const legacy = legacyDeliveryAddress(c);
      $set.deliveryAddresses = legacy ? [legacy] : [];
      r.addressListsCreated++; if (legacy) r.addressesConverted++;
    }
    let pinned = false;
    for (const k of ['subjectToWithholding', 'stampExempt'] as const) if (c[k] === undefined || c[k] === null) { $set[k] = false; pinned = true; }
    if (pinned) r.fiscalPreserved++;

    const country = c.address?.country; const originals: Record<string, string> = {};
    const phone = (field: string, key: string, value: string | null | undefined) => {
      if (!value) return;
      const next = normalizePhone(value, country);
      if (!phoneInfo(next, country)!.valid) { r.phonesUnrecognized.push({ customer: c.code ?? c._id.toString(), field, value }); return; }
      if (next !== value) { $set[key] = next; originals[key.replace(/\./g, '_')] = value; r.phonesNormalized++; }
    };
    phone('téléphone', 'phone', c.phone); phone('téléphone secondaire', 'secondaryPhone', c.secondaryPhone);
    (c.contacts ?? []).forEach((k, i) => phone(`contact « ${k.name} »`, `contacts.${i}.phone`, k.phone));
    for (const [k, v] of Object.entries(originals)) $set[`phoneOriginals.${k}`] = v;

    if (!dryRun && Object.keys($set).length) await Customer.updateOne({ _id: c._id, companyId: c.companyId }, { $set }, { timestamps: false });
  }

  // Les fournisseurs n'avaient pas d'adresse de livraison : la liste est initialisée vide, leur adresse principale reste inchangée
  for await (const s of Supplier.find().sort({ _id: 1 }).lean().cursor()) {
    r.suppliersScanned++;
    if (s.deliveryAddresses) continue;
    r.supplierListsCreated++;
    if (!dryRun) await Supplier.updateOne({ _id: s._id, companyId: s.companyId }, { $set: { deliveryAddresses: [] } }, { timestamps: false });
  }
  return r;
}
