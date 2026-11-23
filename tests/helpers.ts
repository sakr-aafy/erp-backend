import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDb } from '../src/config/db.js';
import { createCompanyWithAdmin } from '../src/modules/companies/company.service.js';
import { Role } from '../src/models/role.model.js';
import { User } from '../src/models/user.model.js';
import { hashPassword } from '../src/services/password.service.js';

export const app = createApp();
export const PWD = 'Str0ng#Passw0rd';

export async function setupDb() {
  await connectDb();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}
export const teardownDb = () => mongoose.disconnect();

export async function makeCompany(name: string, adminEmail: string, platform = false) {
  const r = await createCompanyWithAdmin({ company: { name }, admin: { name: `Admin ${name}`, username: 'admin', email: adminEmail, password: PWD, isPlatformAdmin: platform } });
  return { companyId: r.company._id, adminId: r.user._id, adminRoleId: r.role._id };
}
export async function makeUser(companyId: mongoose.Types.ObjectId, email: string, permissions: string[]) {
  const role = await Role.create({ companyId, name: `role-${email}`, permissions });
  const user = await User.create({ companyId, roleId: role._id, name: email, username: email.split('@')[0]!, email, passwordHash: await hashPassword(PWD) });
  return { user, role };
}
export async function login(email: string, password = PWD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { res, token: res.body.accessToken as string, cookie: (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] };
}
export const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

export const binaryParser = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
};
export async function parseXlsx(buf: Buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never);
  const ws = wb.worksheets[0]!; const rows: string[][] = [];
  ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))));
  return rows;
}
/** Société + administrateur + connexion ; renvoie un jeton. */
export async function companyWithAdmin(name: string, email: string) {
  const c = await makeCompany(name, email);
  const { token } = await login(email);
  return { ...c, token };
}

import { FiscalRule } from '../src/models/fiscal-rule.model.js';
/** Insère des règles de TVA VALIDÉES (les tests simulent l'action d'un comptable) — jamais présentes par défaut. */
export async function seedVat(companyId: mongoose.Types.ObjectId, rules: { code: string; ratePct?: number; regime?: 'taxable' | 'zero' | 'exempt' | 'suspended'; from?: string; active?: boolean }[]) {
  for (const r of rules) {
    await FiscalRule.create({ companyId, kind: 'vat', code: r.code, effectiveFrom: new Date(r.from ?? '2000-01-01'), status: 'validated', validatedAt: new Date(), active: r.active ?? true,
      vat: { regime: r.regime ?? 'taxable', ratePct: r.ratePct ?? 0 } });
  }
}

/** Extrait le texte d'un PDF non compressé (pdfkit en test) : concatène les chaînes hexadécimales des opérateurs TJ. */
export function pdfText(buf: Buffer): string {
  const out: string[] = [];
  for (const m of buf.toString('latin1').matchAll(/\[(.*?)\]\s*TJ/g)) out.push([...m[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''));
  return out.join('\n');
}
