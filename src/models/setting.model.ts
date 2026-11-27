import { Schema, model, type InferSchemaType } from 'mongoose';
import { DEFAULT_ESTIMATE_RATES } from '../modules/products/estimate-rate.js';

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

/** Taux de change ESTIMATIF (fiche article uniquement) : distinct des taux réels de la collection ExchangeRate. */
const estimateRateSchema = new Schema(
  { currency: { type: String, required: true, uppercase: true }, targetCurrency: { type: String, required: true, uppercase: true }, rate: { type: Number, required: true, min: 0 },
    updatedAt: { type: Date }, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' } },
  { _id: false },
);

const settingSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    baseCurrency: { type: String, uppercase: true, default: 'TND' },
    currencies: { type: [currencySchema], default: [{ code: 'TND', name: 'Dinar tunisien', symbol: 'DT', decimals: 3 }] },
    numbering: { type: [numberingSchema], default: [] },
    supplierBlockThresholdMinor: { type: Number },
    /** Catégories de fournisseurs proposées par défaut déjà créées : elles ne sont plus recréées ensuite (suppression respectée). */
    supplierCategoriesInitialisedAt: { type: Date },
    /** Conditions de paiement proposées déjà créées (une condition supprimée ensuite n’est pas recréée). */
    paymentTermsInitialisedAt: { type: Date },
    /** Registre d’unicité des téléphones et e-mails clients / contacts déjà constitué. */
    contactKeysInitialisedAt: { type: Date },
    estimateRates: { type: [estimateRateSchema], default: () => DEFAULT_ESTIMATE_RATES.map((r) => ({ ...r })) },
  },
  { timestamps: true },
);
export type SettingDoc = InferSchemaType<typeof settingSchema>;
export const Setting = model('Setting', settingSchema);
