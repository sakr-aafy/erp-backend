import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import '../models/index.js';
import { migrateParties } from '../modules/parties/party.migration.js';

/**
 * Usage : npm run db:migrate-parties [-- --dry-run]
 * Adresses de livraison multiples, téléphones au format international, réglages fiscaux préservés.
 * Sans --dry-run, exige --backup-done : lancez d'abord `infra/backup.sh` (dump MongoDB) pour pouvoir revenir en arrière.
 */
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--backup-done')) {
  console.error('Refusé : sauvegardez d’abord la base (infra/backup.sh) puis relancez avec --backup-done (ou essayez --dry-run).');
  process.exit(2);
}
await connectDb();
console.log(`Base : ${mongoose.connection.name}${dryRun ? ' (simulation, aucune écriture)' : ''}`);
console.log(JSON.stringify(await migrateParties({ dryRun }), null, 2));
await disconnectDb();
