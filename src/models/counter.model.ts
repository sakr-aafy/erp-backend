import { Schema, model } from 'mongoose';

/** Compteurs séquentiels atomiques (numérotation des documents), par société + type + période. */
const counterSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ companyId: 1, key: 1 }, { unique: true });
export const Counter = model('Counter', counterSchema);
