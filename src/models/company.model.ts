import { Schema, model, type InferSchemaType } from 'mongoose';

const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    taxId: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
companySchema.index({ name: 1 });
export type CompanyDoc = InferSchemaType<typeof companySchema>;
export const Company = model('Company', companySchema);
