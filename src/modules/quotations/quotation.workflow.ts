import { AppError } from '../../utils/errors.js';

/** Statuts métier d'un devis, transitions et actions autorisées : source unique pour l'API et l'écran. */
export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'refused', 'expired', 'cancelled'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = { draft: 'Brouillon', sent: 'Envoyé', accepted: 'Accepté', refused: 'Refusé', expired: 'Expiré', cancelled: 'Annulé' };
/** Valeur enregistrée avant la migration. */
export const statusOf = (stored: string | null | undefined): QuotationStatus => (stored === 'pending' || !stored ? 'draft' : (stored as QuotationStatus));
export const storedStatuses = (s: QuotationStatus): string[] => (s === 'draft' ? ['draft', 'pending'] : [s]);

/**
 * « expiré → brouillon » et « envoyé → brouillon » passent UNIQUEMENT par la création d'une nouvelle version.
 * « accepté → annulé » est réservé à l'annulation de la proforma liée (mission 2) : aucune action ne l'expose aujourd'hui.
 */
export const TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'refused', 'expired', 'draft'],
  accepted: ['cancelled'],
  refused: [], expired: ['draft'], cancelled: [],
};
export function assertTransition(from: QuotationStatus, to: QuotationStatus) {
  if (!TRANSITIONS[from].includes(to)) throw AppError.conflict(`Transition impossible : un devis « ${QUOTATION_STATUS_LABEL[from]} » ne peut pas passer à « ${QUOTATION_STATUS_LABEL[to]} »`);
}

export interface QuoteState { status: QuotationStatus; version: number; hasSentHistory: boolean; converted: boolean; hasDependants: boolean }
/** Matrice des actions (consultation, impression et PDF toujours possibles). */
export function actionsOf(q: QuoteState) {
  const draft = q.status === 'draft';
  return {
    edit: draft && !q.converted,
    remove: draft && !q.converted && !q.hasSentHistory && !q.hasDependants,
    duplicate: true,
    newVersion: (q.status === 'sent' || q.status === 'expired') && !q.converted,
    abandonVersion: draft && q.version > 1 && q.hasSentHistory,
    send: draft || q.status === 'sent',
    accept: q.status === 'sent',
    refuse: q.status === 'sent',
    convertProforma: q.status === 'accepted' && !q.converted,
  };
}
export type QuoteActions = ReturnType<typeof actionsOf>;
