/**
 * Réinitialise la base DÉDIÉE aux tests E2E (jamais une autre) : suppression, index, société + administrateur de test.
 * Garde-fous : le nom de la base doit contenir « e2e » et NODE_ENV ne doit pas être « production ».
 * Identifiants de test (sans valeur : base jetable) : admin@e2e.test / E2e#Password2026
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { User } from '../models/user.model.js';
import { createCompanyWithAdmin } from '../modules/companies/company.service.js';

const dbName = new URL(env.MONGO_URI.replace('mongodb://', 'http://')).pathname.slice(1);
if (env.NODE_ENV === 'production' || !/e2e/i.test(dbName)) { console.error(`Refus : « ${dbName} » n'est pas une base E2E (le nom doit contenir « e2e »).`); process.exit(1); }
await connectDb();
await mongoose.connection.dropDatabase();
for (const m of Object.values(mongoose.models)) await m.syncIndexes();
const r = await createCompanyWithAdmin({ company: { name: 'Société E2E' }, admin: { name: 'Administrateur E2E', username: 'admin', email: 'admin@e2e.test', password: 'E2e#Password2026', isPlatformAdmin: true } });
await User.updateOne({ _id: r.user._id }, { mustChangePassword: false });
console.log(`Base « ${dbName} » réinitialisée (admin@e2e.test).`);
await disconnectDb();
