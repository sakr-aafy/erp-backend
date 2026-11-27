import { Quotation, QuotationActivity } from '../../models/sales.model.js';

export interface QuotationMigrationReport {
  dryRun: boolean; scanned: number;
  /** Devis dont les lignes reçoivent une position (10, 20, 30…) selon l'ordre enregistré. */
  positionsInitialised: number;
  /** Devis « en attente » déjà envoyés par e-mail depuis l'ERP : passent à « envoyé ». */
  markedSent: number;
}

/**
 * Migration NON destructive et idempotente (gestion des devis) :
 *  - positions manquantes initialisées dans l'ordre existant ;
 *  - « en attente » avec date d'envoi e-mail → « envoyé » (mode e-mail) ;
 *  - aucun montant recalculé ; numéros, clients, lignes, dates, liens de conversion et documents inchangés ;
 *  - AUCUN historique inventé pour les devis antérieurs.
 */
export async function migrateQuotations(opts: { dryRun?: boolean } = {}): Promise<QuotationMigrationReport> {
  const dryRun = !!opts.dryRun;
  const r: QuotationMigrationReport = { dryRun, scanned: 0, positionsInitialised: 0, markedSent: 0 };
  const raw = Quotation.collection; // écritures ciblées : les autres champs ne sont pas réécrits
  for await (const q of raw.find({}, { sort: { _id: 1 }, projection: { lines: 1, status: 1, sentAt: 1, sentMethod: 1 } })) {
    r.scanned++;
    const $set: Record<string, unknown> = {};
    const lines = (q.lines ?? []) as { position?: number }[];
    if (lines.some((l) => l.position === undefined || l.position === null)) { lines.forEach((_, i) => { $set[`lines.${i}.position`] = (i + 1) * 10; }); r.positionsInitialised++; }
    if (q.status === 'pending' && q.sentAt) { $set.status = 'sent'; if (!q.sentMethod) $set.sentMethod = 'email'; r.markedSent++; }
    if (!dryRun && Object.keys($set).length) await raw.updateOne({ _id: q._id, status: q.status }, { $set });
  }
  if (!dryRun) await QuotationActivity.createCollection().catch(() => undefined);
  return r;
}
