import type { Types } from 'mongoose';
import { User } from '../../models/user.model.js';
import { Role } from '../../models/role.model.js';
import { hashPassword } from '../../services/password.service.js';
import { revokeAllUserTokens } from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex, type PaginationQuery } from '../../utils/pagination.js';

const toDto = (u: any) => ({
  id: u._id.toString(), name: u.name, username: u.username, email: u.email, isActive: u.isActive,
  roleId: (u.roleId?._id ?? u.roleId)?.toString(), roleName: u.roleId?.name, mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
});

async function assertRole(companyId: Types.ObjectId, roleId: string) {
  if (!(await Role.exists({ _id: roleId, companyId }))) throw AppError.badRequest('Rôle invalide');
}
async function findOwn(companyId: Types.ObjectId, id: string) {
  const u = await User.findOne({ _id: id, companyId });
  if (!u) throw AppError.notFound('Utilisateur introuvable');
  return u;
}

export async function listUsers(companyId: Types.ObjectId, q: PaginationQuery & { status?: string; roleId?: string }) {
  const filter: Record<string, unknown> = { companyId };
  if (q.status) filter.isActive = q.status === 'active';
  if (q.roleId) filter.roleId = q.roleId;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); filter.$or = [{ name: rx }, { email: rx }, { username: rx }]; }
  const sort: Record<string, 1 | -1> = q.sort ? { [q.sort.replace('-', '')]: q.sort.startsWith('-') ? -1 : 1 } : { name: 1 };
  const [items, total] = await Promise.all([
    User.find(filter).populate('roleId', 'name').sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    User.countDocuments(filter),
  ]);
  return { items: items.map(toDto), total, page: q.page, limit: q.limit };
}
export async function getUser(companyId: Types.ObjectId, id: string) {
  const u = await User.findOne({ _id: id, companyId }).populate('roleId', 'name').lean();
  if (!u) throw AppError.notFound('Utilisateur introuvable');
  return toDto(u);
}
export async function createUser(companyId: Types.ObjectId, d: { name: string; username: string; email: string; password: string; roleId: string; mustChangePassword?: boolean }) {
  await assertRole(companyId, d.roleId);
  const u = await User.create({ companyId, name: d.name, username: d.username, email: d.email, roleId: d.roleId,
    passwordHash: await hashPassword(d.password), mustChangePassword: d.mustChangePassword ?? true });
  return toDto(u.toObject());
}
export async function updateUser(companyId: Types.ObjectId, id: string, d: { name?: string; email?: string; roleId?: string }) {
  const u = await findOwn(companyId, id);
  if (d.roleId) { await assertRole(companyId, d.roleId); u.set('roleId', d.roleId); }
  if (d.name) u.name = d.name;
  if (d.email) u.email = d.email;
  await u.save();
  return toDto(u.toObject());
}
export async function setActive(companyId: Types.ObjectId, actorId: Types.ObjectId, id: string, isActive: boolean) {
  const u = await findOwn(companyId, id);
  if (!isActive && u._id.equals(actorId)) throw AppError.badRequest('Vous ne pouvez pas désactiver votre propre compte');
  u.isActive = isActive;
  await u.save();
  if (!isActive) await revokeAllUserTokens(u._id); // l'access token est rejeté immédiatement par le middleware (relecture en base)
  return toDto(u.toObject());
}
export async function adminResetPassword(companyId: Types.ObjectId, id: string, newPassword: string) {
  const u = await findOwn(companyId, id);
  u.passwordHash = await hashPassword(newPassword); u.mustChangePassword = true; u.passwordChangedAt = new Date();
  u.failedLogins = 0; u.lockUntil = undefined;
  await u.save();
  await revokeAllUserTokens(u._id);
}
/** Rapport : utilisateurs actifs / inactifs. */
export async function userStats(companyId: Types.ObjectId) {
  const [active, inactive] = await Promise.all([User.countDocuments({ companyId, isActive: true }), User.countDocuments({ companyId, isActive: false })]);
  return { active, inactive, total: active + inactive };
}
