import type { ClientSession, Model, Types } from 'mongoose';
import { AppError } from '../../utils/errors.js';
import { allocateProportional, groupKey, proportion } from '../../services/calculation.service.js';

/**
 * Règles de quantités et de montants du cycle Proforma → BL → Facture (fonctions de calcul, sans effet de bord hormis `writeLines`).
 *
 * LIGNE « BASE DE PRIX » : la ligne du document source d'un BL (proforma, ou devis pour un BL antérieur) ; à défaut (BL saisi
 * sans source), la ligne du BL elle-même. Les montants convenus de cette ligne sont répartis entre les factures partielles :
 *   part d'une facture = prorata(montant convenu, quantité cumulée après la facture) − montant déjà affecté ;
 * la facture qui atteint la quantité totale prend exactement le reliquat. La somme des factures égale donc le montant convenu au
 * millime, remise supplémentaire comprise, sans jamais l'appliquer deux fois.
 */
type Id = Types.ObjectId;
export const q3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-9;

export interface CycleLine {
  _id: Id; productId?: Id | null; reference?: string | null; designation: string; description?: string | null; unit?: string | null; kind?: string | null; quantity: number; unitPriceMinor: number; discountPct?: number | null;
  vat: { ruleId?: Id | null; code?: string | null; regime?: string | null; ratePct?: number | null };
  grossMinor?: number | null; discountMinor?: number | null; netHtMinor?: number | null; globalShareMinor?: number | null; sourceLineId?: Id | null; serials?: string[] | null;
  deliveredQty?: number | null; allocatedQty?: number | null; invoicedQty?: number | null; returnedQty?: number | null;
  billedAfterMinor?: number | null; billedShareMinor?: number | null; billedDiscountMinor?: number | null; billedSerials?: string[] | null;
  delivery?: { noteId?: Id | null; noteNumber?: string | null; lineId?: Id | null; basisType?: 'proforma' | 'quotation' | 'deliveryNote' | null; basisId?: Id | null; basisLineId?: Id | null } | null;
}
export interface BillableNote {
  _id: Id; number?: string | null; status: string; invoiceId?: Id | null; source?: { type?: string | null; id?: Id | null; number?: string | null } | null; lines: CycleLine[];
  returns?: { _id: Id; requestId?: string | null; lines: { lineId?: Id | null; quantity?: number | null; serials?: string[] | null; credited?: { creditNoteId?: Id | null; invoiceId?: Id | null; invoiceLineId?: Id | null; quantity?: number | null; afterMinor?: number | null; shareMinor?: number | null; discountMinor?: number | null }[] | null }[] }[] | null;
}

/** BL créé depuis une facture : les marchandises sont déjà facturées par cette facture, il n'est jamais refacturable. */
export const billedBySource = (d: Pick<BillableNote, 'source'>) => d.source?.type === 'invoice';
/** Quantité affectée à des factures. Sans compteur (document antérieur), un BL lié à une facture l'est en entier. */
export const allocatedOf = (d: Pick<BillableNote, 'source' | 'invoiceId'>, l: Pick<CycleLine, 'quantity' | 'allocatedQty'>) => l.allocatedQty ?? (d.invoiceId || billedBySource(d) ? l.quantity : 0);
/** Quantité livrée nette (retours physiques déduits). */
export const netDelivered = (l: Pick<CycleLine, 'quantity' | 'returnedQty'>) => q3(l.quantity - (l.returnedQty ?? 0));
/** Quantité livrée restant à facturer. */
export const availableToBill = (d: BillableNote, l: CycleLine) => (d.status !== 'validated' || billedBySource(d) ? 0 : Math.max(0, q3(netDelivered(l) - allocatedOf(d, l))));
export const billingState = (d: BillableNote): 'none' | 'partial' | 'full' | 'source' => {
  if (billedBySource(d)) return 'source';
  const used = d.lines.some((l) => allocatedOf(d, l) > EPS);
  if (!used) return 'none';
  return d.lines.some((l) => netDelivered(l) - allocatedOf(d, l) > EPS) ? 'partial' : 'full';
};

export interface Amounts { after: number; share: number; discount: number }
export interface Billed extends Amounts { qty: number }
/** Composantes du montant d'une ligne : net après toutes remises, part de remise globale, remise de ligne. */
export const componentsOf = (l: Pick<CycleLine, 'grossMinor' | 'netHtMinor' | 'globalShareMinor'>): Amounts => {
  const net = l.netHtMinor ?? 0; const share = l.globalShareMinor ?? 0;
  return { after: net - share, share, discount: (l.grossMinor ?? net) - net };
};
const prorata = (l: CycleLine, done: Billed, qty: number): Amounts => {
  const total = componentsOf(l); const cum = q3(done.qty + qty); const full = cum >= l.quantity - EPS;
  const part = (t: number, d: number) => Math.max(0, (full ? t : Math.min(t, proportion(t, cum, l.quantity))) - d);
  return { after: part(total.after, done.after), share: part(total.share, done.share), discount: part(total.discount, done.discount) };
};
/** Montants déjà affectés sur la ligne base de prix ; `legacyQty` : quantité facturée par l'ancien parcours (sans compteur). */
export function billedOf(l: CycleLine, legacyQty = 0): Billed {
  if (l.billedAfterMinor !== undefined && l.billedAfterMinor !== null) return { qty: l.allocatedQty ?? 0, after: l.billedAfterMinor, share: l.billedShareMinor ?? 0, discount: l.billedDiscountMinor ?? 0 };
  const qty = Math.min(l.quantity, l.allocatedQty ?? legacyQty);
  return qty > 0 ? { qty, ...prorata(l, { qty: 0, after: 0, share: 0, discount: 0 }, qty) } : { qty: 0, after: 0, share: 0, discount: 0 };
}
/** Montants d'une nouvelle quantité facturée sur la ligne. */
export function allocate(l: CycleLine, done: Billed, qty: number): { amounts: Amounts; next: Billed } {
  if (done.qty + qty > l.quantity + EPS) throw new AppError(409, `« ${l.designation} » : quantité à facturer (${qty}) supérieure au reste convenu (${Math.max(0, q3(l.quantity - done.qty))})`, 'BILLING_EXCEEDED');
  const amounts = prorata(l, done, qty);
  return { amounts, next: { qty: q3(done.qty + qty), after: done.after + amounts.after, share: done.share + amounts.share, discount: done.discount + amounts.discount } };
}
/** Libère une quantité facturée (brouillon supprimé, correction, retour) : plus rien d'affecté quand la quantité revient à zéro. */
export function release(done: Billed, qty: number, amounts: Amounts): Billed {
  const q = Math.max(0, q3(done.qty - qty));
  if (q <= EPS) return { qty: 0, after: 0, share: 0, discount: 0 };
  return { qty: q, after: Math.max(0, done.after - amounts.after), share: Math.max(0, done.share - amounts.share), discount: Math.max(0, done.discount - amounts.discount) };
}
type Priced = { lines: CycleLine[]; totals?: { globalDiscountMinor?: number | null; vatGroups?: { vatCode?: string | null; regime?: string | null; ratePct?: number | null; baseMinor?: number | null }[] | null } | null };
/**
 * Documents antérieurs : la part de remise globale n'était pas toujours enregistrée par ligne. Elle est alors déduite des totaux
 * CONVENUS (par taux de TVA lorsqu'ils concordent), en mémoire uniquement : le document n'est pas modifié.
 */
export function withShares<T extends Priced>(doc: T): T {
  const total = doc.totals?.globalDiscountMinor ?? 0;
  if (doc.lines.reduce((s, l) => s + (l.globalShareMinor ?? 0), 0) === total) return doc;
  const net = (l: CycleLine) => l.netHtMinor ?? 0;
  const key = (code: unknown, regime: unknown, rate: unknown) => groupKey(String(code), String(regime), Number(rate ?? 0));
  const groups = new Map<string, CycleLine[]>(); for (const l of doc.lines) { const k = key(l.vat.code, l.vat.regime, l.vat.ratePct); groups.set(k, [...(groups.get(k) ?? []), l]); }
  const perGroup = [...groups].map(([k, lines]) => { const g = doc.totals?.vatGroups?.find((x) => key(x.vatCode, x.regime, x.ratePct) === k); return { lines, share: g ? lines.reduce((s, l) => s + net(l), 0) - (g.baseMinor ?? 0) : -1 }; });
  const consistent = perGroup.every((g) => g.share >= 0) && perGroup.reduce((s, g) => s + g.share, 0) === total;
  for (const g of consistent ? perGroup : [{ lines: doc.lines, share: total }]) allocateProportional(g.share, g.lines.map(net)).forEach((v, i) => { g.lines[i]!.globalShareMinor = v; });
  return doc;
}
export const billedFields = (b: Billed) => ({ allocatedQty: b.qty, billedAfterMinor: b.after, billedShareMinor: b.share, billedDiscountMinor: b.discount });
/** Montant d'une fraction d'une ligne, cumulée : la somme de toutes les fractions égale exactement `total`. */
export const slice = (total: number, before: number, qty: number, of: number) => (before + qty >= of - EPS ? total : proportion(total, q3(before + qty), of)) - proportion(total, before, of);

type Doc = { _id: Id; cycleRevision?: number | null; lines: CycleLine[] };
/**
 * Écrit les compteurs de lignes d'un document, UNIQUEMENT s'il n'a pas changé depuis sa lecture (compteur de révision), dans la
 * transaction : deux opérations simultanées sur le même document ne peuvent pas consommer deux fois la même quantité.
 */
export async function writeLines<T>(M: Model<T>, companyId: Id, doc: Doc, changes: Map<string, Record<string, unknown>>, session: ClientSession, extra: { $set?: Record<string, unknown>; $addToSet?: Record<string, unknown>; $pull?: Record<string, unknown>; $push?: Record<string, unknown>; $unset?: Record<string, unknown> } = {}) {
  const $set: Record<string, unknown> = { ...extra.$set }; const arrayFilters: Record<string, unknown>[] = [];
  [...changes.entries()].forEach(([lineId, fields], i) => {
    const line = doc.lines.find((l) => String(l._id) === lineId);
    if (!line) throw AppError.conflict('Ligne du document introuvable');
    Object.assign(line, fields);
    for (const [k, v] of Object.entries(fields)) $set[`lines.$[l${i}].${k}`] = v;
    arrayFilters.push({ [`l${i}._id`]: line._id });
  });
  const ops = Object.fromEntries(Object.entries(extra).filter(([k]) => k !== '$set'));
  const r = await M.updateOne({ _id: doc._id, companyId, cycleRevision: doc.cycleRevision ?? null } as never,
    { ...(Object.keys($set).length && { $set }), ...ops, $inc: { cycleRevision: 1 } } as never, { session, ...(arrayFilters.length && { arrayFilters }) });
  if (!r.matchedCount) throw new AppError(409, 'Le document a changé entre-temps : réessayez', 'CONCURRENT_UPDATE');
  doc.cycleRevision = (doc.cycleRevision ?? 0) + 1;
}
