import { Schema, model, type InferSchemaType } from 'mongoose';
import { addressSchema, contactSchema } from '../modules/parties/party.shared.js';
import { deliveryAddressSchema } from '../modules/parties/delivery-address.js';

export const CUSTOMER_TYPES = ['company', 'walk_in'] as const;
export const CUSTOMER_STATUSES = ['active', 'inactive', 'archived', 'blocked'] as const;
export const CUSTOMER_PAYMENT_METHODS = ['cash', 'check', 'transfer', 'card', 'draft', 'other'] as const;

const customerSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Code client lisible (CL-00001), attribué par un compteur atomique ; unique par société. */
    code: { type: String, trim: true },
    type: { type: String, enum: CUSTOMER_TYPES, default: 'company' },
    /** Raison sociale (société) ou nom du client (passager). */
    name: { type: String, required: true, trim: true },
    tradeName: { type: String, trim: true },
    taxId: { type: String, trim: true },
    /** Champs OBSOLÈTES (retirés des écrans et de l'API) : valeurs historiques conservées, jamais réécrites. */
    registryNumber: { type: String, trim: true },
    sector: { type: String, trim: true },
    /** Adresse de facturation. */
    address: { type: addressSchema, default: () => ({}) },
    /** Adresses de livraison (une seule par défaut). */
    deliveryAddresses: { type: [deliveryAddressSchema], default: [] },
    /** Ancienne adresse de livraison unique : conservée après migration vers `deliveryAddresses`, plus modifiée. */
    shippingAddress: { type: addressSchema },
    shippingSameAsBilling: { type: Boolean },
    /** Saisies d'origine des téléphones reformatés par la migration (réversibilité). */
    phoneOriginals: { type: Schema.Types.Mixed },
    phone: { type: String, trim: true },
    secondaryPhone: { type: String, trim: true },
    website: { type: String, trim: true },
    social: { type: new Schema({ facebook: { type: String, trim: true }, linkedin: { type: String, trim: true }, instagram: { type: String, trim: true } }, { _id: false }) },
    mapsUrl: { type: String, trim: true },
    paymentMethod: { type: String, enum: CUSTOMER_PAYMENT_METHODS },
    /** Remise habituelle (%), proposée à la saisie des documents. */
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    /** Statut métier : active | inactive | archived | blocked. `isArchived` est conservé synchronisé (compatibilité des modules existants). */
    status: { type: String, enum: CUSTOMER_STATUSES, default: 'active' },
    statusReason: { type: String, trim: true },
    statusChangedAt: { type: Date },
    email: { type: String, trim: true, lowercase: true },
    contacts: { type: [contactSchema], default: [] },
    paymentTerms: { type: String, trim: true },
    /** Conditions rédigées librement : les échéances réelles sont alors saisies sur chaque facture. */
    paymentTermsCustom: { type: Boolean, default: false },
    paymentDelayDays: { type: Number, default: 0, min: 0 },
    /** null/absent = crédit illimité. Montant entier en plus petite unité de la devise de base. */
    creditLimitMinor: { type: Number, min: 0 },
    /** Solde courant : lecture seule ici ; mis à jour par factures / règlements (phase 4). */
    balanceMinor: { type: Number, default: 0 },
    /** Conditions fiscales : client assujetti à la retenue à la source / exonéré de timbre (utilisés par les règles fiscales validées). */
    /** Valeur par défaut d'un NOUVEAU client : assujetti. Aucune retenue n'est calculée sans règle fiscale validée applicable. */
    subjectToWithholding: { type: Boolean, default: true },
    stampExempt: { type: Boolean, default: false },
    notes: { type: String, trim: true },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);
// Matricule fiscal unique par société, uniquement s'il est renseigné
customerSchema.index({ companyId: 1, taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } });
customerSchema.index({ companyId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
customerSchema.index({ companyId: 1, status: 1, name: 1 });
customerSchema.index({ companyId: 1, name: 1 });
customerSchema.index({ companyId: 1, isArchived: 1, balanceMinor: -1 });
export type CustomerDoc = InferSchemaType<typeof customerSchema>;
export const Customer = model('Customer', customerSchema);

// ---- Documents du client (pièces jointes : RC, carte d'identification fiscale, contrat…) ----
export const CUSTOMER_DOC_TYPES = ['registry_extract', 'tax_card', 'contract', 'other'] as const;
const customerDocumentSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  type: { type: String, enum: CUSTOMER_DOC_TYPES, required: true },
  description: { type: String, trim: true },
  originalName: { type: String, required: true },
  /** Contenu stocké dans MongoDB (GridFS, bucket « customerFiles ») : persistant et compatible avec un hébergement sans disque durable. */
  fileId: { type: Schema.Types.ObjectId, required: true }, mime: { type: String }, size: { type: Number, default: 0 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' }, uploadedByName: { type: String },
}, { timestamps: true });
customerDocumentSchema.index({ companyId: 1, customerId: 1, createdAt: -1 });
export type CustomerDocumentDoc = InferSchemaType<typeof customerDocumentSchema>;
export const CustomerDocument = model('CustomerDocument', customerDocumentSchema);

// ---- Activités : manuelles (appel, e-mail, réunion…) ou automatiques (création, changement de statut…) ----
export const ACTIVITY_KINDS = ['call', 'email', 'meeting', 'note', 'follow_up', 'other'] as const;
export const AUTO_ACTIVITY_KINDS = ['customer_created', 'customer_updated', 'status_changed', 'document_added', 'document_removed'] as const;
const customerActivitySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  /** Activité manuelle (modifiable) ou événement automatique (jamais modifiable ni supprimable à la main). */
  auto: { type: Boolean, default: false },
  kind: { type: String, enum: [...ACTIVITY_KINDS, ...AUTO_ACTIVITY_KINDS], required: true },
  title: { type: String, required: true, trim: true }, description: { type: String, trim: true },
  occurredAt: { type: Date, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' }, userName: { type: String },
  meta: { type: Schema.Types.Mixed },
}, { timestamps: true });
customerActivitySchema.index({ companyId: 1, customerId: 1, occurredAt: -1 });
export type CustomerActivityDoc = InferSchemaType<typeof customerActivitySchema>;
export const CustomerActivity = model('CustomerActivity', customerActivitySchema);

/**
 * Registre d'unicité des e-mails et téléphones (valeurs normalisées) d'une société : clients et contacts confondus.
 * L'index unique garantit un seul enregistrement par valeur, même sous concurrence. Plusieurs propriétaires ne subsistent que
 * pour des doublons ANTÉRIEURS à la règle (à résoudre manuellement).
 */
const contactKeySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  kind: { type: String, enum: ['email', 'phone'], required: true }, value: { type: String, required: true },
  owners: { type: [new Schema({ customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true }, source: { type: String, enum: ['customer', 'contact'], required: true } }, { _id: false })], default: [] },
}, { versionKey: false });
contactKeySchema.index({ companyId: 1, kind: 1, value: 1 }, { unique: true });
contactKeySchema.index({ companyId: 1, 'owners.customerId': 1 });
export const ContactKey = model('ContactKey', contactKeySchema);
