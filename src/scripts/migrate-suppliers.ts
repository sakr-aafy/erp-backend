import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import '../models/index.js';
import { migrateSuppliers } from '../modules/suppliers/supplier.migration.js';

/**
 * Usage : npm run db:migrate-suppliers [-- --dry-run]
 * Catégories par défaut, codes manquants, statuts, téléphones. Aucune catégorie n'est attribuée à un fournisseur existant.
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
console.log(JSON.stringify(await migrateSuppliers({ dryRun }), null, 2));
await disconnectDb();
