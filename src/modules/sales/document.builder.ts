import { effectiveStatus, STATUS_LABEL } from '../customers/customer.service.js';
import { effectiveStatus as effectiveProductStatus, STATUS_LABEL as PRODUCT_STATUS_LABEL } from '../products/product.service.js';
import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { Customer } from '../../models/customer.model.js';
import { Product } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { minorInt } from '../parties/party.shared.js';
import { addressesOf, resolveAddress, type AddressSnapshot } from '../parties/delivery-address.js';
import { CalculationError, computeDocument, type CalcInput, type CalcLine, type DocTotals, type VatRegime } from '../../services/calculation.service.js';
import { resolveStamp, resolveVat, resolveWithholding, type VatSnapshot } from '../../services/fiscal.service.js';
import { assertQuantities } from '../products/units.js';

type Id = Types.ObjectId;
export type DocType = 'quotation' | 'proforma' | 'invoice' | 'creditNote' | 'deliveryNote';

// ---- Schémas de validation communs (API) ----
/** Remise en pourcentage saisie : un chiffre après la virgule au plus (les documents antérieurs gardent leurs valeurs). */
export const discountPct = z.number().min(0, 'Remise entre 0 et 100 %').max(100, 'Remise entre 0 et 100 %').refine((d) => Math.abs(d * 10 - Math.round(d * 10)) < 1e-6, 'Remise : un seul chiffre après la virgule');
export const lineBody = z.object({
  /** Identifiant de la ligne existante (devis) : conservé à la modification pour suivre son historique. Ignoré ailleurs. */
  id: objectId.optional(),
  productId: objectId.optional(), designation: z.string().trim().min(1).max(300).optional(), description: z.string().trim().max(1000).optional(),
  unit: z.string().trim().max(12).optional(),
  quantity: z.number().gt(0).max(1e9).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, '3 décimales maximum'),
  unitPriceMinor: minorInt.optional(),
  discountPct: discountPct.default(0),
  vatCode: z.string().trim().min(1).max(30).optional(),
  sourceLineId: objectId.optional(),
  /** BL : numéros de série livrés (articles suivis par série). */
  serials: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
}).strict();
export const docFields = {
  customerId: objectId, lines: z.array(lineBody).min(1, 'Au moins une ligne').max(500),
  /** Remise globale en % : fixe la remise de TOUTES les lignes à ce taux (0 : remises libres par ligne). Jamais appliquée une seconde fois au total. */
  syncDiscountPct: discountPct.default(0),
  /** Remise supplémentaire en montant, appliquée après les remises de ligne. */
  globalDiscountMinor: minorInt.default(0),
  /** Ancienne remise globale en % appliquée au total : plus acceptée en saisie. */
  globalDiscountPct: z.number().max(0, 'La remise globale en % s’applique désormais aux lignes : utilisez syncDiscountPct').optional(),
  /** Document antérieur : retire son ancienne remise globale en % (sinon elle est conservée à la modification). */
  removeLegacyDiscount: z.boolean().optional(),
  withholdingOperationType: z.string().trim().max(30).optional(), notes: z.string().trim().max(2000).optional(),
  /** Dérogation aux règles de prix de l'article (prix minimum, remise maximale) : motif obligatoire, permission products:validate, audité. */
  priceOverrideReason: z.string().trim().min(3).max(300).optional(),
  /** Adresse de livraison enregistrée chez le client ; null = aucune ; absent = copie existante ou adresse par défaut. */
  deliveryAddressId: objectId.nullable().optional(),
};
/** Conditions de paiement (devis, proforma, facture) : absentes = copie existante ou celles du client. */
export const paymentTermsDocFields = { paymentTerms: z.string().trim().max(500).nullable().optional(), paymentTermsCustom: z.boolean().optional() };
export type LineInput = z.infer<typeof lineBody> & { vat?: VatSnapshot };
export interface PaymentTerms { paymentTerms?: string | null | undefined; paymentTermsCustom?: boolean | null | undefined }
export interface DocInput extends PaymentTerms { customerId: string | Id; lines: LineInput[]; syncDiscountPct?: number; globalDiscountMinor?: number; removeLegacyDiscount?: boolean | undefined;
  /** INTERNE (conversion, duplication, modification d'un document antérieur) : ancienne remise globale en % à conserver. */
  globalDiscountPct?: number | undefined; withholdingOperationType?: string | null | undefined; deliveryAddressId?: string | null | undefined }
/** Valeurs déjà figées sur le document (modification) ou sur le document source (conversion). */
export interface Inherited extends PaymentTerms { deliveryAddress?: unknown }

export interface BuiltLine {
  productId?: Id; reference?: string | undefined; designation: string; description?: string | undefined; unit?: string | undefined; kind: 'product' | 'service';
  quantity: number; unitPriceMinor: number; discountPct: number; vat: { ruleId: Id; code: string; regime: VatRegime; ratePct: number };
  grossMinor: number; discountMinor: number; netHtMinor: number; globalShareMinor: number; deliveredQty: number; sourceLineId?: Id | string | undefined; serials?: string[] | undefined;
  /** Facture ou avoir issu d’un BL : livraison et ligne base de prix (fixé par le serveur, jamais saisi). */
  delivery?: unknown;
}
export interface BuiltDocument {
  customer: { _id: Id; name: string; taxId?: string | null | undefined; address?: unknown; paymentDelayDays?: number | null | undefined };
  customerSnapshot: { name: string; code?: string | undefined; taxId?: string | undefined; email?: string | undefined; phone?: string | undefined; address?: unknown; shippingAddress?: unknown };
  lines: BuiltLine[]; globalDiscountPct: number; syncDiscountPct: number; globalDiscountMinor: number; withholdingOperationType?: string | undefined;
  withholding?: { ruleId: Id; code: string; ratePct: number; base: 'ht' | 'ttc'; amountMinor: number } | undefined;
  stamp?: { ruleId: Id; code: string; amountMinor: number } | undefined; totals: DocTotals;
  deliveryAddress: AddressSnapshot | null; paymentTerms: string | null; paymentTermsCustom: boolean;
}

/** « Comptant » ou « N jours » : conditions que le délai de paiement suffit à traduire en échéance. */
const STANDARD_TERMS = /^(comptant|\d{1,3}\s*jours?)$/i;
export function resolveTerms(customer: PaymentTerms, input: PaymentTerms, current?: PaymentTerms): { paymentTerms: string | null; paymentTermsCustom: boolean } {
  const of = (x: PaymentTerms) => ({ paymentTerms: x.paymentTerms || null, paymentTermsCustom: !!x.paymentTerms && !!x.paymentTermsCustom });
  if (input.paymentTerms === undefined) return of(current ?? customer);
  const text = input.paymentTerms || null;
  const inherited = [current, customer].find((x) => x?.paymentTerms === text);
  // Le texte libre n'est jamais interprété : il est seulement classé (standard ou personnalisé)
  return of({ paymentTerms: text, paymentTermsCustom: input.paymentTermsCustom ?? (inherited ? inherited.paymentTermsCustom : !STANDARD_TERMS.test(text ?? '')) });
}

/**
 * Construit un document prêt à enregistrer : client, articles, TVA résolue par ligne (règles VALIDÉES à la date du document),
 * totaux calculés par le service de calcul unique, puis retenue à la source et timbre si leurs règles validées s'appliquent.
 * Le serveur ne fait confiance à AUCUN montant calculé par le client.
 */
export async function buildDocument(companyId: Id, docType: DocType, input: DocInput, opts: { date: Date; session?: ClientSession; allowArchivedCustomer?: boolean; inherit?: Inherited; /** Quantités reprises d'un document existant : conservées telles quelles. */ preserveQuantities?: boolean }): Promise<BuiltDocument> {
  const { date, session } = opts;
  const customer = await Customer.findOne({ _id: input.customerId, companyId }).session(session ?? null).lean();
  if (!customer) throw AppError.badRequest('Client invalide');
  const st = effectiveStatus(customer);
  if (st !== 'active' && !opts.allowArchivedCustomer) throw new AppError(409, `Client ${STATUS_LABEL[st].toLowerCase()} : impossible de créer un document`, `CUSTOMER_${st.toUpperCase()}`);

  const productIds = [...new Set(input.lines.map((l) => l.productId).filter(Boolean) as string[])];
  const products = productIds.length ? await Product.find({ _id: { $in: productIds }, companyId }).session(session ?? null).populate('unitId', 'code').lean() : [];
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  if (!opts.preserveQuantities) await assertQuantities(companyId, input.lines.map((l) => ({ productId: l.productId, unit: l.unit, quantity: l.quantity })), session);
  const sync = input.syncDiscountPct ?? 0; const legacy = input.globalDiscountPct ?? 0;
  if (legacy > 0 && (sync > 0 || (input.globalDiscountMinor ?? 0) > 0)) throw new AppError(422, `Ce document porte une ancienne remise globale de ${String(legacy).replace('.', ',')} % appliquée au total : retirez-la avant de saisir une nouvelle remise globale.`, 'LEGACY_DISCOUNT');
  const vatCache = new Map<string, VatSnapshot>();
  const vatFor = async (code: string) => { const k = code.toUpperCase(); if (!vatCache.has(k)) vatCache.set(k, await resolveVat(companyId, k, date, session)); return vatCache.get(k)!; };

  const built: BuiltLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const p = l.productId ? byId.get(l.productId) : undefined;
    if (l.productId && !p) throw AppError.badRequest(`Ligne ${i + 1} : article introuvable`);
    if (p && !opts.allowArchivedCustomer) { const st = effectiveProductStatus(p); if (st !== 'active') throw new AppError(409, `Ligne ${i + 1} : l'article « ${p.reference} » est ${PRODUCT_STATUS_LABEL[st].toLowerCase()} : vente impossible`, `PRODUCT_${st.toUpperCase()}`); }
    const designation = l.designation ?? p?.name;
    const unitPriceMinor = l.unitPriceMinor ?? p?.salePriceMinor;
    const vatCode = l.vat?.code ?? l.vatCode ?? p?.vatRateCode; // le code vient de l'article : jamais de taux imposé par défaut
    if (!designation) throw AppError.badRequest(`Ligne ${i + 1} : désignation requise`);
    if (unitPriceMinor === undefined) throw AppError.badRequest(`Ligne ${i + 1} : prix unitaire requis`);
    if (!vatCode) throw AppError.badRequest(`Ligne ${i + 1} : code de TVA requis (aucun taux n'est appliqué par défaut)`);
    const vat = l.vat ?? await vatFor(vatCode);
    built.push({
      ...(p && { productId: p._id }), reference: p?.reference, designation, description: l.description, unit: l.unit ?? (p?.unitId as { code?: string } | undefined)?.code, kind: p?.kind ?? 'product',
      quantity: l.quantity, unitPriceMinor, discountPct: sync > 0 ? sync : l.discountPct ?? 0, vat: { ruleId: vat.ruleId, code: vat.code, regime: vat.regime, ratePct: vat.ratePct },
      grossMinor: 0, discountMinor: 0, netHtMinor: 0, globalShareMinor: 0, deliveredQty: 0, ...(l.sourceLineId && { sourceLineId: l.sourceLineId }), ...(l.serials?.length && { serials: l.serials }),
    });
  }

  const calcLines: CalcLine[] = built.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct, vatCode: l.vat.code, vatRegime: l.vat.regime, vatRatePct: l.vat.ratePct }));
  const base: CalcInput = { lines: calcLines, ...((input.globalDiscountPct ?? 0) > 0 && { globalDiscountPct: input.globalDiscountPct! }), ...((input.globalDiscountMinor ?? 0) > 0 && { globalDiscountMinor: input.globalDiscountMinor! }) };
  let result;
  let withholding: BuiltDocument['withholding']; let stamp: BuiltDocument['stamp'];
  try {
    result = computeDocument(base);
    const flags = { subjectToWithholding: customer.subjectToWithholding, stampExempt: customer.stampExempt };
    const w = await resolveWithholding(companyId, { operationType: input.withholdingOperationType, date, totalTtcMinor: result.totals.totalTtcMinor, customer: flags }, session);
    const s = await resolveStamp(companyId, { docType, date, totalTtcMinor: result.totals.totalTtcMinor, customer: flags }, session);
    if (w || s) result = computeDocument({ ...base, ...(w && { withholding: { ratePct: w.ratePct, base: w.base } }), ...(s && { stampMinor: s.amountMinor }) });
    if (w) withholding = { ...w, amountMinor: result.totals.withholdingMinor };
    if (s) stamp = { ruleId: s.ruleId, code: s.code, amountMinor: s.amountMinor };
  } catch (e) { if (e instanceof CalculationError) throw new AppError(422, e.message, 'CALCULATION_ERROR'); throw e; }

  result.lines.forEach((r, i) => Object.assign(built[i]!, r));
  return {
    customer: { _id: customer._id, name: customer.name, taxId: customer.taxId, address: customer.address, paymentDelayDays: customer.paymentDelayDays },
    customerSnapshot: { name: customer.name, ...(customer.code && { code: customer.code }), ...(customer.taxId && { taxId: customer.taxId }), ...(customer.email && { email: customer.email }), ...(customer.phone && { phone: customer.phone }), address: customer.address },
    deliveryAddress: resolveAddress(customer, input.deliveryAddressId, opts.inherit?.deliveryAddress as AddressSnapshot | null | undefined),
    ...resolveTerms(customer, input, opts.inherit && opts.inherit.paymentTerms !== undefined ? opts.inherit : undefined),
    lines: built, globalDiscountPct: legacy, syncDiscountPct: sync, globalDiscountMinor: input.globalDiscountMinor ?? 0,
    ...(input.withholdingOperationType && { withholdingOperationType: input.withholdingOperationType }), withholding, stamp, totals: result.totals,
  };
}

type Frozen = PaymentTerms & { customerId: unknown; deliveryAddress?: unknown };
/** Adresse et conditions figées d'un document, à conserver tant que le client reste le même. */
export const inheritFrom = (d: Frozen, customerId: unknown): Inherited | undefined => (String(d.customerId) === String(customerId)
  ? { deliveryAddress: d.deliveryAddress, paymentTerms: d.paymentTerms, paymentTermsCustom: d.paymentTermsCustom } : undefined);
/** Modification d'un document antérieur : son ancienne remise globale est conservée tant qu'on ne demande pas à la retirer. */
export const legacyDiscountOf = (current: { globalDiscountPct?: number | null }, body: { removeLegacyDiscount?: boolean | undefined }) => ((current.globalDiscountPct ?? 0) > 0 && !body.removeLegacyDiscount ? { globalDiscountPct: current.globalDiscountPct! } : { globalDiscountPct: 0 });
/** Remises à reprendre lors d'une conversion ou d'une duplication : montants identiques au document source. */
export const discountsOf = (d: { globalDiscountPct?: number | null; syncDiscountPct?: number | null; globalDiscountMinor?: number | null }) => ({ globalDiscountPct: d.globalDiscountPct ?? 0, syncDiscountPct: d.syncDiscountPct ?? 0, globalDiscountMinor: d.globalDiscountMinor ?? 0 });
/** Champs à enregistrer sur un devis, une proforma ou une facture. */
export const frozenOf = (d: BuiltDocument) => ({ deliveryAddress: d.deliveryAddress, paymentTerms: d.paymentTerms, paymentTermsCustom: d.paymentTermsCustom });
/** Duplication : l'adresse du document source n'est reprise que si elle est toujours active chez le client (sinon adresse par défaut). */
export async function stillActiveAddress(companyId: Id, customerId: Id, s: AddressSnapshot | null | undefined): Promise<string | null | undefined> {
  if (!s) return s;
  const c = await Customer.findOne({ _id: customerId, companyId }).lean();
  return c && addressesOf(c).some((a) => !a.archivedAt && a._id.toString() === s.addressId?.toString()) ? s.addressId!.toString() : undefined;
}

/** Convertit les lignes enregistrées d'un document en entrées de calcul (conversion devis → facture, etc.). `keepVat` conserve la TVA d'origine ; `withSource` gère la traçabilité des lignes. */
export const linesToInput = (lines: { productId?: Id | null; designation: string; description?: string | null; unit?: string | null; quantity: number; unitPriceMinor: number; discountPct?: number | null;
  vat: { code?: string | null; ruleId?: Id | null; regime?: string | null; ratePct?: number | null }; _id?: Id; sourceLineId?: Id | null }[], keepVat = false, withSource: false | 'self' | 'keep' = false): LineInput[] =>
  lines.map((l) => ({
    ...(l.productId && { productId: l.productId.toString() }), designation: l.designation, ...(l.description && { description: l.description }), ...(l.unit && { unit: l.unit }),
    quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct ?? 0, vatCode: l.vat.code!,
    ...(keepVat && { vat: { ruleId: l.vat.ruleId!, code: l.vat.code!, regime: l.vat.regime as VatRegime, ratePct: l.vat.ratePct ?? 0 } }),
    // 'self' : la ligne devient source (BL / avoir créés depuis ce document) ; 'keep' : conserve la source déjà enregistrée
    ...(withSource === 'self' && l._id && { sourceLineId: l._id.toString() }), ...(withSource === 'keep' && l.sourceLineId && { sourceLineId: l.sourceLineId.toString() }),
  }));

/** Aperçu des totaux sans enregistrement (formulaires) : même moteur que l'enregistrement. */
export async function previewTotals(companyId: Id, docType: DocType, input: DocInput, date: Date) {
  // L'aperçu ne porte que sur les montants : adresse et conditions sont ignorées
  const { deliveryAddressId: _a, ...amounts } = input;
  const b = await buildDocument(companyId, docType, amounts, { date, allowArchivedCustomer: true });
  return { lines: b.lines.map((l) => ({ grossMinor: l.grossMinor, discountMinor: l.discountMinor, netHtMinor: l.netHtMinor, vat: l.vat })), totals: b.totals, withholding: b.withholding ?? null, stamp: b.stamp ?? null };
}
