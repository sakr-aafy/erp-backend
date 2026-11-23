import bcrypt from 'bcrypt';
import { z } from 'zod';
import { env } from '../config/env.js';

/** Politique minimale (spec module 16) : 10+ caractères, majuscule, minuscule, chiffre, caractère spécial. */
export const passwordSchema = z
  .string()
  .min(10, 'Au moins 10 caractères')
  .max(128)
  .regex(/[a-z]/, 'Au moins une minuscule')
  .regex(/[A-Z]/, 'Au moins une majuscule')
  .regex(/[0-9]/, 'Au moins un chiffre')
  .regex(/[^A-Za-z0-9]/, 'Au moins un caractère spécial');

export const hashPassword = (p: string) => bcrypt.hash(p, env.BCRYPT_ROUNDS);
export const verifyPassword = (p: string, hash: string) => bcrypt.compare(p, hash);
