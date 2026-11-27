import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import '../models/index.js';
import { migrateQuotations } from '../modules/quotations/quotation.migration.js';

/**
 * Usage : npm run db:migrate-quotations [-- --dry-run]
 * Positions des lignes et statut « envoyé » des devis déjà expédiés. Aucun montant n’est recalculé, aucun historique inventé.
 * Sans --dry-run, exige --backup-done : lancez d'abord `infra/backup.sh` (dump MongoDB) pour pouvoir revenir en arrière.
 * Ensuite : `npm run db:indexes`.
 */
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--backup-done')) {
  console.error('Refusé : sauvegardez d’abord la base (infra/backup.sh) puis relancez avec --backup-done (ou essayez --dry-run).');
  process.exit(2);
}
await connectDb();
console.log(`Base : ${mongoose.connection.name}${dryRun ? ' (simulation, aucune écriture)' : ''}`);
console.log(JSON.stringify(await migrateQuotations({ dryRun }), null, 2));
await disconnectDb();
