import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Paramètres par société. Les règles fiscales (TVA, retenue, timbre) sont dans FiscalRule (historisées, avec date d'effet).
 */
const currencySchema = new Schema(
  { code: { type: String, required: true, uppercase: true, trim: true }, name: String, symbol: String,
    decimals: { type: Number, required: true, min: 0, max: 6 } },
  { _id: false },
);
const numberingSchema = new Schema(
  { docType: { type: String, required: true }, prefix: { type: String, default: '' },
    padding: { type: Number, default: 5, min: 1, max: 12 },
    includeYear: { type: Boolean, default: true }, resetYearly: { type: Boolean, default: true } },
  { _id: false },
);

const settingSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    baseCurrency: { type: String, uppercase: true, default: 'TND' },
    currencies: { type: [currencySchema], default: [{ code: 'TND', name: 'Dinar tunisien', symbol: 'DT', decimals: 3 }] },
    numbering: { type: [numberingSchema], default: [] },
    supplierBlockThresholdMinor: { type: Number },
  },
  { timestamps: true },
);
export type SettingDoc = InferSchemaType<typeof settingSchema>;
export const Setting = model('Setting', settingSchema);
