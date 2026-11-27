import { Schema, model, type InferSchemaType } from 'mongoose';
import { addressSchema, contactSchema } from '../modules/parties/party.shared.js';
import { deliveryAddressSchema } from '../modules/parties/delivery-address.js';
import { PAYMENT_METHODS } from './sales.model.js';

export const SUPPLIER_STATUSES = ['active', 'inactive', 'archived', 'blocked'] as const;

const supplierSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Code fournisseur lisible (FR-00001), attribué par un compteur atomique ; unique par société. Un code existant n'est jamais remplacé. */
    code: { type: String, trim: true },
    /** Catégorie principale (administrable) ; absente = « Non classé ». */
    categoryId: { type: Schema.Types.ObjectId, ref: 'SupplierCategory' },
    name: { type: String, required: true, trim: true },
    tradeName: { type: String, trim: true },
    taxId: { type: String, trim: true },
    address: { type: addressSchema, default: () => ({}) },
    /** Adresses de livraison / d'enlèvement du fournisseur (une seule par défaut). */
    deliveryAddresses: { type: [deliveryAddressSchema], default: [] },
    phone: { type: String, trim: true },
    secondaryPhone: { type: String, trim: true },
    /** Saisies d'origine des téléphones reformatés par la migration (réversibilité). */
    phoneOriginals: { type: Schema.Types.Mixed },
    email: { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    social: { type: new Schema({ facebook: { type: String, trim: true }, linkedin: { type: String, trim: true }, instagram: { type: String, trim: true } }, { _id: false }) },
    mapsUrl: { type: String, trim: true },
    contacts: { type: [contactSchema], default: [] },
    leadTimeDays: { type: Number, min: 0 },
    paymentTerms: { type: String, trim: true },
    /** Conditions rédigées librement : aucune échéance n'en est déduite automatiquement. */
    paymentTermsCustom: { type: Boolean, default: false },
    paymentDelayDays: { type: Number, default: 0, min: 0 },
    /** Mode de règlement habituel, proposé à la saisie d'un règlement. */
    paymentMethod: { type: String, enum: PAYMENT_METHODS },
    /** Remise habituelle (%), proposée sur les lignes d'une nouvelle commande. */
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    /** Solde dû au fournisseur : lecture seule ici ; mis à jour par les factures d'achat validées et les règlements. */
    balanceMinor: { type: Number, default: 0 },
    /** Seuil de blocage des commandes propre au fournisseur ; à défaut, seuil de la société (paramètres). */
    blockThresholdMinor: { type: Number, min: 0 },
    isForeign: { type: Boolean, default: false },
    currency: { type: String, uppercase: true, trim: true },
    /** Statut métier. `isArchived` est conservé synchronisé (compatibilité des modules existants). */
    status: { type: String, enum: SUPPLIER_STATUSES, default: 'active' },
    statusReason: { type: String, trim: true },
    statusChangedAt: { type: Date },
    notes: { type: String, trim: true },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);
supplierSchema.index({ companyId: 1, taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } });
supplierSchema.index({ companyId: 1, name: 1 });
supplierSchema.index({ companyId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
supplierSchema.index({ companyId: 1, status: 1, name: 1 });
supplierSchema.index({ companyId: 1, categoryId: 1 });
supplierSchema.index({ companyId: 1, isArchived: 1, balanceMinor: -1 });
export type SupplierDoc = InferSchemaType<typeof supplierSchema>;
export const Supplier = model('Supplier', supplierSchema);

// ---- Catégories de fournisseurs (données administrables, sans hiérarchie) ----
const supplierCategorySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
// Nom unique par société, casse ignorée
supplierCategorySchema.index({ companyId: 1, name: 1 }, { unique: true, collation: { locale: 'fr', strength: 2 } });
export type SupplierCategoryDoc = InferSchemaType<typeof supplierCategorySchema>;
export const SupplierCategory = model('SupplierCategory', supplierCategorySchema);

// ---- Documents du fournisseur (fichiers dans MongoDB, bucket GridFS « supplierFiles ») ----
export const SUPPLIER_DOC_TYPES = ['administrative', 'tax_card', 'contract', 'catalog', 'price_list', 'conformity_certificate', 'origin_certificate', 'insurance', 'transport', 'customs', 'other'] as const;
const supplierDocumentSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
  type: { type: String, enum: SUPPLIER_DOC_TYPES, required: true },
  description: { type: String, trim: true },
  originalName: { type: String, required: true },
  fileId: { type: Schema.Types.ObjectId, required: true }, mime: { type: String }, size: { type: Number, default: 0 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' }, uploadedByName: { type: String },
}, { timestamps: true });
supplierDocumentSchema.index({ companyId: 1, supplierId: 1, createdAt: -1 });
export type SupplierDocumentDoc = InferSchemaType<typeof supplierDocumentSchema>;
export const SupplierDocument = model('SupplierDocument', supplierDocumentSchema);

// ---- Activités : manuelles ou automatiques (les événements d'achat sont lus dans les documents, jamais copiés) ----
export const SUPPLIER_ACTIVITY_KINDS = ['call', 'email', 'meeting', 'note', 'task', 'reminder', 'follow_up'] as const;
export const SUPPLIER_AUTO_KINDS = ['supplier_created', 'supplier_updated', 'category_changed', 'status_changed', 'document_added', 'document_removed'] as const;
const supplierActivitySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
  auto: { type: Boolean, default: false },
  kind: { type: String, enum: [...SUPPLIER_ACTIVITY_KINDS, ...SUPPLIER_AUTO_KINDS], required: true },
  title: { type: String, required: true, trim: true }, description: { type: String, trim: true },
  occurredAt: { type: Date, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' }, userName: { type: String },
  meta: { type: Schema.Types.Mixed },
}, { timestamps: true });
supplierActivitySchema.index({ companyId: 1, supplierId: 1, occurredAt: -1 });
export type SupplierActivityDoc = InferSchemaType<typeof supplierActivitySchema>;
export const SupplierActivity = model('SupplierActivity', supplierActivitySchema);
