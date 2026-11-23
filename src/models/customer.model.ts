import { Schema, model, type InferSchemaType } from 'mongoose';
import { addressSchema, contactSchema } from '../modules/parties/party.shared.js';

const customerSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    taxId: { type: String, trim: true },
    address: { type: addressSchema, default: () => ({}) },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    contacts: { type: [contactSchema], default: [] },
    paymentTerms: { type: String, trim: true },
    paymentDelayDays: { type: Number, default: 0, min: 0 },
    /** null/absent = crédit illimité. Montant entier en plus petite unité de la devise de base. */
    creditLimitMinor: { type: Number, min: 0 },
    /** Solde courant : lecture seule ici ; mis à jour par factures / règlements (phase 4). */
    balanceMinor: { type: Number, default: 0 },
    /** Conditions fiscales : client assujetti à la retenue à la source / exonéré de timbre (utilisés par les règles fiscales validées). */
    subjectToWithholding: { type: Boolean, default: false },
    stampExempt: { type: Boolean, default: false },
    notes: { type: String, trim: true },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);
// Matricule fiscal unique par société, uniquement s'il est renseigné
customerSchema.index({ companyId: 1, taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } });
customerSchema.index({ companyId: 1, name: 1 });
customerSchema.index({ companyId: 1, isArchived: 1, balanceMinor: -1 });
export type CustomerDoc = InferSchemaType<typeof customerSchema>;
export const Customer = model('Customer', customerSchema);
