import { Schema, model, type InferSchemaType } from 'mongoose';
import { addressSchema } from '../modules/parties/party.shared.js';
import { addressSnapshotSchema } from '../modules/parties/delivery-address.js';

const oid = (ref: string, required = false) => ({ type: Schema.Types.ObjectId, ref, required });

/** Ligne de document. Les données article/TVA sont COPIÉES (snapshot) : un document ne change jamais si l'article ou la règle évolue. */
export const lineSchema = new Schema(
  {
    productId: oid('Product'), reference: String, designation: { type: String, required: true, trim: true }, description: String, unit: String,
    /** Devis : position affichée (10, 20, 30…). Ordre d'affichage uniquement : l'identifiant technique de la ligne est `_id`. */
    position: Number,
    kind: { type: String, enum: ['product', 'service'], default: 'product' },
    quantity: { type: Number, required: true }, unitPriceMinor: { type: Number, required: true, min: 0 }, discountPct: { type: Number, default: 0 },
    vat: { type: new Schema({ ruleId: oid('FiscalRule'), code: String, regime: String, ratePct: Number }, { _id: false }), required: true },
    grossMinor: Number, discountMinor: Number, netHtMinor: Number,
    /** Part de la remise globale imputée à cette ligne (avoirs partiels proportionnels). */
    globalShareMinor: { type: Number, default: 0 },
    /** Quantité déjà livrée (suivi des livraisons partielles sur devis / proforma / facture). */
    deliveredQty: { type: Number, default: 0 },
    /** Ligne du document source (BL → ligne de devis/proforma/facture ; avoir → ligne de la facture créditée). */
    sourceLineId: Schema.Types.ObjectId,
    /** BL : numéros de série livrés (articles suivis par série). */
    serials: { type: [String], default: undefined },
  },
  { _id: true },
);

export const totalsSchema = new Schema(
  {
    grossMinor: Number, lineDiscountsMinor: Number, globalDiscountMinor: Number, totalHtMinor: Number,
    vatGroups: [new Schema({ vatCode: String, regime: String, ratePct: Number, baseMinor: Number, vatMinor: Number }, { _id: false })],
    totalVatMinor: Number, totalTtcMinor: Number, stampMinor: Number, withholdingMinor: Number, totalPayableMinor: Number,
  },
  { _id: false },
);
const customerSnapshot = new Schema({ name: String, code: String, taxId: String, address: addressSchema, shippingAddress: addressSchema }, { _id: false });
const withholdingSchema = new Schema({ ruleId: oid('FiscalRule'), code: String, ratePct: Number, base: String, amountMinor: Number }, { _id: false });
const stampSchema = new Schema({ ruleId: oid('FiscalRule'), code: String, amountMinor: Number }, { _id: false });

const commonDoc = {
  companyId: oid('Company', true), customerId: oid('Customer', true), customerSnapshot: { type: customerSnapshot, required: true },
  lines: { type: [lineSchema], default: [] }, globalDiscountPct: { type: Number, default: 0 }, globalDiscountMinor: { type: Number, default: 0 },
  withholdingOperationType: String, withholding: withholdingSchema, stamp: stampSchema, totals: { type: totalsSchema, required: true },
  notes: { type: String, trim: true }, createdBy: oid('User'), sentAt: Date,
  /** Copie de l'adresse de livraison choisie (null : aucune ; absent : document antérieur, voir customerSnapshot.shippingAddress). */
  deliveryAddress: { type: addressSnapshotSchema },
};
/** Conditions de paiement copiées sur le document (devis, proforma, facture). */
const paymentTermsFields = { paymentTerms: { type: String, trim: true }, paymentTermsCustom: { type: Boolean } };

// ---- Devis ----
const quotationSchema = new Schema({
  ...commonDoc, ...paymentTermsFields, number: { type: String, required: true }, issueDate: { type: Date, required: true }, validUntil: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sent', 'accepted', 'refused', 'expired'], default: 'pending' }, acceptedAt: Date, refusedAt: Date, expiredAt: Date,
  /** Transmission au client (e-mail depuis l'ERP ou marquage manuel). `sentAt` : dernier envoi. */
  sentBy: oid('User'), sentByName: String, sentTo: String, sentMethod: { type: String, enum: ['email', 'hand', 'post', 'whatsapp', 'phone', 'other'] },
  acceptedBy: oid('User'), acceptedByName: String, acceptanceNote: String, refusedBy: oid('User'), refusedByName: String, refusalReason: String,
  /** Devis d'origine lorsqu'il s'agit d'une duplication (révision commerciale). */
  duplicatedFromId: oid('Quotation'),
  terms: { type: String, trim: true }, proformaId: oid('Proforma'), invoiceId: oid('Invoice'),
}, { timestamps: true });
quotationSchema.index({ companyId: 1, number: 1 }, { unique: true });
quotationSchema.index({ companyId: 1, status: 1, validUntil: 1 });
quotationSchema.index({ companyId: 1, customerId: 1, issueDate: -1 });
quotationSchema.index({ companyId: 1, 'lines.productId': 1 }); // fiche article : transactions
quotationSchema.index({ companyId: 1, issueDate: -1 }); // rapports : devis par période
export type QuotationDoc = InferSchemaType<typeof quotationSchema>;
export const Quotation = model('Quotation', quotationSchema);

// ---- Chronologie métier d'un devis (distincte du journal d'audit de sécurité) : événements IMMUABLES ----
export const QUOTATION_EVENTS = ['created', 'line_added', 'line_removed', 'price_changed', 'discount_changed', 'quantity_changed', 'designation_changed', 'vat_changed', 'lines_reordered',
  'customer_changed', 'payment_terms_changed', 'validity_changed', 'date_changed', 'delivery_address_changed', 'global_discount_changed', 'notes_changed',
  'marked_sent', 'email_sent', 'accepted', 'refused', 'expired', 'duplicated', 'converted_proforma', 'converted_invoice', 'invoice_unlinked'] as const;
const quotationActivitySchema = new Schema({
  companyId: oid('Company', true), quotationId: oid('Quotation', true), kind: { type: String, enum: QUOTATION_EVENTS, required: true },
  occurredAt: { type: Date, required: true }, userId: oid('User'), userName: String,
  /** Événement produit par le système (expiration automatique). */
  system: { type: Boolean, default: false },
  title: { type: String, required: true }, description: String,
  line: { type: new Schema({ lineId: Schema.Types.ObjectId, reference: String, designation: String, position: Number }, { _id: false }) },
  /** Nature des valeurs : money (plus petite unité de la devise), percent, number, text, date. */
  valueType: { type: String, enum: ['money', 'percent', 'number', 'text', 'date'] }, oldValue: Schema.Types.Mixed, newValue: Schema.Types.Mixed,
  related: { type: new Schema({ type: { type: String }, id: Schema.Types.ObjectId, number: String }, { _id: false }) },
  /** Clé d'idempotence des événements qui ne peuvent se produire qu'une fois (création, expiration, conversion…). */
  eventKey: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
quotationActivitySchema.index({ companyId: 1, quotationId: 1, occurredAt: -1 });
quotationActivitySchema.index({ companyId: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: 'string' } } });
quotationActivitySchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () { throw new Error('L’historique d’un devis ne se modifie ni ne se supprime'); });
export type QuotationActivityDoc = InferSchemaType<typeof quotationActivitySchema>;
export const QuotationActivity = model('QuotationActivity', quotationActivitySchema);

// ---- Facture proforma (série de numéros distincte des factures définitives) ----
const proformaSchema = new Schema({
  ...commonDoc, ...paymentTermsFields, number: { type: String, required: true }, issueDate: { type: Date, required: true }, validUntil: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'converted', 'expired', 'cancelled'], default: 'pending' },
  quotationId: oid('Quotation'), invoiceId: oid('Invoice'), terms: { type: String, trim: true }, cancelledAt: Date,
}, { timestamps: true });
proformaSchema.index({ companyId: 1, number: 1 }, { unique: true });
proformaSchema.index({ companyId: 1, status: 1, validUntil: 1 });
proformaSchema.index({ companyId: 1, customerId: 1, issueDate: -1 });
proformaSchema.index({ companyId: 1, 'lines.productId': 1 });
export type ProformaDoc = InferSchemaType<typeof proformaSchema>;
export const Proforma = model('Proforma', proformaSchema);

// ---- Facture de vente / avoir ----
/** Échéance : reste dû = montant − payé − crédité (avoirs imputés sur les échéances les plus lointaines d'abord). */
const scheduleSchema = new Schema({ dueDate: { type: Date, required: true }, percent: Number, amountMinor: { type: Number, default: 0 }, paidMinor: { type: Number, default: 0 }, creditedMinor: { type: Number, default: 0 } }, { _id: true });
const invoiceSchema = new Schema({
  ...commonDoc, ...paymentTermsFields,
  type: { type: String, enum: ['invoice', 'credit_note'], default: 'invoice' },
  /** Attribué à la VALIDATION (numérotation légale sans trou). Absent en brouillon. */
  number: String,
  status: { type: String, enum: ['draft', 'validated'], default: 'draft' },
  issueDate: { type: Date, required: true }, paymentMethod: String, schedule: { type: [scheduleSchema], default: [] },
  paidMinor: { type: Number, default: 0 }, creditedMinor: { type: Number, default: 0 },
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid' },
  creditedInvoiceId: oid('Invoice'), creditReason: String,
  quotationId: oid('Quotation'), proformaId: oid('Proforma'), deliveryNoteIds: [oid('DeliveryNote')],
  validatedAt: Date, validatedBy: oid('User'),
}, { timestamps: true });
invoiceSchema.index({ companyId: 1, type: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
invoiceSchema.index({ companyId: 1, status: 1, issueDate: -1 });
invoiceSchema.index({ companyId: 1, customerId: 1, status: 1 });
invoiceSchema.index({ companyId: 1, customerId: 1, issueDate: -1 }); // fiche client : historique par date
invoiceSchema.index({ companyId: 1, paymentStatus: 1, 'schedule.dueDate': 1 });
invoiceSchema.index({ companyId: 1, creditedInvoiceId: 1 });
invoiceSchema.index({ companyId: 1, 'lines.productId': 1 });
export type InvoiceDoc = InferSchemaType<typeof invoiceSchema>;
export const Invoice = model('Invoice', invoiceSchema);

// ---- Encaissement ----
export const PAYMENT_METHODS = ['cash', 'check', 'transfer', 'card', 'draft', 'other'] as const;
const paymentSchema = new Schema({
  companyId: oid('Company', true), invoiceId: oid('Invoice', true), customerId: oid('Customer', true),
  amountMinor: { type: Number, required: true, min: 1 }, method: { type: String, enum: PAYMENT_METHODS, required: true },
  paidAt: { type: Date, required: true }, reference: String, note: String, treasuryAccountId: oid('TreasuryAccount'),
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' }, cancelledAt: Date, cancelledBy: oid('User'), cancelReason: String,
  /** Répartition sur les échéances de la facture (pour pouvoir l'annuler exactement). */
  allocations: [new Schema({ scheduleId: Schema.Types.ObjectId, amountMinor: Number }, { _id: false })],
  createdBy: oid('User'),
}, { timestamps: true });
paymentSchema.index({ companyId: 1, invoiceId: 1, status: 1 });
paymentSchema.index({ companyId: 1, customerId: 1, paidAt: -1 });
paymentSchema.index({ companyId: 1, status: 1, paidAt: -1 }); // rapports : encaissements par période
export type PaymentDoc = InferSchemaType<typeof paymentSchema>;
export const Payment = model('Payment', paymentSchema);

// ---- Bon de livraison ----
const deliveryNoteSchema = new Schema({
  ...commonDoc, number: { type: String, required: true }, deliveryDate: { type: Date, required: true }, carrier: { type: String, trim: true },
  status: { type: String, enum: ['draft', 'validated', 'cancelled'], default: 'draft' },
  source: { type: new Schema({ type: { type: String, enum: ['quotation', 'proforma', 'invoice'] }, id: Schema.Types.ObjectId, number: String }, { _id: false }) },
  /** Renseigné dès qu'une facture (brouillon ou validée) est créée depuis ce BL : il n'est alors plus annulable. */
  invoiceId: oid('Invoice'), validatedAt: Date, validatedBy: oid('User'), cancelledAt: Date, cancelReason: String,
  /** Magasin de sortie du stock (choisi à la validation, sinon magasin par défaut). */
  warehouseId: oid('Warehouse'),
}, { timestamps: true });
deliveryNoteSchema.index({ companyId: 1, number: 1 }, { unique: true });
deliveryNoteSchema.index({ companyId: 1, status: 1, deliveryDate: -1 });
deliveryNoteSchema.index({ companyId: 1, customerId: 1, status: 1 });
deliveryNoteSchema.index({ companyId: 1, customerId: 1, deliveryDate: -1 }); // fiche client : historique par date
deliveryNoteSchema.index({ companyId: 1, 'source.id': 1 });
deliveryNoteSchema.index({ companyId: 1, 'lines.productId': 1 });
export type DeliveryNoteDoc = InferSchemaType<typeof deliveryNoteSchema>;
export const DeliveryNote = model('DeliveryNote', deliveryNoteSchema);
