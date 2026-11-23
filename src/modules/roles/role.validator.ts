import { z } from 'zod';
import { isValidPermission } from '../../config/permissions.js';

const permissions = z.array(z.string().refine(isValidPermission, 'Permission inconnue')).max(200);
export const createRoleBody = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).optional(), permissions }).strict();
export const updateRoleBody = createRoleBody.partial().strict();
export { idParam } from '../companies/company.validator.js';
