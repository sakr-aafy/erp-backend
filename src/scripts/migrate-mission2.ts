import { writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { migrateMission2 } from '../modules/migrations/mission2.migration.js';

/**
 * Usage : npm run db:migrate-mission2 -- --dry-run [--report rapport.json]
 *         npm run db:migrate-mission2 -- --backup-done [--report rapport.json]
 * Après la migration de la mission 1. Sans --dry-run, exige --backup-done (infra/backup.sh). Ensuite : `npm run db:indexes`.
 */
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--backup-done')) {
  console.error('Refusé : sauvegardez d’abord la base (infra/backup.sh) puis relancez avec --backup-done (ou essayez --dry-run).');
  process.exit(2);
}
// Simulation : aucune collection ni aucun index créé à la connexion
if (dryRun) { mongoose.set('strictQuery', true); await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false }); } else await connectDb();
console.log(`Base : ${mongoose.connection.name}${dryRun ? ' (simulation, aucune écriture)' : ''}`);
const report = await migrateMission2({ dryRun });
const i = process.argv.indexOf('--report'); if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, JSON.stringify(report, null, 2));
for (const c of report.companies) console.log(JSON.stringify(c, null, 2));
await disconnectDb();
