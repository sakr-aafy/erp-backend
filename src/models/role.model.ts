import { Schema, model, type InferSchemaType } from 'mongoose';

const roleSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    permissions: { type: [String], default: [] },
    /** Rôle système (ex. Administrateur) : non supprimable, permissions non modifiables. */
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);
roleSchema.index({ companyId: 1, name: 1 }, { unique: true });
export type RoleDoc = InferSchemaType<typeof roleSchema>;
export const Role = model('Role', roleSchema);
