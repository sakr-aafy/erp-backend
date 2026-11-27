import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Conditions de paiement proposées aux fiches et aux documents. `delayDays` est l'élément FINANCIER (échéance calculée) ;
 * sans délai, la condition est une description commerciale et l'échéancier réel se saisit sur chaque facture.
 * Les documents gardent leur propre copie du texte : modifier ou désactiver une condition ne les change jamais.
 */
const paymentTermSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  label: { type: String, required: true, trim: true },
  delayDays: { type: Number, min: 0, max: 365, default: null },
  isActive: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true });
paymentTermSchema.index({ companyId: 1, label: 1 }, { unique: true, collation: { locale: 'fr', strength: 2 } });
paymentTermSchema.index({ companyId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });
export type PaymentTermDoc = InferSchemaType<typeof paymentTermSchema>;
export const PaymentTerm = model('PaymentTerm', paymentTermSchema);
