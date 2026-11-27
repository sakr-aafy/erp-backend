import type { ClientSession, Types } from 'mongoose';
import { QuotationActivity, QUOTATION_EVENTS, type QuotationActivityDoc } from '../../models/sales.model.js';

type Id = Types.ObjectId;
export type EventKind = (typeof QUOTATION_EVENTS)[number];
export interface Actor { userId?: Id | undefined; name?: string | undefined }
export const SYSTEM: Actor & { system: true } = { system: true };

export const EVENT_LABEL: Record<EventKind, string> = {
  created: 'Création du devis', line_added: 'Ajout d’un article', line_removed: 'Suppression d’un article', price_changed: 'Modification du prix unitaire', discount_changed: 'Modification d’une remise',
  quantity_changed: 'Modification de la quantité', designation_changed: 'Modification de la désignation', vat_changed: 'Modification de la TVA', lines_reordered: 'Réorganisation des lignes',
  customer_changed: 'Changement de client', payment_terms_changed: 'Changement des conditions de paiement', validity_changed: 'Modification de la date de validité', date_changed: 'Modification de la date du devis',
  delivery_address_changed: 'Modification de l’adresse de livraison', global_discount_changed: 'Modification de la remise globale', notes_changed: 'Modification des notes et conditions',
  marked_sent: 'Devis marqué comme envoyé', email_sent: 'Devis envoyé par e-mail', accepted: 'Devis accepté', refused: 'Devis refusé', expired: 'Devis expiré', duplicated: 'Duplication du devis',
  converted_proforma: 'Conversion en facture proforma', converted_invoice: 'Conversion en facture', invoice_unlinked: 'Facture brouillon supprimée',
};

export interface Event {
  kind: EventKind; description?: string | undefined; line?: { lineId?: Id | undefined; reference?: string | null | undefined; designation: string; position?: number | null | undefined } | undefined;
  valueType?: 'money' | 'percent' | 'number' | 'text' | 'date' | undefined; oldValue?: unknown; newValue?: unknown; related?: { type: string; id: Id; number?: string | null | undefined } | undefined; eventKey?: string | undefined;
}
/** Enregistre les événements APRÈS réussite de l'opération, dans la même transaction lorsqu'il y en a une. */
export async function record(companyId: Id, quotationId: Id, events: Event[], actor: Actor | typeof SYSTEM, session?: ClientSession) {
  if (!events.length) return;
  const at = new Date();
  await QuotationActivity.insertMany(events.map((e) => ({
    companyId, quotationId, occurredAt: at, title: EVENT_LABEL[e.kind], ...e,
    ...('system' in actor ? { system: true, userName: 'Système' } : { userId: actor.userId, userName: actor.name }),
  })), { ...(session && { session }), ordered: true });
}

// ---------- Différences entre deux versions d'un devis ----------
interface Line { _id?: Id; productId?: Id | null | undefined; reference?: string | null | undefined; designation: string; quantity: number; unitPriceMinor: number; discountPct?: number | null | undefined; vat: { code?: string | null | undefined; ratePct?: number | null | undefined; regime?: string | null | undefined }; position?: number | null | undefined }
export interface Version {
  customerSnapshot?: { name?: string | null | undefined } | null | undefined; customerId: Id; lines: Line[]; paymentTerms?: string | null | undefined; validUntil: Date; issueDate: Date;
  deliveryAddress?: { label?: string | null | undefined; street?: string | null | undefined; city?: string | null | undefined; addressId?: Id | null | undefined } | null | undefined;
  globalDiscountPct?: number | null | undefined; globalDiscountMinor?: number | null | undefined; notes?: string | null | undefined; terms?: string | null | undefined;
}
const vatText = (v: Line['vat']) => (v.regime === 'taxable' || !v.regime ? `${v.code} (${v.ratePct} %)` : `${v.code} (${({ zero: 'taux zéro', exempt: 'exonéré', suspended: 'suspension' } as Record<string, string>)[v.regime] ?? v.regime})`);
const addressText = (a: Version['deliveryAddress']) => (a ? [a.label, a.street, a.city].filter(Boolean).join(', ') : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Événements d'une modification : uniquement ce qui a réellement changé (aucun événement si rien ne change). */
export function diff(before: Version, after: Version): Event[] {
  const out: Event[] = [];
  const lineRef = (l: Line) => ({ lineId: l._id, reference: l.reference ?? null, designation: l.designation, position: l.position ?? null });
  const change = (kind: EventKind, oldValue: unknown, newValue: unknown, valueType: Event['valueType'], line?: Line) => { if ((oldValue ?? null) !== (newValue ?? null)) out.push({ kind, oldValue: oldValue ?? null, newValue: newValue ?? null, valueType, ...(line && { line: lineRef(line) }) }); };
  if (String(before.customerId) !== String(after.customerId)) out.push({ kind: 'customer_changed', valueType: 'text', oldValue: before.customerSnapshot?.name ?? null, newValue: after.customerSnapshot?.name ?? null });

  const old = new Map(before.lines.map((l) => [String(l._id), l]));
  for (const l of after.lines) {
    const prev = old.get(String(l._id));
    if (!prev) { out.push({ kind: 'line_added', line: lineRef(l), description: `Quantité ${l.quantity}` }); continue; }
    change('price_changed', prev.unitPriceMinor, l.unitPriceMinor, 'money', l);
    change('discount_changed', prev.discountPct ?? 0, l.discountPct ?? 0, 'percent', l);
    change('quantity_changed', prev.quantity, l.quantity, 'number', l);
    change('designation_changed', prev.designation, l.designation, 'text', l);
    change('vat_changed', vatText(prev.vat), vatText(l.vat), 'text', l);
  }
  const kept = new Set(after.lines.map((l) => String(l._id)));
  for (const l of before.lines) if (!kept.has(String(l._id))) out.push({ kind: 'line_removed', line: lineRef(l), description: `Quantité ${l.quantity}` });
  // Réorganisation : l'ordre relatif des lignes conservées a changé
  const order = (ls: Line[], ids: Set<string>) => ls.filter((l) => ids.has(String(l._id))).map((l) => String(l._id));
  const common = new Set([...old.keys()].filter((k) => kept.has(k)));
  const a = order(before.lines, common); const b = order(after.lines, common);
  if (a.join() !== b.join()) { const name = (id: string) => after.lines.find((l) => String(l._id) === id)!; out.push({ kind: 'lines_reordered', valueType: 'text', oldValue: a.map((id) => name(id).reference ?? name(id).designation).join(' · '), newValue: b.map((id) => name(id).reference ?? name(id).designation).join(' · ') }); }

  change('payment_terms_changed', before.paymentTerms || null, after.paymentTerms || null, 'text');
  change('validity_changed', day(before.validUntil), day(after.validUntil), 'date');
  change('date_changed', day(before.issueDate), day(after.issueDate), 'date');
  change('delivery_address_changed', addressText(before.deliveryAddress), addressText(after.deliveryAddress), 'text');
  if ((before.globalDiscountPct ?? 0) !== (after.globalDiscountPct ?? 0)) change('global_discount_changed', before.globalDiscountPct ?? 0, after.globalDiscountPct ?? 0, 'percent');
  if ((before.globalDiscountMinor ?? 0) !== (after.globalDiscountMinor ?? 0)) change('global_discount_changed', before.globalDiscountMinor ?? 0, after.globalDiscountMinor ?? 0, 'money');
  change('notes_changed', [before.notes, before.terms].filter(Boolean).join('\n') || null, [after.notes, after.terms].filter(Boolean).join('\n') || null, 'text');
  return out;
}

const dto = (a: QuotationActivityDoc & { _id: Id }) => ({
  id: a._id.toString(), quotationId: a.quotationId.toString(), kind: a.kind, title: a.title, description: a.description ?? null, occurredAt: a.occurredAt, user: a.userName ?? null, system: !!a.system,
  line: a.line ? { lineId: a.line.lineId?.toString() ?? null, reference: a.line.reference ?? null, designation: a.line.designation ?? null, position: a.line.position ?? null } : null,
  valueType: a.valueType ?? null, oldValue: a.oldValue ?? null, newValue: a.newValue ?? null,
  related: a.related?.id ? { type: a.related.type, id: a.related.id.toString(), number: a.related.number ?? null } : null,
});
/** Chronologie du plus récent au plus ancien, filtrable par type d'événement. */
export async function list(companyId: Id, quotationId: Id, q: { page: number; limit: number; kind?: EventKind | undefined }) {
  const filter = { companyId, quotationId, ...(q.kind && { kind: q.kind }) };
  const [items, total, kinds] = await Promise.all([
    QuotationActivity.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    QuotationActivity.countDocuments(filter),
    QuotationActivity.distinct('kind', { companyId, quotationId }),
  ]);
  return { items: items.map((a) => dto(a as never)), total, page: q.page, limit: q.limit, kinds: (kinds as EventKind[]).map((k) => ({ value: k, label: EVENT_LABEL[k] })) };
}
