import { Schema, model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String },
    action: { type: String, required: true },
    resource: { type: String, required: true },
    resourceId: { type: String },
    success: { type: Boolean, default: true },
    ip: { type: String },
    userAgent: { type: String },
    meta: { type: Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
);
auditLogSchema.index({ companyId: 1, at: -1 });
auditLogSchema.index({ companyId: 1, resource: 1, resourceId: 1 });
auditLogSchema.index({ companyId: 1, userId: 1, at: -1 });
auditLogSchema.index({ companyId: 1, 'meta.refs': 1, at: -1 }); // chronologie du cycle commercial
export const AuditLog = model('AuditLog', auditLogSchema);
