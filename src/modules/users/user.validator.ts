import { z } from 'zod';
import { passwordSchema } from '../../services/password.service.js';
import { paginationQuery } from '../../utils/pagination.js';

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Identifiant invalide');
export const createUserBody = z.object({
  name: z.string().trim().min(2).max(100), username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.email(), password: passwordSchema, roleId: oid, mustChangePassword: z.boolean().optional(),
}).strict();
export const updateUserBody = z.object({ name: z.string().trim().min(2).max(100), email: z.email(), roleId: oid }).partial().strict();
export const setActiveBody = z.object({ isActive: z.boolean() }).strict();
export const resetPasswordBody = z.object({ newPassword: passwordSchema }).strict();
export const listQuery = paginationQuery.extend({
  status: z.enum(['active', 'inactive']).optional(), roleId: oid.optional(),
});
export { idParam } from '../companies/company.validator.js';
