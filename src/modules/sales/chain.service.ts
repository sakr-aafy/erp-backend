import type { Types } from 'mongoose';
import { AuditLog } from '../../models/audit-log.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { statusOf, QUOTATION_STATUS_LABEL } from '../quotations/quotation.workflow.js';
import { CYCLE_LABEL, type CycleAction } from './cycle.log.js';

/**
 * Chaîne documentaire d'un cycle commercial : devis → proforma → bons de livraison → factures → avoirs. Uniquement des documents
 * réels liés par leurs identifiants ; chaque utilisateur ne voit que les types qu'il est autorisé à consulter.
 */
type Id = Types.ObjectId;
export type ChainType = 'quotation' | 'proforma' | 'deliveryNote' | 'invoice';
export const CHAIN_PERMISSION: Record<ChainType, string> = { quotation: 'quotations:view', proforma: 'proformas:view', deliveryNote: 'deliveryNotes:view', invoice: 'invoices:view' };
const MODEL = { quotation: Quotation, proforma: Proforma, deliveryNote: DeliveryNote, invoice: Invoice } as const;

async function collect(companyId: Id, type: ChainType, id: string) {
  const root = await (MODEL[type] as typeof Quotation).exists({ _id: id, companyId });
  if (!root) throw AppError.notFound('Document introuvable');
  const ids = { quotation: new Set<string>(), proforma: new Set<string>(), deliveryNote: new Set<string>(), invoice: new Set<string>() };
  ids[type].add(id);
  const add = (set: Set<string>, ...values: unknown[]) => { for (const v of values) if (v) set.add(String(v)); };
  // Propagation jusqu'à stabilité (un cycle compte au plus quelques niveaux de liens)
  for (let round = 0; round < 6; round++) {
    const before = Object.values(ids).reduce((s, x) => s + x.size, 0);
    const list = (s: Set<string>) => [...s];
    const [quotes, proformas, notes, invoices] = await Promise.all([
      Quotation.find({ companyId, _id: { $in: list(ids.quotation) } }).select('proformaId invoiceId').lean(),
      Proforma.find({ companyId, $or: [{ _id: { $in: list(ids.proforma) } }, { quotationId: { $in: list(ids.quotation) } }] }).select('quotationId invoiceId').lean(),
      DeliveryNote.find({ companyId, $or: [{ _id: { $in: list(ids.deliveryNote) } }, { 'source.id': { $in: [...ids.quotation, ...ids.proforma, ...ids.invoice] } }] }).select('source invoiceId invoiceIds').lean(),
      Invoice.find({ companyId, $or: [{ _id: { $in: list(ids.invoice) } }, { proformaId: { $in: list(ids.proforma) } }, { quotationId: { $in: list(ids.quotation) } }, { deliveryNoteIds: { $in: list(ids.deliveryNote) } }, { creditedInvoiceId: { $in: list(ids.invoice) } }] }).select('quotationId proformaId deliveryNoteIds creditedInvoiceId').lean(),
    ]);
    for (const q of quotes) { add(ids.proforma, q.proformaId); add(ids.invoice, q.invoiceId); }
    for (const p of proformas) { add(ids.proforma, p._id); add(ids.quotation, p.quotationId); add(ids.invoice, p.invoiceId); }
    for (const d of notes) { add(ids.deliveryNote, d._id); add(ids.invoice, d.invoiceId, ...(d.invoiceIds ?? [])); if (d.source?.type) add(ids[d.source.type as 'quotation' | 'proforma' | 'invoice'], d.source.id); }
    for (const i of invoices) { add(ids.invoice, i._id, i.creditedInvoiceId); add(ids.quotation, i.quotationId); add(ids.proforma, i.proformaId); add(ids.deliveryNote, ...(i.deliveryNoteIds ?? [])); }
    if (Object.values(ids).reduce((s, x) => s + x.size, 0) === before) break;
  }
  return ids;
}

const DELIVERY_LABEL: Record<string, string> = { draft: 'Brouillon', validated: 'Validé', cancelled: 'Annulé' };
const PROFORMA_LABEL: Record<string, string> = { converted: 'Convertie (ancien parcours)', expired: 'Expirée', cancelled: 'Annulée' };

export async function documents(companyId: Id, type: ChainType, id: string, perms: Set<string>) {
  const ids = await collect(companyId, type, id);
  const can = (t: ChainType) => perms.has(CHAIN_PERMISSION[t]);
  const [quotes, proformas, notes, invoices] = await Promise.all([
    can('quotation') ? Quotation.find({ companyId, _id: { $in: [...ids.quotation] } }).sort({ issueDate: 1, number: 1 }).select('number issueDate status totals.totalTtcMinor acceptedVersion version').lean() : [],
    can('proforma') ? Proforma.find({ companyId, _id: { $in: [...ids.proforma] } }).sort({ issueDate: 1, number: 1 }).select('number issueDate status sentAt totals.totalTtcMinor quotationVersion').lean() : [],
    can('deliveryNote') ? DeliveryNote.find({ companyId, _id: { $in: [...ids.deliveryNote] } }).sort({ deliveryDate: 1, number: 1 }).select('number deliveryDate status totals.totalTtcMinor').lean() : [],
    can('invoice') ? Invoice.find({ companyId, _id: { $in: [...ids.invoice] } }).sort({ type: -1, issueDate: 1, number: 1 }).select('number type issueDate status paymentStatus totals.totalPayableMinor').lean() : [],
  ]);
  const row = (kind: ChainType, label: string, route: string, d: { _id: Id; number?: string | null | undefined }, date: Date, status: string, statusLabel: string, amountMinor: number, detail?: string) =>
    ({ type: kind, label, id: d._id.toString(), number: d.number ?? null, date, status, statusLabel, amountMinor, route: `/${route}/${d._id}`, current: kind === type && String(d._id) === id, detail: detail ?? null });
  return {
    items: [
      ...quotes.map((q) => row('quotation', 'Devis', 'quotations', q, q.issueDate, statusOf(q.status), QUOTATION_STATUS_LABEL[statusOf(q.status)], q.totals?.totalTtcMinor ?? 0, `Version ${q.acceptedVersion ?? q.version ?? 1}${q.acceptedVersion ? ' acceptée' : ''}`)),
      ...proformas.map((p) => row('proforma', 'Proforma', 'proformas', p, p.issueDate, p.status, p.status === 'pending' ? (p.sentAt ? 'Envoyée' : 'En attente') : PROFORMA_LABEL[p.status] ?? p.status, p.totals?.totalTtcMinor ?? 0, p.quotationVersion ? `Devis version ${p.quotationVersion}` : undefined)),
      ...notes.map((d) => row('deliveryNote', 'Bon de livraison', 'delivery-notes', d, d.deliveryDate, d.status, DELIVERY_LABEL[d.status] ?? d.status, d.totals?.totalTtcMinor ?? 0)),
      ...invoices.map((i) => row('invoice', i.type === 'credit_note' ? 'Avoir' : 'Facture', 'invoices', i, i.issueDate, i.status, i.status === 'draft' ? 'Brouillon' : 'Validée', (i.type === 'credit_note' ? -1 : 1) * (i.totals?.totalPayableMinor ?? 0),
        i.status === 'validated' && i.type !== 'credit_note' ? ({ unpaid: 'Impayée', partial: 'Partiellement payée', paid: 'Payée' } as Record<string, string>)[i.paymentStatus ?? ''] : undefined)),
    ],
    /** Types masqués faute de permission (aucun détail communiqué). */
    restricted: (Object.keys(CHAIN_PERMISSION) as ChainType[]).filter((t) => !can(t)),
  };
}

/** Chronologie métier de la chaîne, lue dans le journal d'audit : les événements des documents non autorisés sont exclus. */
export async function activities(companyId: Id, type: ChainType, id: string, perms: Set<string>) {
  const ids = await collect(companyId, type, id);
  const hidden = new Set((Object.keys(CHAIN_PERMISSION) as ChainType[]).filter((t) => !perms.has(CHAIN_PERMISSION[t])).flatMap((t) => [...ids[t]]));
  const all = [...ids.quotation, ...ids.proforma, ...ids.deliveryNote, ...ids.invoice].filter((x) => !hidden.has(x));
  const rows = await AuditLog.find({ companyId, 'meta.refs': { $in: all }, action: /^cycle\./ }).sort({ at: -1, _id: -1 }).limit(300).lean();
  return { items: rows.filter((r) => !hidden.has(r.resourceId ?? '')).map((r) => { const m = (r.meta ?? {}) as { number?: string; description?: string; refs?: string[] }; const action = r.action.slice(6) as CycleAction;
    // La précision d'un événement peut citer un document lié : elle est masquée si ce document n'est pas autorisé
    const restricted = (m.refs ?? []).some((x) => hidden.has(x));
    return { id: r._id.toString(), action, title: CYCLE_LABEL[action] ?? action, at: r.at, user: r.userName ?? null, number: m.number ?? null, description: restricted ? null : m.description ?? null, resource: r.resource, resourceId: r.resourceId ?? null }; }) };
}
