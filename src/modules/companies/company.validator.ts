import { z } from 'zod';
import { passwordSchema } from '../../services/password.service.js';

const companyFields = {
  name: z.string().trim().min(2).max(150),
  taxId: z.string().trim().max(50).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.email().optional(),
};
export const createCompanyBody = z.object({
  company: z.object(companyFields).strict(),
  admin: z.object({ name: z.string().trim().min(2).max(100), username: z.string().trim().min(3).max(50), email: z.email(), password: passwordSchema }).strict(),
}).strict();
export const updateCompanyBody = z.object(companyFields).partial().strict();
export const setActiveBody = z.object({ isActive: z.boolean() }).strict();
export const idParam = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Identifiant invalide') });
