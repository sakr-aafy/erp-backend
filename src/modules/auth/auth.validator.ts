import { z } from 'zod';
import { passwordSchema } from '../../services/password.service.js';

export const loginBody = z.object({ email: z.email().max(200), password: z.string().min(1).max(128) }).strict();
export const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }).strict();
export const forgotBody = z.object({ email: z.email() }).strict();
export const resetBody = z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema }).strict();
