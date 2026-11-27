import { writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { migrateMission1 } from '../modules/migrations/mission1.migration.js';

/**
 * Usage : npm run db:migrate-mission1 -- --dry-run [--report rapport.json]
 *         npm run db:migrate-mission1 -- --backup-done [--report rapport.json]
 * Sans --dry-run, exige --backup-done : lancez d'abord `infra/backup.sh`. Ensuite : `npm run db:indexes`.
 */
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--backup-done')) {
  console.error('Refusé : sauvegardez d’abord la base (infra/backup.sh) puis relancez avec --backup-done (ou essayez --dry-run).');
  process.exit(2);
}
// Simulation : aucune collection ni aucun index créé à la connexion
if (dryRun) { mongoose.set('strictQuery', true); await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false }); } else await connectDb();
console.log(`Base : ${mongoose.connection.name}${dryRun ? ' (simulation, aucune écriture)' : ''}`);
const report = await migrateMission1({ dryRun });
const i = process.argv.indexOf('--report'); if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, JSON.stringify(report, null, 2));
for (const c of report.companies) {
  console.log(JSON.stringify({ société: c.companyId, conditionsAajouter: c.paymentTerms.toCreate, unités: c.units.fixed.map((u) => `${u.key}: ${u.action} (${u.code})`), unitésHistoriques: c.units.historical,
    quantitésIncompatibles: c.incompatibleQuantities.length, exemples: c.incompatibleQuantities.slice(0, 10), doublonsCoordonnées: c.contactDuplicates.map((d) => `${d.kind} ${d.value} : ${d.occurrences.map((o) => `${o.code ?? o.name}${o.contactName ? ` (contact ${o.contactName})` : ''}`).join(', ')}`), devis: c.quotations }, null, 2));
}
console.log(JSON.stringify({ positions: report.positions }));
await disconnectDb();
