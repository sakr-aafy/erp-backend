import type { Types } from 'mongoose';
import { Role } from '../../models/role.model.js';
import { User } from '../../models/user.model.js';
import { AppError } from '../../utils/errors.js';

export async function listRoles(companyId: Types.ObjectId) {
  const roles = await Role.find({ companyId }).sort({ name: 1 }).lean();
  const counts = await User.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { companyId } }, { $group: { _id: '$roleId', n: { $sum: 1 } } }]);
  const byRole = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return roles.map((r) => ({ ...r, userCount: byRole.get(r._id.toString()) ?? 0 }));
}
export async function getRole(companyId: Types.ObjectId, id: string) {
  const r = await Role.findOne({ _id: id, companyId }).lean();
  if (!r) throw AppError.notFound('Rôle introuvable');
  return r;
}
export const createRole = (companyId: Types.ObjectId, data: { name: string; description?: string; permissions: string[] }) =>
  Role.create({ ...data, companyId, permissions: [...new Set(data.permissions)] });

export async function updateRole(companyId: Types.ObjectId, id: string, data: { name?: string; description?: string; permissions?: string[] }) {
  const role = await Role.findOne({ _id: id, companyId });
  if (!role) throw AppError.notFound('Rôle introuvable');
  if (role.isSystem) throw AppError.badRequest('Le rôle système ne peut pas être modifié');
  if (data.name !== undefined) role.name = data.name;
  if (data.description !== undefined) role.description = data.description;
  if (data.permissions) role.set('permissions', [...new Set(data.permissions)]);
  await role.save();
  return role;
}
export async function deleteRole(companyId: Types.ObjectId, id: string) {
  const role = await Role.findOne({ _id: id, companyId });
  if (!role) throw AppError.notFound('Rôle introuvable');
  if (role.isSystem) throw AppError.badRequest('Le rôle système ne peut pas être supprimé');
  if (await User.exists({ roleId: role._id })) throw AppError.conflict('Ce rôle est attribué à des utilisateurs');
  await role.deleteOne();
}
