/**
 * Synchronise les index MongoDB de tous les modèles (crée les manquants, supprime les obsolètes).
 * INDISPENSABLE en production : autoIndex y est désactivé, or l'unicité (matricule fiscal, référence article, e-mail…)
 * repose sur ces index. À exécuter après chaque déploiement : npm run db:indexes
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import '../models/index.js';

await connectDb();
for (const model of Object.values(mongoose.models)) {
  const dropped = await model.syncIndexes();
  console.log(`${model.modelName.padEnd(16)} index synchronisés${dropped.length ? ` (supprimés : ${dropped.join(', ')})` : ''}`);
}
await disconnectDb();
