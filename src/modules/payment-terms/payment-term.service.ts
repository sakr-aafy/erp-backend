import type { Types } from 'mongoose';
import { Customer } from '../../models/customer.model.js';
import { PurchaseOrder } from '../../models/logistics.model.js';
import { PaymentTerm, type PaymentTermDoc } from '../../models/payment-term.model.js';
import { Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { Setting } from '../../models/setting.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { escapeRegex } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';

type Id = Types.ObjectId;
type Lean = PaymentTermDoc & { _id: Id };

/** Conditions proposées à la première mise en service ; ensuite entièrement administrables (aucune liste figée). */
export const DEFAULT_PAYMENT_TERMS: [string, number | null][] = [
  ['Comptant', 0], ['30 jours', 30], ['60 jours', 60], ['90 jours', 90],
  ['30 % à la commande et 70 % avant livraison', null], ['Paiement avant expédition', null], ['Paiement après réception', null],
];
const COLLATION = { locale: 'fr', strength: 2 } as const;
/** « Comptant » et « N jours » se traduisent sans ambiguïté en délai ; tout autre texte reste une description. */
export const delayOf = (label: string): number | null => (/^comptant$/i.test(label.trim()) ? 0 : /^(\d{1,3})\s*jours?$/i.test(label.trim()) ? Math.min(365, Number.parseInt(label, 10)) : null);

/** Création initiale (une seule fois par société) : conditions proposées. Une condition supprimée ensuite n'est pas recréée. */
export async function ensurePaymentTerms(companyId: Id) {
  const s = await Setting.findOne({ companyId }).select('paymentTermsInitialisedAt').lean();
  if (!s || s.paymentTermsInitialisedAt) return;
  for (const [label, delayDays] of DEFAULT_PAYMENT_TERMS) {
    await PaymentTerm.updateOne({ companyId, label }, { $setOnInsert: { companyId, label, delayDays } }, { upsert: true, collation: COLLATION }).catch((e) => { if ((e as { code?: number }).code !== 11000) throw e; });
  }
  await Setting.updateOne({ companyId }, { paymentTermsInitialisedAt: new Date() });
}

const MODELS = { customers: Customer, suppliers: Supplier, quotations: Quotation, proformas: Proforma, invoices: Invoice, purchaseOrders: PurchaseOrder } as const;
/** Nombre de fiches et de documents portant exactement ce texte. */
async function usageOf(companyId: Id, label: string) {
  const entries = await Promise.all(Object.entries(MODELS).map(async ([k, M]) => [k, await (M as typeof Customer).countDocuments({ companyId, paymentTerms: label })] as const));
  const by = Object.fromEntries(entries) as Record<keyof typeof MODELS, number>;
  return { parties: by.customers + by.suppliers, documents: by.quotations + by.proformas + by.invoices + by.purchaseOrders, customers: by.customers };
}
async function dto(companyId: Id, t: Lean) {
  const u = await usageOf(companyId, t.label);
  return { id: t._id.toString(), label: t.label, delayDays: t.delayDays ?? null, isActive: t.isActive !== false, isDefault: !!t.isDefault, partyCount: u.parties, customerCount: u.customers, documentCount: u.documents, used: u.parties + u.documents > 0 };
}

export async function list(companyId: Id, f: { q?: string | undefined; active?: boolean | undefined } = {}) {
  await ensurePaymentTerms(companyId);
  const filter: Record<string, unknown> = { companyId };
  if (f.active !== undefined) filter.isActive = f.active;
  if (f.q) filter.label = new RegExp(escapeRegex(f.q), 'i');
  const items = (await PaymentTerm.find(filter).lean()) as Lean[];
  // Ordre : délais croissants, puis descriptions commerciales par libellé
  items.sort((a, b) => (a.delayDays ?? 1e6) - (b.delayDays ?? 1e6) || a.label.localeCompare(b.label, 'fr'));
  return { items: await Promise.all(items.map((t) => dto(companyId, t))) };
}
async function own(companyId: Id, id: string) {
  const t = await PaymentTerm.findOne({ _id: id, companyId }).lean();
  if (!t) throw AppError.notFound('Condition de paiement introuvable');
  return t as Lean;
}
async function assertFree(companyId: Id, label: string, exceptId?: Id) {
  const other = await PaymentTerm.findOne({ companyId, label, ...(exceptId && { _id: { $ne: exceptId } }) }).collation(COLLATION).select('label').lean();
  if (other) throw AppError.conflict(`La condition « ${other.label} » existe déjà`);
}
const duplicate = (e: unknown, label: string): never => { if ((e as { code?: number }).code === 11000) throw AppError.conflict(`La condition « ${label} » existe déjà`); throw e; };

export async function create(companyId: Id, b: { label: string; delayDays?: number | null | undefined }) {
  await ensurePaymentTerms(companyId);
  await assertFree(companyId, b.label);
  const t = await PaymentTerm.create({ companyId, label: b.label, delayDays: b.delayDays === undefined ? delayOf(b.label) : b.delayDays }).catch((e) => duplicate(e, b.label));
  return dto(companyId, t.toObject() as Lean);
}
/** Modification : les fiches clients et fournisseurs qui portent cette condition la suivent ; les documents gardent leur copie. */
export async function update(companyId: Id, id: string, b: { label?: string | undefined; delayDays?: number | null | undefined }) {
  const t = await own(companyId, id);
  const label = b.label ?? t.label; const delayDays = b.delayDays === undefined ? t.delayDays ?? null : b.delayDays;
  if (label !== t.label) await assertFree(companyId, label, t._id);
  await withTransaction(async (session) => {
    await PaymentTerm.updateOne({ _id: t._id, companyId }, { label, delayDays }, { session });
    const set = { paymentTerms: label, paymentTermsCustom: delayDays === null, ...(delayDays !== null && { paymentDelayDays: delayDays }) };
    await Customer.updateMany({ companyId, paymentTerms: t.label }, { $set: set }, { session });
    await Supplier.updateMany({ companyId, paymentTerms: t.label }, { $set: set }, { session });
  }).catch((e) => duplicate(e, label));
  return dto(companyId, { ...t, label, delayDays });
}
export async function setActive(companyId: Id, id: string, isActive: boolean) {
  const t = await own(companyId, id);
  await PaymentTerm.updateOne({ _id: t._id, companyId }, { isActive, ...(!isActive && { isDefault: false }) });
  return dto(companyId, { ...t, isActive, ...(!isActive && { isDefault: false }) });
}
/** Condition proposée par défaut à la création d'un client (une seule, active) ; `false` la retire. */
export async function setDefault(companyId: Id, id: string, isDefault: boolean) {
  const t = await own(companyId, id);
  if (isDefault && t.isActive === false) throw AppError.conflict('Réactivez la condition avant de la définir par défaut');
  await withTransaction(async (session) => {
    if (isDefault) await PaymentTerm.updateMany({ companyId, isDefault: true }, { isDefault: false }, { session });
    await PaymentTerm.updateOne({ _id: t._id, companyId }, { isDefault }, { session });
  });
  return dto(companyId, { ...t, isDefault });
}
export async function remove(companyId: Id, id: string) {
  const t = await own(companyId, id);
  const u = await usageOf(companyId, t.label);
  if (u.parties + u.documents > 0) throw new AppError(409, `Condition utilisée (${u.parties} fiche(s), ${u.documents} document(s)) : désactivez-la au lieu de la supprimer`, 'PAYMENT_TERM_IN_USE', { parties: u.parties, documents: u.documents });
  await PaymentTerm.deleteOne({ _id: t._id, companyId });
  return t;
}
