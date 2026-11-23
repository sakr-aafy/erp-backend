import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLog } from '../models/audit-log.model.js';
import { logger } from '../config/logger.js';

interface AuditEntry {
  action: string;
  resource: string;
  resourceId?: string | Types.ObjectId;
  success?: boolean;
  companyId?: Types.ObjectId;
  userId?: Types.ObjectId;
  userName?: string;
  meta?: Record<string, unknown>;
}

/** Journalise une opération sensible (BD + log structuré). Ne doit jamais faire échouer la requête. */
export async function audit(req: Request | undefined, entry: AuditEntry): Promise<void> {
  try {
    const a = req?.auth;
    const doc = {
      ...entry,
      resourceId: entry.resourceId?.toString(),
      companyId: entry.companyId ?? a?.companyId,
      userId: entry.userId ?? a?.userId,
      userName: entry.userName ?? a?.name,
      ip: req?.ip,
      userAgent: req?.get('user-agent'),
    };
    await AuditLog.create(doc);
    logger.info({ audit: { ...doc, userId: doc.userId?.toString(), companyId: doc.companyId?.toString() } }, 'audit');
  } catch (err) {
    logger.error({ err }, 'échec journalisation audit');
  }
}
