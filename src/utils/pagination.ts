import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  sort: z.string().regex(/^-?[a-zA-Z_.]+$/).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> { items: T[]; total: number; page: number; limit: number }

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Identifiant invalide');
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const exportFormat = z.enum(['xlsx', 'csv', 'pdf']).default('xlsx');

/** Construit un tri Mongo à partir de `sort=-champ`, restreint à une liste blanche. */
export function buildSort(sort: string | undefined, allowed: string[], fallback: Record<string, 1 | -1>): Record<string, 1 | -1> {
  if (!sort) return fallback;
  const field = sort.replace(/^-/, '');
  return allowed.includes(field) ? { [field]: sort.startsWith('-') ? -1 : 1, _id: 1 } : fallback;
}
