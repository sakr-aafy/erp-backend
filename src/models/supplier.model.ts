import { Schema, model, type InferSchemaType } from 'mongoose';
import { addressSchema, contactSchema } from '../modules/parties/party.shared.js';

const supplierSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    taxId: { type: String, trim: true },
    address: { type: addressSchema, default: () => ({}) },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    contacts: { type: [contactSchema], default: [] },
    leadTimeDays: { type: Number, min: 0 },
    paymentTerms: { type: String, trim: true },
    paymentDelayDays: { type: Number, default: 0, min: 0 },
    /** Solde dû au fournisseur : lecture seule ici ; mis à jour par achats / règlements (phase 5-6). */
    balanceMinor: { type: Number, default: 0 },
    /** Seuil de blocage des commandes propre au fournisseur ; à défaut, seuil de la société (paramètres). */
    blockThresholdMinor: { type: Number, min: 0 },
    isForeign: { type: Boolean, default: false },
    currency: { type: String, uppercase: true, trim: true },
    notes: { type: String, trim: true },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);
supplierSchema.index({ companyId: 1, taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } });
supplierSchema.index({ companyId: 1, name: 1 });
supplierSchema.index({ companyId: 1, isArchived: 1, balanceMinor: -1 });
export type SupplierDoc = InferSchemaType<typeof supplierSchema>;
export const Supplier = model('Supplier', supplierSchema);
