import type { Types } from 'mongoose';
import { AppError } from '../utils/errors.js';

export type ReferencedEntity = 'customer' | 'supplier' | 'product';
type Checker = (companyId: Types.ObjectId, id: Types.ObjectId) => Promise<string | null>;
const checkers = new Map<ReferencedEntity, Checker[]>();

/** Les modules dépendants (devis, factures, stock, achats…) enregistrent ici un contrôle : renvoie un libellé si l'entité est référencée. */
export function registerReferenceCheck(entity: ReferencedEntity, check: Checker) {
  checkers.set(entity, [...(checkers.get(entity) ?? []), check]);
}
export function clearReferenceChecks() { checkers.clear(); }

/** Refuse la suppression si une donnée liée existe (règle 10 : suppressions à impact financier/logistique). */
export async function assertNotReferenced(entity: ReferencedEntity, companyId: Types.ObjectId, id: Types.ObjectId) {
  for (const check of checkers.get(entity) ?? []) {
    const reason = await check(companyId, id);
    if (reason) throw AppError.conflict(`Suppression impossible : ${reason}. Utilisez l'archivage / la désactivation.`);
  }
}
