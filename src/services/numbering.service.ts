import type { ClientSession, Types } from 'mongoose';
import { Counter } from '../models/counter.model.js';
import { Setting } from '../models/setting.model.js';
import { AppError } from '../utils/errors.js';

/** Séries par défaut (modifiables dans les paramètres) : DEV-2026-000001, PRO-…, FAC-…, AV-…, BL-… */
export const DEFAULT_SERIES: Record<string, { prefix: string; padding: number; includeYear: boolean; resetYearly: boolean }> = {
  quotation: { prefix: 'DEV-', padding: 6, includeYear: true, resetYearly: true },
  proforma: { prefix: 'PRO-', padding: 6, includeYear: true, resetYearly: true },
  invoice: { prefix: 'FAC-', padding: 6, includeYear: true, resetYearly: true },
  creditNote: { prefix: 'AV-', padding: 6, includeYear: true, resetYearly: true },
  deliveryNote: { prefix: 'BL-', padding: 6, includeYear: true, resetYearly: true },
  purchaseOrder: { prefix: 'BC-', padding: 6, includeYear: true, resetYearly: true },
  goodsReceipt: { prefix: 'REC-', padding: 6, includeYear: true, resetYearly: true },
  purchaseInvoice: { prefix: 'FA-', padding: 6, includeYear: true, resetYearly: true },
  stockTransfer: { prefix: 'TR-', padding: 6, includeYear: true, resetYearly: true },
  inventory: { prefix: 'INV-', padding: 6, includeYear: true, resetYearly: true },
  importFile: { prefix: 'IMP-', padding: 6, includeYear: true, resetYearly: true },
  supplierPayment: { prefix: 'REG-', padding: 6, includeYear: true, resetYearly: true },
  expense: { prefix: 'DEP-', padding: 6, includeYear: true, resetYearly: true },
  treasuryTransfer: { prefix: 'VIR-', padding: 6, includeYear: true, resetYearly: true },
  reconciliation: { prefix: 'RAP-', padding: 6, includeYear: true, resetYearly: true },
  // Journaux comptables : numérotation continue par journal (sans remise à zéro)
  journal_sales: { prefix: 'VTE-', padding: 6, includeYear: false, resetYearly: false },
  journal_purchases: { prefix: 'ACH-', padding: 6, includeYear: false, resetYearly: false },
  journal_cash: { prefix: 'CAI-', padding: 6, includeYear: false, resetYearly: false },
  journal_bank: { prefix: 'BQ-', padding: 6, includeYear: false, resetYearly: false },
};

async function counterKey(companyId: Types.ObjectId, docType: string, date: Date) {
  const settings = await Setting.findOne({ companyId }).lean();
  const fmt = settings?.numbering.find((n) => n.docType === docType) ?? DEFAULT_SERIES[docType];
  if (!fmt) throw AppError.badRequest(`Format de numérotation non configuré pour « ${docType} »`);
  return { fmt, key: fmt.resetYearly ? `${docType}:${date.getUTCFullYear()}` : docType };
}

/**
 * À appeler AVANT d'ouvrir la transaction qui consommera le numéro : crée le compteur s'il n'existe pas.
 * (Un compteur créé pendant une transaction concurrente serait invisible de son instantané et provoquerait des conflits de clé.)
 */
export async function ensureCounter(companyId: Types.ObjectId, docType: string, date = new Date()) {
  const { key } = await counterKey(companyId, docType, date);
  await Counter.updateOne({ companyId, key }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((e) => { if (e?.code !== 11000) throw e; });
}

/**
 * Numérotation séquentielle côté serveur : un compteur par société + type de document (+ année si remise à zéro annuelle).
 * Incrément atomique ($inc) : pas de doublon sous concurrence. À appeler DANS la transaction qui crée/valide le document :
 * si elle échoue, l'incrément est annulé avec elle (pas de trou de numérotation).
 * Format : paramètres de la société, sinon séries par défaut.
 */
export async function nextDocumentNumber(
  companyId: Types.ObjectId, docType: string, session?: ClientSession, date = new Date(),
): Promise<string> {
  const { fmt, key } = await counterKey(companyId, docType, date);
  if (!session) await ensureCounter(companyId, docType, date);
  const c = await Counter.findOneAndUpdate({ companyId, key }, { $inc: { seq: 1 } }, { returnDocument: 'after', session, upsert: true });
  const year = date.getUTCFullYear();
  const num = String(c!.seq).padStart(fmt.padding ?? 6, '0');
  return `${fmt.prefix ?? ''}${fmt.includeYear ? `${year}-` : ''}${num}`;
}
