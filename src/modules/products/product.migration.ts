import { Product, ProductActivity } from '../../models/product.model.js';

export interface ProductMigrationReport { scanned: number; statusSet: number; activitiesCreated: number; dryRun: boolean }

/**
 * Migration NON destructive et idempotente des articles existants vers la fiche détaillée :
 *  - identifiants MongoDB, codes (références), désignations, prix, catégories, unités, numéros de série, mouvements, coûts et relations conservés ;
 *  - `status` dérivé de l'ancien indicateur `isActive` (actif → active, inactif → inactive) ; `isActive` est conservé et synchronisé ;
 *  - aucun autre champ n'est initialisé (marque, packaging, douane… restent absents tant qu'ils ne sont pas renseignés) ;
 *  - événement « Article créé » ajouté une seule fois à la chronologie (daté de la création de l'article).
 * La collection Products n'est jamais supprimée ni recréée. Relancer la migration ne change rien.
 */
export async function migrateProducts(opts: { dryRun?: boolean } = {}): Promise<ProductMigrationReport> {
  const dryRun = !!opts.dryRun; const report: ProductMigrationReport = { scanned: 0, statusSet: 0, activitiesCreated: 0, dryRun };
  const cursor = Product.find({}).sort({ createdAt: 1, _id: 1 }).lean().cursor();
  for await (const p of cursor) {
    report.scanned++;
    if (!p.status) { report.statusSet++; if (!dryRun) await Product.updateOne({ _id: p._id, companyId: p.companyId, status: { $exists: false } }, { $set: { status: p.isActive === false ? 'inactive' : 'active' } }); }
    if (!(await ProductActivity.exists({ companyId: p.companyId, productId: p._id, kind: 'product_created' }))) {
      report.activitiesCreated++;
      if (!dryRun) await ProductActivity.create({ companyId: p.companyId, productId: p._id, auto: true, kind: 'product_created', title: 'Article créé', occurredAt: (p as { createdAt?: Date }).createdAt ?? new Date(), meta: { migrated: true, reference: p.reference } });
    }
  }
  return report;
}
