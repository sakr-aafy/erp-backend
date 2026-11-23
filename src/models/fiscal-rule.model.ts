import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Règle fiscale HISTORISÉE (TVA, retenue à la source, timbre). Aucune valeur n'est codée en dur ni activée automatiquement :
 *  - une règle naît en « brouillon » ; seule une règle VALIDÉE (par un utilisateur habilité) est appliquée ;
 *  - une règle validée est immuable ; une modification = nouvelle version (même code) avec une date d'effet postérieure ;
 *  - à une date donnée, la règle applicable est la version validée la plus récente dont la date d'effet est ≤ date ;
 *  - `active: false` sur une version = retrait de la règle à partir de sa date d'effet.
 */
const fiscalRuleSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    kind: { type: String, enum: ['vat', 'withholding', 'stamp'], required: true },
    /** TVA : code du taux (ex. « T19 ») ; retenue : code du type d'opération ; timbre : code de la règle. */
    code: { type: String, required: true, trim: true, uppercase: true },
    label: { type: String, trim: true },
    effectiveFrom: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'validated'], default: 'draft' },
    active: { type: Boolean, default: true },
    legalReference: { type: String, trim: true },
    vat: { type: new Schema({ regime: { type: String, enum: ['taxable', 'zero', 'exempt', 'suspended'], required: true }, ratePct: { type: Number, min: 0, max: 100, default: 0 } }, { _id: false }) },
    withholding: {
      type: new Schema({
        ratePct: { type: Number, min: 0, max: 100, required: true }, base: { type: String, enum: ['ht', 'ttc'], required: true },
        minTotalMinor: { type: Number, min: 0 },              // condition : total TTC minimal
        requireCustomerFlag: { type: Boolean, default: true }, // condition : client assujetti à la retenue
      }, { _id: false }),
    },
    stamp: {
      type: new Schema({
        amountMinor: { type: Number, min: 0, required: true }, docTypes: { type: [String], default: [] },
        minTotalMinor: { type: Number, min: 0 },              // condition : total TTC minimal
        exemptCustomerFlag: { type: Boolean, default: true },  // exonération : clients marqués « exonérés de timbre »
      }, { _id: false }),
    },
    validatedAt: { type: Date },
    validatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
fiscalRuleSchema.index({ companyId: 1, kind: 1, code: 1, effectiveFrom: 1 }, { unique: true });
fiscalRuleSchema.index({ companyId: 1, kind: 1, status: 1, effectiveFrom: -1 });
export type FiscalRuleDoc = InferSchemaType<typeof fiscalRuleSchema>;
export const FiscalRule = model('FiscalRule', fiscalRuleSchema);
