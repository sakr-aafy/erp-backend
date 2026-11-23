import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    username: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    isActive: { type: Boolean, default: true },
    /** Administrateur de plateforme : peut gérer les sociétés (multi-tenant). */
    isPlatformAdmin: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date },
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
  },
  { timestamps: true },
);
userSchema.index({ companyId: 1, username: 1 }, { unique: true });
userSchema.index({ companyId: 1, name: 'text', email: 'text' });
export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
