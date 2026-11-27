import type { ClientSession, Types } from 'mongoose';
import { AuditLog } from '../../models/audit-log.model.js';

type Id = Types.ObjectId;
export interface CycleActor { userId?: Id | undefined; name?: string | undefined }

/** Événements métier du cycle commercial, écrits dans le journal d'audit existant DANS la transaction de l'opération. */
export const CYCLE_LABEL = {
  quote_converted: 'Conversion du devis', proforma_created: 'Proforma créée', proforma_sent: 'Proforma transmise', proforma_cancelled: 'Proforma annulée', quote_cancelled: 'Devis passé à « Annulé »',
  delivery_created: 'Bon de livraison créé', delivery_validated: 'Bon de livraison validé', stock_out: 'Sortie de stock', delivery_partial: 'Livraison partielle', delivery_complete: 'Livraison totale',
  delivery_cancelled: 'Bon de livraison annulé', delivery_returned: 'Retour physique', invoice_created: 'Facture créée', invoice_grouped: 'Facturation groupée', invoice_deleted: 'Facture brouillon supprimée',
  invoice_validated: 'Facture validée', receivable_created: 'Créance client créée', credit_created: 'Avoir créé', credit_validated: 'Avoir validé', quantities_reopened: 'Quantités à refacturer',
} as const;
export type CycleAction = keyof typeof CYCLE_LABEL;
const RESOURCE: Partial<Record<CycleAction, string>> = { quote_converted: 'quotation', quote_cancelled: 'quotation', proforma_created: 'proforma', proforma_sent: 'proforma', proforma_cancelled: 'proforma',
  delivery_created: 'delivery-note', delivery_validated: 'delivery-note', stock_out: 'delivery-note', delivery_partial: 'proforma', delivery_complete: 'proforma', delivery_cancelled: 'delivery-note', delivery_returned: 'delivery-note',
  credit_created: 'credit-note', credit_validated: 'credit-note' };

export interface CycleEvent {
  action: CycleAction; resourceId: Id | string; number?: string | null | undefined; description?: string | undefined;
  /** Documents concernés : l'événement apparaît dans la chronologie de chacun. */
  refs: (Id | string | null | undefined)[];
}
export async function logCycle(session: ClientSession, companyId: Id, actor: CycleActor, events: CycleEvent[]) {
  if (!events.length) return;
  const at = new Date();
  await AuditLog.insertMany(events.map((e) => ({
    companyId, userId: actor.userId, userName: actor.name ?? 'Système', action: `cycle.${e.action}`, resource: RESOURCE[e.action] ?? 'invoice', resourceId: String(e.resourceId), success: true, at,
    meta: { number: e.number ?? undefined, description: e.description, refs: [...new Set([e.resourceId, ...e.refs].filter(Boolean).map(String))] },
  })), { session, ordered: true });
}
