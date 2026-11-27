import type { ClientSession, Types } from 'mongoose';
import { Company } from '../../models/company.model.js';
import { Role } from '../../models/role.model.js';
import { User } from '../../models/user.model.js';
import { Setting } from '../../models/setting.model.js';
import { hashPassword } from '../../services/password.service.js';
import { withTransaction } from '../../utils/transaction.js';
import { ALL_PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../utils/errors.js';
import { initSupplierCategories } from '../suppliers/supplier.categories.js';

export const ADMIN_ROLE_NAME = 'Administrateur';

export interface NewCompanyInput {
  company: { name: string; taxId?: string; address?: string; phone?: string; email?: string };
  admin: { name: string; username: string; email: string; password: string; isPlatformAdmin?: boolean };
}

/** Crée atomiquement : société + rôle Administrateur (système) + paramètres vides + premier administrateur. */
export async function createCompanyWithAdmin(input: NewCompanyInput) {
  const created = await withTransaction(async (session: ClientSession) => {
    if (await User.exists({ email: input.admin.email.toLowerCase() }).session(session)) throw AppError.conflict('E-mail déjà utilisé');
    const [company] = await Company.create([input.company], { session });
    const [role] = await Role.create([{ companyId: company!._id, name: ADMIN_ROLE_NAME, description: 'Accès complet', isSystem: true, permissions: ALL_PERMISSIONS }], { session });
    await Setting.create([{ companyId: company!._id }], { session });
    const [user] = await User.create([{
      companyId: company!._id, roleId: role!._id, name: input.admin.name, username: input.admin.username,
      email: input.admin.email, passwordHash: await hashPassword(input.admin.password), isPlatformAdmin: input.admin.isPlatformAdmin ?? false,
    }], { session });
    return { company: company!, role: role!, user: user! };
  });
  await initSupplierCategories(created.company._id); // catégories de fournisseurs proposées (administrables ensuite)
  return created;
}

export const getCompany = async (id: Types.ObjectId) => {
  const c = await Company.findById(id).lean();
  if (!c) throw AppError.notFound('Société introuvable');
  return c;
};
