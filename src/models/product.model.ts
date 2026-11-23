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

const productSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    reference: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
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
