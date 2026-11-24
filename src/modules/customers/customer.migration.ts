import { Counter } from '../../models/counter.model.js';
import { Customer, CustomerActivity } from '../../models/customer.model.js';
import { nextDocumentNumber } from '../../services/numbering.service.js';

export interface MigrationReport { scanned: number; coded: number; statusSet: number; defaulted: number; activitiesCreated: number; dryRun: boolean }

/**
 * Migration NON destructive et idempotente des clients existants vers la fiche détaillée :
 *  - identifiants MongoDB et relations conservés (aucun client supprimé ni recréé) ;
 *  - code client CL-00001… attribué dans l'ordre de création aux seuls clients qui n'en ont pas (compteur atomique) ;
 *  - statut dérivé de l'ancien indicateur d'archivage (`isArchived`, conservé) ;
 *  - coordonnées existantes inchangées ; seuls les NOUVEAUX champs manquants reçoivent leur valeur par défaut ;
 *  - événement « Client créé » ajouté une seule fois à la chronologie.
 * Relancer la migration ne produit ni doublon ni changement.
 */
export async function migrateCustomers(opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const dryRun = !!opts.dryRun;
  const report: MigrationReport = { scanned: 0, coded: 0, statusSet: 0, defaulted: 0, activitiesCreated: 0, dryRun };
  const companies = await Customer.distinct('companyId');
  for (const companyId of companies) {
    // Les codes déjà attribués font avancer le compteur (au cas où il serait en retard sur les données)
    const existing = (await Customer.find({ companyId, code: { $type: 'string' } }).select('code').lean()).map((c) => Number(/(\d+)$/.exec(c.code ?? '')?.[1] ?? 0));
    const max = existing.length ? Math.max(...existing) : 0;
    if (!dryRun && max) await Counter.updateOne({ companyId, key: 'customer' }, { $max: { seq: max } }, { upsert: true });
    const cursor = Customer.find({ companyId }).sort({ createdAt: 1, _id: 1 }).lean().cursor();
    for await (const c of cursor) {
      report.scanned++;
      const $set: Record<string, unknown> = {};
      if (!c.code) { report.coded++; if (!dryRun) $set.code = await nextDocumentNumber(companyId, 'customer'); }
      if (!c.status) { report.statusSet++; $set.status = c.isArchived ? 'archived' : 'active'; }
      let defaulted = false;
      if (!c.type) { $set.type = 'company'; defaulted = true; }
      if (c.shippingSameAsBilling == null) { $set.shippingSameAsBilling = true; defaulted = true; }
      if (c.discountPct == null) { $set.discountPct = 0; defaulted = true; }
      if (defaulted) report.defaulted++;
      if (!dryRun && Object.keys($set).length) await Customer.updateOne({ _id: c._id, companyId }, { $set }); // le filtre ne cible que ce client
      if (!(await CustomerActivity.exists({ companyId, customerId: c._id, kind: 'customer_created' }))) {
        report.activitiesCreated++;
        if (!dryRun) await CustomerActivity.create({ companyId, customerId: c._id, auto: true, kind: 'customer_created', title: 'Client créé', occurredAt: (c as { createdAt?: Date }).createdAt ?? new Date(), meta: { migrated: true } });
      }
    }
  }
  return report;
}
