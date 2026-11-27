import type { Types } from 'mongoose';
import { Supplier } from '../../models/supplier.model.js';
import { Company } from '../../models/company.model.js';
import { Counter } from '../../models/counter.model.js';
import { nextDocumentNumber } from '../../services/numbering.service.js';
import { normalizePhone, phoneInfo } from '../../utils/phone.js';
import { initSupplierCategories } from './supplier.categories.js';

/** Attribue un code aux fournisseurs qui n'en ont pas (ordre de création, compteur atomique) ; un code existant n'est jamais remplacé. */
export async function assignSupplierCodes(dryRun: boolean) {
  let assigned = 0;
  for (const companyId of (await Supplier.distinct('companyId')) as Types.ObjectId[]) {
    const used = (await Supplier.find({ companyId, code: { $type: 'string' } }).select('code').lean()).map((x) => Number(/(\d+)$/.exec(x.code ?? '')?.[1] ?? 0));
    if (!dryRun && used.length) await Counter.updateOne({ companyId, key: 'supplier' }, { $max: { seq: Math.max(...used) } }, { upsert: true });
    for await (const s of Supplier.find({ companyId, code: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).select('_id').lean().cursor()) {
      assigned++;
      if (!dryRun) await Supplier.updateOne({ _id: s._id, companyId }, { $set: { code: await nextDocumentNumber(companyId, 'supplier') } }, { timestamps: false });
    }
  }
  return assigned;
}

export interface SupplierMigrationReport {
  dryRun: boolean; suppliersScanned: number;
  /** Catégories par défaut créées (une seule fois par société). */
  categoriesCreated: number;
  codesAssigned: number;
  /** Statut métier initialisé depuis `isArchived`. */
  statusInitialised: number;
  deliveryListsCreated: number; phonesNormalized: number;
  phonesUnrecognized: { supplier: string; field: string; value: string }[];
  /** Fournisseurs sans catégorie : à classer manuellement (aucune catégorie n'est attribuée automatiquement). */
  unclassified: number;
  /** Fournisseurs étrangers sans devise : à compléter avant toute modification de leur fiche. */
  foreignWithoutCurrency: string[];
}

/**
 * Migration NON destructive et idempotente (fiche fournisseur) :
 *  - catégories par défaut, codes manquants, statut, liste d'adresses ;
 *  - téléphones reconnus → E.164 (saisie d'origine gardée dans `phoneOriginals`) ; les autres restent inchangés et sont listés ;
 *  - identifiants, coordonnées, soldes, seuils, devises, relations et documents d'achat ne sont jamais modifiés.
 */
export async function migrateSuppliers(opts: { dryRun?: boolean } = {}): Promise<SupplierMigrationReport> {
  const dryRun = !!opts.dryRun;
  const r: SupplierMigrationReport = { dryRun, suppliersScanned: 0, categoriesCreated: 0, codesAssigned: 0, statusInitialised: 0, deliveryListsCreated: 0, phonesNormalized: 0, phonesUnrecognized: [], unclassified: 0, foreignWithoutCurrency: [] };
  for (const c of await Company.find().select('_id').lean()) r.categoriesCreated += await initSupplierCategories(c._id, { dryRun });
  r.codesAssigned = await assignSupplierCodes(dryRun);

  const raw = Supplier.collection; // lecture brute : un champ absent doit rester distinguable de sa valeur par défaut
  for await (const s of raw.find({}, { sort: { _id: 1 } })) {
    r.suppliersScanned++;
    const label = (s.code as string | undefined) ?? String(s._id);
    const $set: Record<string, unknown> = {};
    if (!s.status) { $set.status = s.isArchived ? 'archived' : 'active'; r.statusInitialised++; }
    if (!s.deliveryAddresses) { $set.deliveryAddresses = []; r.deliveryListsCreated++; }
    if (!s.categoryId) r.unclassified++;
    if (s.isForeign && !s.currency) r.foreignWithoutCurrency.push(label);

    const country = (s.address as { country?: string } | undefined)?.country || (s.isForeign ? 'inconnu' : undefined);
    const originals: Record<string, string> = {};
    const phone = (field: string, key: string, value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return;
      const next = normalizePhone(value, country);
      if (!phoneInfo(next, country)!.valid) { r.phonesUnrecognized.push({ supplier: label, field, value }); return; }
      if (next !== value) { $set[key] = next; originals[key.replace(/\./g, '_')] = value; r.phonesNormalized++; }
    };
    phone('téléphone', 'phone', s.phone); phone('téléphone secondaire', 'secondaryPhone', s.secondaryPhone);
    ((s.contacts ?? []) as { name?: string; phone?: string }[]).forEach((k, i) => phone(`contact « ${k.name} »`, `contacts.${i}.phone`, k.phone));
    for (const [k, v] of Object.entries(originals)) $set[`phoneOriginals.${k}`] = v;

    if (!dryRun && Object.keys($set).length) await raw.updateOne({ _id: s._id }, { $set });
  }
  return r;
}
