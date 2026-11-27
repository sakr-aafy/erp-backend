import type { ClientSession, Types } from 'mongoose';
import { DeliveryNote, Invoice, Payment, Proforma, Quotation } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { allocatedOf, availableToBill, netDelivered, q3, type BillableNote, type CycleLine } from '../sales/billing.js';
import { progressOf, BILLING_STATE_LABEL, DELIVERY_STATE_LABEL } from '../sales/tracking.js';
import { logCycle, type CycleActor, type CycleEvent } from '../sales/cycle.log.js';
import * as quotations from '../quotations/quotation.service.js';
import { expireOverdue } from './proforma.expiry.js';
import { get, getOwn, type Lean } from './proforma.service.js';

type Id = Types.ObjectId;
const EPS = 1e-9;

/** Suivi par ligne source (jamais par référence d'article : un article peut figurer plusieurs fois avec des prix différents). */
export async function tracking(companyId: Id, id: string) {
  const p = await getOwn(companyId, id);
  const bls = await DeliveryNote.find({ companyId, 'source.id': p._id }).lean();
  const linked = bls.flatMap((d) => [...(d.invoiceIds ?? []), ...(d.invoiceId ? [d.invoiceId] : [])]);
  const invoices = await Invoice.find({ companyId, $or: [{ proformaId: p._id }, { _id: { $in: linked } }] }).select('type status origin').lean();
  const status = new Map(invoices.map((i) => [i._id.toString(), i.status]));
  // Ancien parcours : la proforma a été convertie directement en facture, qui la couvre en entier
  const legacy = p.status === 'converted' && p.invoiceId ? status.get(p.invoiceId.toString()) : undefined;
  const validated = bls.filter((d) => d.status === 'validated') as unknown as (BillableNote & { invoiceId?: Id })[];
  const lines = (p.lines as unknown as CycleLine[]).map((l) => {
    const of = <T extends { lines: CycleLine[] }>(list: T[]) => list.flatMap((d) => d.lines.filter((x) => String(x.sourceLineId) === String(l._id)).map((x) => ({ d, x })));
    const invoiced = q3(of(validated).reduce((s, { d, x }) => s + (x.invoicedQty ?? (d.invoiceId && status.get(String(d.invoiceId)) === 'validated' ? x.quantity : 0)), 0) + (legacy === 'validated' ? l.quantity : 0));
    const allocated = q3(of(validated).reduce((s, { d, x }) => s + allocatedOf(d, x), 0) + (legacy ? l.quantity : 0));
    const delivered = l.deliveredQty ?? 0;
    return { lineId: String(l._id), reference: l.reference ?? null, designation: l.designation, unit: l.unit ?? null, kind: l.kind ?? 'product', ordered: l.quantity, delivered, returned: l.returnedQty ?? 0,
      remainingToDeliver: legacy ? 0 : Math.max(0, q3(l.quantity - delivered)),
      inDraftDeliveries: q3(of(bls.filter((d) => d.status === 'draft') as unknown as BillableNote[]).reduce((s, { x }) => s + x.quantity, 0)),
      invoiced, inDraftInvoices: Math.max(0, q3(allocated - invoiced)), deliveredNotInvoiced: legacy ? 0 : Math.max(0, q3(delivered - invoiced)), remainingToBill: Math.max(0, q3(l.quantity - invoiced)) };
  });
  const by = new Map(lines.map((l) => [l.lineId, l]));
  const delivery = progressOf(p.lines as unknown as CycleLine[], (l) => by.get(String(l._id))!.delivered);
  const billing = progressOf(p.lines as unknown as CycleLine[], (l) => by.get(String(l._id))!.invoiced);
  return { legacyFlow: !!legacy, lines,
    delivery: { ...delivery, label: DELIVERY_STATE_LABEL[delivery.state], count: bls.filter((d) => d.status !== 'cancelled').length, validatedCount: validated.length },
    billing: { ...billing, label: BILLING_STATE_LABEL[billing.state], count: invoices.filter((i) => i.type === 'invoice').length, validatedCount: invoices.filter((i) => i.type === 'invoice' && i.status === 'validated').length },
    billableDeliveries: validated.filter((d) => d.lines.some((l) => availableToBill(d, l) > EPS)).length,
    /** Aucune réservation de stock dans l'ERP : les quantités en préparation sont celles des BL brouillons. */
    reservation: null,
    method: 'Pourcentage pondéré par le montant net HT convenu de chaque ligne : les quantités d’unités différentes ne sont pas additionnées.' };
}

export interface Blocker { type: 'proforma' | 'deliveryNote' | 'invoice'; id: string; number: string | null; message: string }
/** Conditions d'annulation : ce qui bloque, ce qui sera traité automatiquement et le sort du devis. */
async function assess(companyId: Id, p: Lean, session: ClientSession | null) {
  const blockers: Blocker[] = []; const warnings: string[] = [];
  const block = (type: Blocker['type'], d: { _id: Id; number?: string | null | undefined }, message: string) => blockers.push({ type, id: d._id.toString(), number: d.number ?? null, message });
  if (p.status === 'cancelled') block('proforma', p, 'La proforma est déjà annulée');
  const invoices = await Invoice.find({ companyId, proformaId: p._id, type: 'invoice' }).session(session).lean();
  const bls = await DeliveryNote.find({ companyId, 'source.id': { $in: [p._id, ...invoices.map((i) => i._id)] } }).session(session).lean();
  for (const d of bls.filter((x) => x.status === 'validated')) {
    if ((d.lines as unknown as CycleLine[]).some((l) => netDelivered(l) > EPS)) block('deliveryNote', d, 'Marchandise livrée non retournée. Annulez ce bon s’il n’est pas facturé ; sinon émettez un avoir « retour de marchandise » puis enregistrez le retour physique.');
  }
  for (const i of invoices) {
    if (i.status === 'draft') block('invoice', i, 'Facture brouillon liée : supprimez-la avant d’annuler la proforma');
    else if ((i.creditedMinor ?? 0) < (i.totals.totalPayableMinor ?? 0)) block('invoice', i, 'Émettez un avoir validé couvrant la totalité du montant de cette facture.');
  }
  if (invoices.length && await Payment.exists({ companyId, invoiceId: { $in: invoices.map((i) => i._id) }, status: 'active' }).session(session)) warnings.push('Des encaissements restent enregistrés sur les factures créditées : le client conserve un avoir à rembourser ou à imputer.');
  const draftDeliveries = bls.filter((x) => x.status === 'draft');

  // Devis associé : annulé seulement si plus rien d'actif ne s'y rattache
  let quotation: { id: string; number: string; willCancel: boolean; reason: string | null } | null = null;
  if (p.quotationId) {
    const q = await Quotation.findOne({ _id: p.quotationId, companyId }).session(session).select('number status invoiceId').lean();
    if (q) {
      let reason: string | null = q.status === 'accepted' ? null : 'Le devis n’est pas « Accepté »';
      const other = await Proforma.findOne({ companyId, quotationId: q._id, _id: { $ne: p._id }, status: { $in: ['pending', 'converted'] } }).session(session).select('number').lean();
      if (!reason && other) reason = `La proforma ${other.number} reste active pour ce devis`;
      if (!reason && await Invoice.exists({ companyId, quotationId: q._id, proformaId: null, type: 'invoice', $expr: { $or: [{ $eq: ['$status', 'draft'] }, { $lt: [{ $ifNull: ['$creditedMinor', 0] }, '$totals.totalPayableMinor'] }] } }).session(session)) reason = 'Une facture issue directement du devis reste active';
      if (!reason) { const direct = await DeliveryNote.find({ companyId, 'source.id': q._id, status: 'validated' }).session(session).lean(); if (direct.some((d) => (d.lines as unknown as CycleLine[]).some((l) => netDelivered(l) > EPS))) reason = 'Un bon de livraison issu directement du devis reste actif'; }
      quotation = { id: q._id.toString(), number: q.number, willCancel: !reason, reason };
    }
  }
  return { allowed: !blockers.length, blockers, warnings, draftDeliveries: draftDeliveries.map((d) => ({ id: d._id.toString(), number: d.number })), quotation };
}
export async function cancellation(companyId: Id, id: string) { await expireOverdue(companyId); return assess(companyId, await getOwn(companyId, id), null); }

/** Annulation d'une commande : la proforma est conservée, les BL en préparation sont annulés et le devis passe à « Annulé ». */
export async function cancel(companyId: Id, id: string, reason: string, actor: CycleActor = {}) {
  await expireOverdue(companyId); await getOwn(companyId, id);
  const effects = await withTransaction(async (session) => {
    const p = (await Proforma.findOne({ _id: id, companyId }).session(session).lean()) as Lean;
    const a = await assess(companyId, p, session);
    if (!a.allowed) throw new AppError(409, `Annulation impossible. ${a.blockers.map((b) => `${b.number ?? 'Brouillon'} — ${b.message}`).join(' ')}`, 'PROFORMA_CANCEL_BLOCKED', { blockers: a.blockers });
    const at = new Date();
    // La révision protège contre une livraison ou une facturation simultanée
    const u = await Proforma.updateOne({ _id: p._id, companyId, status: p.status, cycleRevision: p.cycleRevision ?? null }, { $set: { status: 'cancelled', cancelledAt: at, cancelledBy: actor.userId, cancelledByName: actor.name, cancelReason: reason }, $inc: { cycleRevision: 1 } }, { session });
    if (!u.modifiedCount) throw new AppError(409, 'La proforma a changé entre-temps : réessayez', 'CONCURRENT_UPDATE');
    for (const d of a.draftDeliveries) await DeliveryNote.updateOne({ _id: d.id, companyId, status: 'draft' }, { status: 'cancelled', cancelledAt: at, cancelledBy: actor.userId, cancelledByName: actor.name, cancelReason: `Proforma ${p.number} annulée : ${reason}` }, { session });
    const refs = [p.quotationId];
    const events: CycleEvent[] = [{ action: 'proforma_cancelled', resourceId: p._id, number: p.number, refs, description: reason },
      ...a.draftDeliveries.map((d) => ({ action: 'delivery_cancelled' as const, resourceId: d.id, number: d.number, refs: [p._id, p.quotationId], description: 'BL en préparation annulé avec la proforma' }))];
    if (a.quotation?.willCancel) {
      await quotations.cancelWithin(session, companyId, a.quotation.id, actor, `Annulation de la proforma ${p.number} : ${reason}`);
      events.push({ action: 'quote_cancelled', resourceId: a.quotation.id, number: a.quotation.number, refs: [p._id], description: `Automatique, après l’annulation de la proforma ${p.number}` });
    }
    await logCycle(session, companyId, actor, events);
    return a;
  });
  return { ...(await get(companyId, id)), effects };
}
