import { AppError } from '../../utils/errors.js';

/** Statuts métier d'un devis (document « Gestion de Devis ») et transitions autorisées : source unique. */
export const QUOTATION_STATUSES = ['pending', 'sent', 'accepted', 'refused', 'expired'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = { pending: 'En attente', sent: 'Envoyé', accepted: 'Accepté', refused: 'Refusé', expired: 'Expiré' };

export const TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  pending: ['sent', 'accepted', 'refused', 'expired'],
  sent: ['accepted', 'refused', 'expired'],
  accepted: [], refused: [], expired: [],
};
/** Statuts depuis lesquels on peut passer à `to`. */
export const sourcesOf = (to: QuotationStatus) => QUOTATION_STATUSES.filter((s) => TRANSITIONS[s].includes(to));
/** Un devis ouvert attend encore la décision du client (peut expirer). */
export const OPEN_STATUSES: readonly QuotationStatus[] = sourcesOf('expired');
export function assertTransition(from: QuotationStatus, to: QuotationStatus) {
  if (!TRANSITIONS[from].includes(to)) throw AppError.conflict(`Transition impossible : un devis « ${QUOTATION_STATUS_LABEL[from]} » ne peut pas passer à « ${QUOTATION_STATUS_LABEL[to]} »`);
}
