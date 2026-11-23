/** Crée la première société + l'administrateur de plateforme si la base est vide. Idempotent. */
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { Company } from '../models/company.model.js';
import { User } from '../models/user.model.js';
import { createCompanyWithAdmin } from '../modules/companies/company.service.js';
import { passwordSchema } from '../services/password.service.js';

import '../models/index.js';
import mongoose from 'mongoose';

await connectDb();
// Les index d'unicité doivent exister avant toute écriture (autoIndex désactivé en production)
for (const m of Object.values(mongoose.models)) await m.syncIndexes();
if (await Company.exists({})) {
  console.log('Base déjà initialisée : rien à faire.');
} else {
  const pwd = env.SEED_ADMIN_PASSWORD;
  const check = passwordSchema.safeParse(pwd);
  if (!check.success) { console.error('SEED_ADMIN_PASSWORD manquant ou non conforme à la politique de mot de passe.'); process.exit(1); }
  const r = await createCompanyWithAdmin({
    company: { name: env.SEED_COMPANY_NAME },
    admin: { name: 'Administrateur', username: 'admin', email: env.SEED_ADMIN_EMAIL, password: pwd!, isPlatformAdmin: true },
  });
  await User.updateOne({ _id: r.user._id }, { mustChangePassword: true });
  console.log(`Société « ${r.company.name} » créée. Admin : ${env.SEED_ADMIN_EMAIL} (changement de mot de passe exigé à la 1re connexion).`);
}
await disconnectDb();
