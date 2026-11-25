import { Schema, model, type InferSchemaType } from 'mongoose';

const categorySchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    /** null = famille ; renseigné = sous-famille (2 niveaux maximum). */
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  },
  { timestamps: true },
);
categorySchema.index({ companyId: 1, parentId: 1, name: 1 }, { unique: true });
export const Category = model('Category', categorySchema);

const unitSchema = new Schema(
  { companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true }, code: { type: String, required: true, trim: true }, name: { type: String, required: true, trim: true } },
  { timestamps: true },
);
unitSchema.index({ companyId: 1, code: 1 }, { unique: true });
export const Unit = model('Unit', unitSchema);

export const PRODUCT_STATUSES = ['active', 'inactive', 'archived', 'blocked'] as const;
export const PACKAGING_TYPES = ['carton', 'wooden_crate', 'pallet', 'plastic_film', 'other'] as const;

/** Dimensions et poids logistiques (réutilisables par le module Importations). Volumes toujours recalculés par le serveur. */
const packagingSchema = new Schema({
  lengthMm: { type: Number, min: 0 }, widthMm: { type: Number, min: 0 }, heightMm: { type: Number, min: 0 },
  netWeightKg: { type: Number, min: 0 }, grossWeightKg: { type: Number, min: 0 },
  type: { type: String, enum: PACKAGING_TYPES }, typeLabel: { type: String, trim: true },
  parcelCount: { type: Number, min: 1 },
  /** true : les dimensions sont celles d'UN colis (volume total = volume × nombre de colis) ; false : dimensions de l'ensemble de l'emballage. */
  dimensionsPerParcel: { type: Boolean, default: true },
  volumeM3: { type: Number, min: 0 }, totalVolumeM3: { type: Number, min: 0 },
}, { _id: false });

/** Informations douanières propres à l'article (valeurs saisies : aucun taux ni code n'est présumé). La TVA n'y figure pas : source unique `vatRateCode`. */
const customsSchema = new Schema({
  supplierHsCode: { type: String, trim: true }, tnHsCode: { type: String, trim: true },
  ddPct: { type: Number, min: 0, max: 1000 }, fodecPct: { type: Number, min: 0, max: 1000 }, rpdPct: { type: Number, min: 0, max: 1000 },
  originCountry: { type: String, trim: true }, provenanceCountry: { type: String, trim: true }, specialRegulation: { type: String, trim: true },
}, { _id: false });

const productSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    reference: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    brand: { type: String, trim: true }, model: { type: String, trim: true },
    /** Statut métier. `isActive` (= statut actif) est conservé synchronisé pour les modules existants. */
    status: { type: String, enum: PRODUCT_STATUSES, default: 'active' },
    statusReason: { type: String, trim: true }, statusChangedAt: { type: Date },
    packaging: { type: packagingSchema },
    customs: { type: customsSchema },
    /** Prix d'achat en devise étrangère (plus petite unité de CETTE devise) ; `purchasePriceMinor` reste la contre-valeur en devise de base (source des modules existants). */
    purchaseCurrency: { type: String, trim: true, uppercase: true }, purchasePriceForeignMinor: { type: Number, min: 0 },
    purchaseRate: { type: Number, min: 0 }, purchaseRateDate: { type: Date },
    estimatedCostMinor: { type: Number, min: 0 }, minSalePriceMinor: { type: Number, min: 0 }, maxDiscountPct: { type: Number, min: 0, max: 100 },
    mainPhotoId: { type: Schema.Types.ObjectId },
    description: { type: String, trim: true },
    kind: { type: String, enum: ['product', 'service'], default: 'product' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    purchasePriceMinor: { type: Number, default: 0, min: 0 },
    salePriceMinor: { type: Number, default: 0, min: 0 },
    /** Coût de revient : alimenté par le module 11 ; à défaut le prix d'achat sert de coût. */
    costPriceMinor: { type: Number, min: 0 },
    vatRateCode: { type: String, required: true, trim: true },
    minStock: { type: Number, default: 0, min: 0 },
    mainSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    hasSerial: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
// Référence unique par société, insensible à la casse
productSchema.index({ companyId: 1, reference: 1 }, { unique: true, collation: { locale: 'fr', strength: 2 } });
productSchema.index({ companyId: 1, name: 1 });
productSchema.index({ companyId: 1, status: 1, reference: 1 });
productSchema.index({ companyId: 1, brand: 1 });
productSchema.index({ companyId: 1, categoryId: 1 });
productSchema.index({ companyId: 1, mainSupplierId: 1 });
export type ProductDoc = InferSchemaType<typeof productSchema>;
export const Product = model('Product', productSchema);

const serialSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    serialNumber: { type: String, required: true, trim: true },
    status: { type: String, enum: ['available', 'sold', 'returned', 'scrapped'], default: 'available' },
    note: { type: String, trim: true },
    /** Magasin où se trouve le numéro de série (null tant qu'il n'est pas en stock) et document de sortie. */
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    soldOn: { type: new Schema({ type: String, id: Schema.Types.ObjectId, number: String }, { _id: false }) },
  },
  { timestamps: true },
);
serialSchema.index({ companyId: 1, productId: 1, serialNumber: 1 }, { unique: true });
export const ProductSerial = model('ProductSerial', serialSchema);

// ---- Réglages de stock par magasin (emplacement, seuils) : les QUANTITÉS restent dans StockLevel (seule source de vérité) ----
const stockSettingSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true }, productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true }, warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  location: { type: String, trim: true }, minQty: { type: Number, min: 0 }, maxQty: { type: Number, min: 0 },
}, { timestamps: true });
stockSettingSchema.index({ companyId: 1, productId: 1, warehouseId: 1 }, { unique: true });
export const ProductStockSetting = model('ProductStockSetting', stockSettingSchema);

// ---- Documents de l'article (photos, fiches techniques, certificats…) : fichiers dans MongoDB (GridFS « productFiles ») ----
export const PRODUCT_DOC_TYPES = ['photo', 'supplier_invoice', 'datasheet', 'manual', 'ce_certificate', 'origin_certificate', 'conformity', 'customs', 'warranty', 'other'] as const;
const productDocumentSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true }, productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  type: { type: String, enum: PRODUCT_DOC_TYPES, required: true }, description: { type: String, trim: true },
  originalName: { type: String, required: true }, fileId: { type: Schema.Types.ObjectId, required: true }, mime: { type: String }, size: { type: Number, default: 0 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' }, uploadedByName: { type: String },
}, { timestamps: true });
productDocumentSchema.index({ companyId: 1, productId: 1, createdAt: -1 });
export type ProductDocumentDoc = InferSchemaType<typeof productDocumentSchema>;
export const ProductDocument = model('ProductDocument', productDocumentSchema);

// ---- Activités : manuelles (appel, réunion, tâche, rappel, note) ou automatiques (événements réels ; jamais modifiables à la main) ----
export const PRODUCT_ACTIVITY_KINDS = ['call', 'meeting', 'task', 'reminder', 'note'] as const;
export const PRODUCT_AUTO_KINDS = ['product_created', 'product_updated', 'purchase_price_changed', 'sale_price_changed', 'technical_changed', 'status_changed', 'document_added', 'document_removed', 'stock_setting_changed'] as const;
const productActivitySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true }, productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  auto: { type: Boolean, default: false }, kind: { type: String, enum: [...PRODUCT_ACTIVITY_KINDS, ...PRODUCT_AUTO_KINDS], required: true },
  title: { type: String, required: true, trim: true }, description: { type: String, trim: true }, occurredAt: { type: Date, required: true },
  /** Tâches et rappels : échéance et état de réalisation. */
  dueDate: { type: Date }, done: { type: Boolean }, doneAt: { type: Date },
  userId: { type: Schema.Types.ObjectId, ref: 'User' }, userName: { type: String }, meta: { type: Schema.Types.Mixed },
}, { timestamps: true });
productActivitySchema.index({ companyId: 1, productId: 1, occurredAt: -1 });
export type ProductActivityDoc = InferSchemaType<typeof productActivitySchema>;
export const ProductActivity = model('ProductActivity', productActivitySchema);
