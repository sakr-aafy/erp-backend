import type { ClientSession, Model, Types } from 'mongoose';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { defaultWarehouseId, ensureLevels } from '../../services/stock.service.js';
import { Warehouse } from '../../models/logistics.model.js';
import { assertQuantities, carriedOver } from '../products/units.js';
import { allocatedOf, billedBySource, componentsOf, netDelivered, q3, slice, writeLines, type CycleLine } from '../sales/billing.js';
import { logCycle, type CycleActor } from '../sales/cycle.log.js';
import { adjust, loadBasis, reopenedOf, returnedSerials, type Adjustment, type Note } from '../invoices/delivery-billing.js';
import { getOwn, toDto, type Lean } from './delivery.service.js';

/**
 * Retour physique de marchandise livrée. Quantité retournable d'une ligne :
 *  - la quantité livrée non facturée ;
 *  - la quantité facturée puis créditée par un avoir validé « retour de marchandise » ;
 *  - pour un BL livrant une facture, toute la quantité livrée.
 * Un avoir financier seul ne rend rien retournable et ne touche jamais au stock.
 */
type Id = Types.ObjectId;
const EPS = 1e-9;
interface Credit { creditNoteId?: Id | undefined; invoiceId?: Id | undefined; invoiceLineId?: Id | undefined; remaining: number; consumed: number; credit?: CycleLine | undefined; invoiceLine?: CycleLine | undefined; creditNumber?: string | null | undefined }

async function returnableOf(companyId: Id, d: Note, session: ClientSession | null) {
  const credits = await Invoice.find({ companyId, type: 'credit_note', status: 'validated', creditEffect: 'return', $or: [{ 'lines.delivery.noteId': d._id }, { creditedInvoiceId: { $in: [...(d.invoiceIds ?? []), ...(d.invoiceId ? [d.invoiceId] : [])] } }] }).session(session).sort({ validatedAt: 1 }).lean();
  // BL de l'ancien parcours facturé en entier : retournable seulement si la facture est intégralement créditée, sans avoir déclaré
  // « financier » (les avoirs antérieurs n'ont pas d'effet déclaré)
  const legacy = d.invoiceId ? await Invoice.findOne({ _id: d.invoiceId, companyId, status: 'validated' }).session(session).lean() : null;
  const legacyCredited = !!legacy && (legacy.creditedMinor ?? 0) >= (legacy.totals.totalPayableMinor ?? 0)
    && !(await Invoice.exists({ companyId, creditedInvoiceId: legacy._id, type: 'credit_note', status: 'validated', creditEffect: 'financial' }).session(session));
  const out = new Map<string, { unbilled: number; credited: Credit[]; total: number; serials: string[] }>();
  for (const line of d.lines) {
    const key = String(line._id); const done = (d.returns ?? []).flatMap((r) => r.lines.filter((l) => String(l.lineId) === key));
    const serials = (line.serials ?? []).filter((s) => !returnedSerials(d, line._id).includes(s));
    if (billedBySource(d)) { out.set(key, { unbilled: netDelivered(line), credited: [], total: netDelivered(line), serials }); continue; }
    const unbilled = Math.max(0, q3(netDelivered(line) - allocatedOf(d, line)));
    const credited: Credit[] = [];
    for (const c of credits) for (const cl of c.lines as unknown as CycleLine[]) {
      if (String(cl.delivery?.noteId) !== String(d._id) || String(cl.delivery?.lineId) !== key) continue;
      const consumed = q3(done.flatMap((l) => l.credited ?? []).filter((x) => String(x.creditNoteId) === String(c._id) && String(x.invoiceLineId) === String(cl.sourceLineId)).reduce((s, x) => s + (x.quantity ?? 0), 0));
      const remaining = q3(cl.quantity - consumed); if (remaining <= EPS) continue;
      const inv = await Invoice.findOne({ _id: c.creditedInvoiceId, companyId }).session(session).lean();
      credited.push({ creditNoteId: c._id, invoiceId: c.creditedInvoiceId!, invoiceLineId: cl.sourceLineId!, remaining, consumed, credit: cl, invoiceLine: (inv?.lines as unknown as CycleLine[]).find((x) => String(x._id) === String(cl.sourceLineId)), creditNumber: c.number });
    }
    if (legacyCredited && netDelivered(line) - unbilled > EPS) credited.push({ invoiceId: legacy!._id, remaining: q3(netDelivered(line) - unbilled), consumed: 0 });
    const total = Math.min(netDelivered(line), q3(unbilled + credited.reduce((s, c) => s + c.remaining, 0)));
    out.set(key, { unbilled, credited, total, serials });
  }
  return out;
}

/** Quantités retournables d'un BL (écran de retour). */
export async function returnable(companyId: Id, id: string) {
  const d = (await getOwn(companyId, id)) as unknown as Note;
  if (d.status !== 'validated') throw AppError.conflict('Seul un BL validé peut faire l’objet d’un retour');
  const info = await returnableOf(companyId, d, null);
  return { lines: d.lines.map((l) => { const i = info.get(String(l._id))!; return { lineId: String(l._id), reference: l.reference ?? null, designation: l.designation, unit: l.unit ?? null, delivered: l.quantity, returned: l.returnedQty ?? 0,
    billed: billedBySource(d) ? 0 : allocatedOf(d, l), unbilled: i.unbilled, credited: q3(i.credited.reduce((s, c) => s + c.remaining, 0)), returnable: i.total, serials: i.serials }; }) };
}

export interface ReturnBody { warehouseId?: string | undefined; reason: string; requestId?: string | undefined; date?: Date | undefined; lines: { lineId: string; quantity: number; serials?: string[] | undefined }[] }
export async function create(companyId: Id, userId: Id, id: string, b: ReturnBody, actor: CycleActor = { userId }) {
  const pre = await getOwn(companyId, id);
  const wh = b.warehouseId ?? pre.warehouseId?.toString() ?? (await defaultWarehouseId(companyId)).toString();
  await ensureLevels(companyId, pre.lines.filter((l) => l.productId).map((l) => ({ productId: l.productId!, warehouseId: wh })));
  return withTransaction(async (session) => {
    const d = (await getOwn(companyId, id, session)) as unknown as Note;
    // Requête rejouée : le retour déjà enregistré n'est pas recréé
    if (b.requestId && d.returns?.some((r) => r.requestId === b.requestId)) return toDto(d as unknown as Lean);
    if (d.status !== 'validated') throw AppError.conflict('Seul un BL validé peut faire l’objet d’un retour');
    if (!(await Warehouse.exists({ _id: wh, companyId, isActive: true }).session(session))) throw new AppError(409, 'Magasin introuvable ou inactif', 'WAREHOUSE_UNAVAILABLE');
    if (new Set(b.lines.map((l) => l.lineId)).size !== b.lines.length) throw AppError.badRequest('Une ligne est saisie deux fois');
    const info = await returnableOf(companyId, d, session);
    const basis = await loadBasis(companyId, d, session);
    const entries: Adjustment[] = []; const lineChanges = new Map<string, Record<string, unknown>>(); const record: Record<string, unknown>[] = []; const reopened = new Map<string, number>();
    for (const x of b.lines) {
      const line = d.lines.find((l) => String(l._id) === x.lineId); const i = info.get(x.lineId);
      if (!line || !i) throw AppError.badRequest('Ligne de livraison inconnue');
      if (x.quantity > i.total + EPS) throw new AppError(409, `« ${line.designation} » : ${i.total} au plus peut être retourné. Une quantité facturée exige d’abord un avoir « retour de marchandise » validé.`, 'RETURN_EXCEEDED', { lineId: x.lineId, returnable: i.total });
      await assertQuantities(companyId, [{ productId: line.productId ?? undefined, quantity: x.quantity, exempt: carriedOver(x.quantity, line.quantity, i.total), label: `« ${line.designation} »` }], session);
      if (line.serials?.length) {
        if (x.serials?.length !== x.quantity || new Set(x.serials).size !== x.serials.length) throw new AppError(400, `« ${line.designation} » : indiquez les ${x.quantity} numéro(s) de série retourné(s)`, 'SERIAL_COUNT');
        for (const s of x.serials) if (!i.serials.includes(s)) throw new AppError(409, `Numéro de série non livré par ce BL ou déjà retourné : ${s}`, 'SERIAL_UNAVAILABLE');
      } else if (x.serials?.length) throw new AppError(400, `« ${line.designation} » : aucun numéro de série livré sur cette ligne`, 'SERIAL_NOT_TRACKED');
      // Quantités créditées d'abord, puis quantités non facturées
      let left = x.quantity; const consumed: Record<string, unknown>[] = [];
      for (const c of i.credited) {
        if (left <= EPS) break;
        const take = q3(Math.min(c.remaining, left)); left = q3(left - take);
        const basisLine = basis ? basis.doc.lines.find((s) => String(s._id) === String(line.sourceLineId)) : line;
        let amounts;
        if (c.credit && c.invoiceLine) {
          const k = String(c.invoiceLineId); const before = (await reopenedOf(companyId, c.invoiceId!, session)).get(k)?.qty ?? 0; const seen = reopened.get(k) ?? 0; reopened.set(k, q3(seen + take));
          const parts = componentsOf(c.invoiceLine);
          amounts = { after: slice(c.credit.netHtMinor ?? 0, c.consumed, take, c.credit.quantity), share: slice(parts.share, q3(before + seen), take, c.invoiceLine.quantity), discount: slice(parts.discount, q3(before + seen), take, c.invoiceLine.quantity) };
        } else { const parts = componentsOf(basisLine ?? line); const of = (basisLine ?? line).quantity; amounts = { after: slice(parts.after, 0, take, of), share: slice(parts.share, 0, take, of), discount: slice(parts.discount, 0, take, of) }; }
        if (basisLine) entries.push({ noteId: d._id, lineId: line._id, basisType: basis?.type ?? 'deliveryNote', basisId: basis?.doc._id ?? d._id, basisLineId: basisLine._id, quantity: take, amounts, serials: x.serials?.slice(0, take) });
        consumed.push({ creditNoteId: c.creditNoteId, invoiceId: c.invoiceId, invoiceLineId: c.invoiceLineId, quantity: take, afterMinor: amounts.after, shareMinor: amounts.share, discountMinor: amounts.discount });
      }
      record.push({ lineId: line._id, quantity: x.quantity, ...(x.serials?.length && { serials: x.serials }), credited: consumed });
      lineChanges.set(x.lineId, { returnedQty: q3((line.returnedQty ?? 0) + x.quantity) });
    }
    if (entries.length) await adjust(companyId, entries, 'reopen', session, { noteDocs: new Map([[String(d._id), d]]) });
    const date = startOfDay(b.date ?? new Date());
    await writeLines(DeliveryNote as unknown as Model<unknown>, companyId, d, lineChanges, session, { $push: { returns: { requestId: b.requestId, date, warehouseId: wh, reason: b.reason, userId, userName: actor.name, lines: record } } });
    // Document source : les quantités retournées redeviennent à livrer
    if (d.source?.type && d.source.id) {
      const M = ({ proforma: Proforma, quotation: Quotation, invoice: Invoice } as const)[d.source.type as 'proforma'] as unknown as Model<unknown>;
      const src = (await M.findOne({ _id: d.source.id, companyId }).session(session).lean()) as { _id: Id; cycleRevision?: number; lines: CycleLine[] } | null;
      if (!src) throw AppError.conflict('Document source introuvable');
      const changes = new Map<string, Record<string, unknown>>();
      for (const x of b.lines) { const line = d.lines.find((l) => String(l._id) === x.lineId)!; const sl = src.lines.find((s) => String(s._id) === String(line.sourceLineId)); if (!sl) continue;
        const k = String(sl._id); const cur = changes.get(k) as { deliveredQty: number; returnedQty: number } | undefined;
        changes.set(k, { deliveredQty: Math.max(0, q3((cur?.deliveredQty ?? sl.deliveredQty ?? 0) - x.quantity)), returnedQty: q3((cur?.returnedQty ?? sl.returnedQty ?? 0) + x.quantity) }); }
      await writeLines(M, companyId, src, changes, session);
    }
    const saved = (await getOwn(companyId, id, session)) as Lean;
    const ret = saved.returns!.at(-1)!; const returnId = (ret as unknown as { _id: Id })._id;
    await emitDomainEvent('deliveryNote.returned', { companyId, documentId: returnId, session, userId, documentNumber: d.number, payload: { deliveryNoteId: d._id } });
    await logCycle(session, companyId, actor, [{ action: 'delivery_returned', resourceId: d._id, number: d.number, refs: [d.source?.id, ...(d.invoiceIds ?? []), d.invoiceId],
      description: `${b.reason} — ${b.lines.map((x) => `${d.lines.find((l) => String(l._id) === x.lineId)!.designation} : ${x.quantity}`).join(' · ')}` }]);
    return toDto(saved);
  });
}
