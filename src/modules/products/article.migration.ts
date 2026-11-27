import { Setting } from '../../models/setting.model.js';
import { Category, Product } from '../../models/product.model.js';
import { DEFAULT_ESTIMATE_RATES } from './estimate-rate.js';
import { needsDimensionReview, volumeM3 } from './product.pricing.js';
import { assignSupplierCodes } from '../suppliers/supplier.migration.js';

export interface ArticleMigrationReport {
  dryRun: boolean;
  /** Sociétés où le taux estimatif a été initialisé. */
  estimateRatesInitialised: number;
  /** Fournisseurs sans code ayant reçu un code FR-xxxxx. */
  supplierCodes: number;
  productsScanned: number;
  /** Données historiques conservées telles quelles (plus affichées). */
  productsWithBrandOrModel: number;
  /** Prix d'achat en devise avec contre-valeur au taux réel déjà enregistrée : conservés. */
  foreignWithRecordedRate: number;
  /** Articles dont les dimensions décrivaient un seul colis parmi plusieurs : à vérifier par un utilisateur. */
  dimensionsToReview: { reference: string; name: string; parcelCount: number; volumePerParcelM3: number | null; previousTotalM3: number | null }[];
  /** Noms en double au même niveau (casse ignorée) : à renommer avant de synchroniser les index. */
  duplicateCategories: { companyId: string; parent: string | null; names: string[] }[];
}

/**
 * Migration NON destructive et idempotente (corrections de la fiche article) :
 *  - initialise le taux estimatif des sociétés qui n'en ont pas ;
 *  - attribue un code aux fournisseurs qui n'en ont pas (ordre de création, compteur atomique) ;
 *  - NE MODIFIE AUCUN ARTICLE : marque, modèle, colis, prix, coûts, stock et relations sont conservés ;
 *  - rapporte les dimensions à vérifier et les catégories en double.
 */
export async function migrateArticles(opts: { dryRun?: boolean } = {}): Promise<ArticleMigrationReport> {
  const dryRun = !!opts.dryRun;
  const r: ArticleMigrationReport = { dryRun, estimateRatesInitialised: 0, supplierCodes: 0, productsScanned: 0, productsWithBrandOrModel: 0, foreignWithRecordedRate: 0, dimensionsToReview: [], duplicateCategories: [] };

  const settings = Setting.collection; // lecture brute : un champ absent doit rester distinguable de sa valeur par défaut
  for (const s of await settings.find({ $or: [{ estimateRates: { $exists: false } }, { estimateRates: { $size: 0 } }] }).toArray()) {
    r.estimateRatesInitialised++;
    if (!dryRun) await settings.updateOne({ _id: s._id }, { $set: { estimateRates: DEFAULT_ESTIMATE_RATES.map((x) => ({ ...x, updatedAt: new Date() })) } });
  }

  r.supplierCodes = await assignSupplierCodes(dryRun);

  for await (const p of Product.find().sort({ _id: 1 }).lean().cursor()) {
    r.productsScanned++;
    if (p.brand || p.model) r.productsWithBrandOrModel++;
    if (p.purchaseCurrency && p.purchaseRate) r.foreignWithRecordedRate++;
    if (needsDimensionReview(p.packaging)) r.dimensionsToReview.push({ reference: p.reference, name: p.name, parcelCount: p.packaging!.parcelCount!, volumePerParcelM3: volumeM3(p.packaging), previousTotalM3: p.packaging!.totalVolumeM3 ?? null });
  }

  const groups = await Category.aggregate<{ _id: { c: unknown; p: unknown; n: string }; names: string[] }>([
    { $group: { _id: { c: '$companyId', p: '$parentId', n: { $toLower: '$name' } }, names: { $push: '$name' } } }, { $match: { 'names.1': { $exists: true } } },
  ]);
  r.duplicateCategories = groups.map((g) => ({ companyId: String(g._id.c), parent: g._id.p ? String(g._id.p) : null, names: g.names }));
  return r;
}
