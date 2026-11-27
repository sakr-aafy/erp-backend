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
    /** BL : numéros de série livrés (articles suivis par série) ; repris sur les lignes de facture issues de ces BL. */
    serials: { type: [String], default: undefined },
    // ---- Cycle commercial (aucune valeur par défaut : absent des documents qui ne l'utilisent pas) ----
    /** Quantité affectée à des factures (brouillons et validées), nette des corrections : réservation atomique contre la double facturation. */
    allocatedQty: Number,
    /** Quantité facturée par des factures VALIDÉES, nette des corrections. */
    invoicedQty: Number,
    /** Quantité physiquement retournée (BL) ou retournée au total (ligne source). */
    returnedQty: Number,
    /** Ligne « base de prix » : montants déjà affectés à des factures (net après toutes remises, part de remise globale, remise de ligne). */
    billedAfterMinor: Number, billedShareMinor: Number, billedDiscountMinor: Number,
    /** BL : numéros de série affectés à une facture. */
    billedSerials: { type: [String], default: undefined },
    /** Ligne de facture (ou d'avoir) issue d'un BL : livraison et ligne de prix d'origine. */
    delivery: { type: new Schema({ noteId: Schema.Types.ObjectId, noteNumber: String, lineId: Schema.Types.ObjectId, basisType: { type: String, enum: ['proforma', 'quotation', 'deliveryNote'] }, basisId: Schema.Types.ObjectId, basisLineId: Schema.Types.ObjectId }, { _id: false }) },
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
const customerSnapshot = new Schema({ name: String, code: String, taxId: String, email: String, phone: String, address: addressSchema, shippingAddress: addressSchema }, { _id: false });
const withholdingSchema = new Schema({ ruleId: oid('FiscalRule'), code: String, ratePct: Number, base: String, amountMinor: Number }, { _id: false });
const stampSchema = new Schema({ ruleId: oid('FiscalRule'), code: String, amountMinor: Number }, { _id: false });

const commonDoc = {
  companyId: oid('Company', true), customerId: oid('Customer', true), customerSnapshot: { type: customerSnapshot, required: true },
  lines: { type: [lineSchema], default: [] },
  /** ANCIENNE remise globale en % appliquée au total (documents antérieurs uniquement). */
  globalDiscountPct: { type: Number, default: 0 },
  /** Remise globale en % recopiée sur toutes les lignes (déjà comprise dans leurs nets). */
  syncDiscountPct: { type: Number, default: 0 },
  /** Remise supplémentaire en montant, répartie après les remises de ligne. */
  globalDiscountMinor: { type: Number, default: 0 },
  withholdingOperationType: String, withholding: withholdingSchema, stamp: stampSchema, totals: { type: totalsSchema, required: true },
  notes: { type: String, trim: true }, createdBy: oid('User'), sentAt: Date,
  /** Compteur des écritures du cycle (livraisons, facturation, annulation) : refus des écritures concurrentes. */
  cycleRevision: Number,
  /** Copie de l'adresse de livraison choisie (null : aucune ; absent : document antérieur, voir customerSnapshot.shippingAddress). */
  deliveryAddress: { type: addressSnapshotSchema },
};
/** Conditions de paiement copiées sur le document (devis, proforma, facture). */
const paymentTermsFields = { paymentTerms: { type: String, trim: true }, paymentTermsCustom: { type: Boolean } };

// ---- Devis ----
const quotationSchema = new Schema({
  ...commonDoc, ...paymentTermsFields, number: { type: String, required: true }, issueDate: { type: Date, required: true }, validUntil: { type: Date, required: true },
  /** « pending » : ancienne valeur de « draft », lue comme brouillon jusqu'à la migration. */
  status: { type: String, enum: ['draft', 'sent', 'accepted', 'refused', 'expired', 'cancelled', 'pending'], default: 'draft' }, acceptedAt: Date, refusedAt: Date, expiredAt: Date, cancelledAt: Date, cancelReason: String,
  /** Version courante (le numéro de devis ne change pas d'une version à l'autre). */
  version: { type: Number, default: 1 }, versionCreatedAt: Date, versionCreatedByName: String,
  /** Version acceptée par le client : c'est elle qui est convertie en proforma. */
  acceptedVersion: Number,
  /** Compteur de modifications (refus des écritures concurrentes). */
  revision: { type: Number, default: 0 },
  /** Envoi en cours : le contenu ne peut pas changer entre la génération du PDF et l'enregistrement de la version envoyée. */
  sendingUntil: Date,
  deliveryTime: { type: String, trim: true },
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
  'marked_sent', 'email_sent', 'accepted', 'refused', 'expired', 'duplicated', 'converted_proforma', 'converted_invoice', 'invoice_unlinked',
  'delivery_time_changed', 'version_created', 'version_abandoned', 'cancelled', 'document_added', 'document_updated', 'document_removed', 'comment_added', 'comment_edited', 'comment_archived', 'migrated'] as const;
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

// ---- Versions d'un devis : copies FIGÉES (le contenu ne se modifie ni ne se supprime) ----
export const VERSION_STATUSES = ['sent', 'accepted', 'refused', 'expired', 'cancelled', 'superseded', 'abandoned', 'draft'] as const;
const quotationVersionSchema = new Schema({
  companyId: oid('Company', true), quotationId: oid('Quotation', true), version: { type: Number, required: true },
  /** Seul élément qui évolue (envoyée → acceptée, refusée, expirée, remplacée…). */
  status: { type: String, enum: VERSION_STATUSES, required: true },
  /** Copie complète du devis au moment du gel : client, adresses, dates, conditions, lignes, TVA, remises, totaux, devise. */
  snapshot: { type: Schema.Types.Mixed, required: true },
  versionCreatedAt: Date, authorName: String, frozenAt: { type: Date, required: true },
  sentAt: Date, sentByName: String, sentTo: String, sentMethod: String,
  /** « migration » : copie de référence de l'état disponible à la date de migration — ce n'est pas un historique. */
  origin: { type: String, enum: ['application', 'migration'], default: 'application' },
  /** PDF généré au moment du gel (identique à celui transmis). */
  pdfFileId: Schema.Types.ObjectId,
}, { timestamps: true, minimize: false });
quotationVersionSchema.index({ companyId: 1, quotationId: 1, version: 1 }, { unique: true });
const VERSION_MUTABLE = new Set(['status', 'sentAt', 'sentByName', 'sentTo', 'sentMethod', 'updatedAt']);
quotationVersionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const u = (this.getUpdate() ?? {}) as Record<string, unknown>;
  const keys = Object.entries(u).flatMap(([k, v]) => (k === '$set' || k === '$unset' ? Object.keys(v as object) : k === '$setOnInsert' ? [] : [k]));
  if (keys.some((k) => !VERSION_MUTABLE.has(k))) throw new Error('Une version de devis est figée : son contenu ne se modifie pas');
});
quotationVersionSchema.pre(['replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () { throw new Error('Une version de devis ne se supprime pas'); });
export type QuotationVersionDoc = InferSchemaType<typeof quotationVersionSchema>;
export const QuotationVersion = model('QuotationVersion', quotationVersionSchema);

// ---- Pièces jointes d'un devis (GridFS « quotationFiles ») ----
export const QUOTATION_DOC_TYPES = ['price_request', 'specifications', 'catalog', 'datasheet', 'drawing', 'signed_quote', 'customer_confirmation', 'other'] as const;
const quotationDocumentSchema = new Schema({
  companyId: oid('Company', true), quotationId: oid('Quotation', true), type: { type: String, enum: QUOTATION_DOC_TYPES, required: true }, description: { type: String, trim: true },
  /** Version du devis concernée (facultatif). */
  version: Number,
  originalName: { type: String, required: true }, fileId: { type: Schema.Types.ObjectId, required: true }, mime: String, size: { type: Number, default: 0 },
  uploadedBy: oid('User'), uploadedByName: String,
}, { timestamps: true });
quotationDocumentSchema.index({ companyId: 1, quotationId: 1, createdAt: -1 });
export const QuotationDocument = model('QuotationDocument', quotationDocumentSchema);

// ---- Commentaires INTERNES : jamais imprimés ni envoyés ----
const quotationCommentSchema = new Schema({
  companyId: oid('Company', true), quotationId: oid('Quotation', true), body: { type: String, required: true, trim: true },
  authorId: oid('User'), authorName: String, editedAt: Date, editedByName: String,
  /** Retrait : le commentaire est archivé, jamais effacé. */
  archivedAt: Date, archivedByName: String,
}, { timestamps: true });
quotationCommentSchema.index({ companyId: 1, quotationId: 1, createdAt: -1 });
export const QuotationComment = model('QuotationComment', quotationCommentSchema);

// ---- Facture proforma (série de numéros distincte des factures définitives) ----
const proformaSchema = new Schema({
  ...commonDoc, ...paymentTermsFields, number: { type: String, required: true }, issueDate: { type: Date, required: true }, validUntil: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'converted', 'expired', 'cancelled'], default: 'pending' },
  quotationId: oid('Quotation'), invoiceId: oid('Invoice'), terms: { type: String, trim: true }, cancelledAt: Date, cancelledBy: oid('User'), cancelledByName: String, cancelReason: String,
  /** Version du devis acceptée et convertie. */
  quotationVersion: Number, quotationNumber: String,
  deliveryTime: { type: String, trim: true },
  /** Transmission au client (e-mail ou remise notée) : « Envoyée ». */
  sentByName: String, sentTo: String, sentMethod: String,
  /** Document issu de l'ancien parcours (converti directement en facture). */
  legacyFlow: Boolean,
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
  validatedAt: Date, validatedBy: oid('User'), validatedByName: String,
  /** « delivery » : lignes issues de BL, quantités et montants affectés par le serveur (non modifiables). Absent : saisie directe ou ancien parcours. */
  origin: { type: String, enum: ['delivery'] },
  /** Références imprimées de la chaîne commerciale, copiées à la création. */
  sourceRefs: { type: new Schema({ quotationNumber: String, quotationVersion: Number, proformaNumber: String }, { _id: false }) },
  /** Avoir : effet sur les quantités. « financial » : aucun ; « return » : retour physique attendu ; « billing_correction » : quantités à refacturer. */
  creditEffect: { type: String, enum: ['financial', 'return', 'billing_correction'] },
  legacyFlow: Boolean,
}, { timestamps: true });
invoiceSchema.index({ companyId: 1, type: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
invoiceSchema.index({ companyId: 1, status: 1, issueDate: -1 });
invoiceSchema.index({ companyId: 1, customerId: 1, status: 1 });
invoiceSchema.index({ companyId: 1, customerId: 1, issueDate: -1 }); // fiche client : historique par date
invoiceSchema.index({ companyId: 1, paymentStatus: 1, 'schedule.dueDate': 1 });
invoiceSchema.index({ companyId: 1, creditedInvoiceId: 1 });
invoiceSchema.index({ companyId: 1, 'lines.productId': 1 });
invoiceSchema.index({ companyId: 1, proformaId: 1 });
invoiceSchema.index({ companyId: 1, quotationId: 1 });
invoiceSchema.index({ companyId: 1, deliveryNoteIds: 1 });
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
/** Retour physique de marchandise livrée : réintégration au stock confirmée par l'utilisateur. Ajout seul. */
const returnSchema = new Schema({
  /** Clé fournie par l'appelant : une requête rejouée ne crée pas un second retour. */
  requestId: String, date: { type: Date, required: true }, warehouseId: oid('Warehouse'), reason: { type: String, required: true }, userId: oid('User'), userName: String,
  lines: [new Schema({ lineId: Schema.Types.ObjectId, quantity: Number, serials: { type: [String], default: undefined },
    /** Part déjà facturée puis créditée (avoir « retour ») : quantités et montants rouverts. */
    credited: [new Schema({ creditNoteId: Schema.Types.ObjectId, invoiceId: Schema.Types.ObjectId, invoiceLineId: Schema.Types.ObjectId, quantity: Number, afterMinor: Number, shareMinor: Number, discountMinor: Number }, { _id: false })] }, { _id: false })],
}, { timestamps: { createdAt: true, updatedAt: false } });
const deliveryNoteSchema = new Schema({
  ...commonDoc, number: { type: String, required: true }, deliveryDate: { type: Date, required: true }, carrier: { type: String, trim: true },
  status: { type: String, enum: ['draft', 'validated', 'cancelled'], default: 'draft' },
  source: { type: new Schema({ type: { type: String, enum: ['quotation', 'proforma', 'invoice'] }, id: Schema.Types.ObjectId, number: String }, { _id: false }) },
  /** Renseigné dès qu'une facture (brouillon ou validée) est créée depuis ce BL : il n'est alors plus annulable. */
  invoiceId: oid('Invoice'), validatedAt: Date, validatedBy: oid('User'), cancelledAt: Date, cancelReason: String,
  /** Magasin de sortie du stock (choisi à la saisie ou à la validation, sinon magasin par défaut). */
  warehouseId: oid('Warehouse'),
  /** Factures portant au moins une quantité de ce BL. */
  invoiceIds: { type: [oid('Invoice')], default: undefined },
  validatedByName: String, cancelledBy: oid('User'), cancelledByName: String,
  returns: { type: [returnSchema], default: undefined }, legacyFlow: Boolean,
}, { timestamps: true });
deliveryNoteSchema.index({ companyId: 1, number: 1 }, { unique: true });
deliveryNoteSchema.index({ companyId: 1, status: 1, deliveryDate: -1 });
deliveryNoteSchema.index({ companyId: 1, customerId: 1, status: 1 });
deliveryNoteSchema.index({ companyId: 1, customerId: 1, deliveryDate: -1 }); // fiche client : historique par date
deliveryNoteSchema.index({ companyId: 1, 'source.id': 1 });
deliveryNoteSchema.index({ companyId: 1, invoiceIds: 1 });
deliveryNoteSchema.index({ companyId: 1, 'lines.productId': 1 });
export type DeliveryNoteDoc = InferSchemaType<typeof deliveryNoteSchema>;
export const DeliveryNote = model('DeliveryNote', deliveryNoteSchema);
