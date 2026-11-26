import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import '../models/index.js';
import { migrateArticles } from '../modules/products/article.migration.js';

/**
 * Usage : npm run db:migrate-articles [-- --dry-run]
 * Taux estimatif, codes fournisseurs, rapport des dimensions à vérifier. Aucun article n'est modifié.
 * Sans --dry-run, exige --backup-done : lancez d'abord `infra/backup.sh` (dump MongoDB) pour pouvoir revenir en arrière.
 * Ensuite : `npm run db:indexes` (codes fournisseurs uniques, noms de catégories uniques sans tenir compte de la casse).
 */
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--backup-done')) {
  console.error('Refusé : sauvegardez d’abord la base (infra/backup.sh) puis relancez avec --backup-done (ou essayez --dry-run).');
  process.exit(2);
}
await connectDb();
console.log(`Base : ${mongoose.connection.name}${dryRun ? ' (simulation, aucune écriture)' : ''}`);
console.log(JSON.stringify(await migrateArticles({ dryRun }), null, 2));
await disconnectDb();
