import type { ClientSession, Types } from 'mongoose';
import { FiscalRule, type FiscalRuleDoc } from '../models/fiscal-rule.model.js';
import { AppError } from '../utils/errors.js';
import type { VatRegime } from './calculation.service.js';

type Id = Types.ObjectId;
type Rule = FiscalRuleDoc & { _id: Id };

export const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export interface VatSnapshot { ruleId: Id; code: string; regime: VatRegime; ratePct: number }

/** Dernière version VALIDÉE de chaque code, applicable à `date` (les versions retirées sont exclues). */
async function latestPerCode(companyId: Id, kind: FiscalRuleDoc['kind'], date: Date, session?: ClientSession, code?: string): Promise<Rule[]> {
  const rules = await FiscalRule.aggregate<Rule>([
    { $match: { companyId, kind, status: 'validated', effectiveFrom: { $lte: date }, ...(code && { code }) } },
    { $sort: { effectiveFrom: -1 } },
    { $group: { _id: '$code', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { code: 1 } },
  ]).session(session ?? null);
  return rules.filter((r) => r.active);
}

/** Catalogue TVA applicable à une date (formulaires, lignes de documents). */
export async function vatCatalog(companyId: Id, date = new Date()) {
  return (await latestPerCode(companyId, 'vat', startOfDay(date))).map((r) => ({
    ruleId: r._id.toString(), code: r.code, label: r.label ?? null, regime: r.vat!.regime, ratePct: r.vat!.regime === 'taxable' ? r.vat!.ratePct : 0,
  }));
}

/** Résout un code de TVA à une date. Jamais de taux par défaut : un code sans règle validée est refusé. */
export async function resolveVat(companyId: Id, code: string, date: Date, session?: ClientSession): Promise<VatSnapshot> {
  const [r] = await latestPerCode(companyId, 'vat', startOfDay(date), session, code.trim().toUpperCase());
  if (!r) throw AppError.badRequest(`Taux de TVA « ${code} » : aucune règle validée applicable au ${startOfDay(date).toISOString().slice(0, 10)}`);
  return { ruleId: r._id, code: r.code, regime: r.vat!.regime, ratePct: r.vat!.regime === 'taxable' ? r.vat!.ratePct : 0 };
}
/** Un code de TVA existe-t-il (au moins une version validée, à n'importe quelle date) ? Sert à valider un article. */
export const vatCodeExists = async (companyId: Id, code: string) => !!(await FiscalRule.exists({ companyId, kind: 'vat', status: 'validated', code: code.trim().toUpperCase() }));

export interface PartyFlags { subjectToWithholding?: boolean | null | undefined; stampExempt?: boolean | null | undefined }

/**
 * Retenue à la source : applicable seulement si l'opération est indiquée ET qu'une règle validée existe à la date
 * ET que ses conditions sont remplies. Sinon aucune retenue (jamais activée par défaut).
 */
export async function resolveWithholding(companyId: Id, p: { operationType?: string | null | undefined; date: Date; totalTtcMinor: number; customer: PartyFlags }, session?: ClientSession) {
  if (!p.operationType) return null;
  const [r] = await latestPerCode(companyId, 'withholding', startOfDay(p.date), session, p.operationType.trim().toUpperCase());
  if (!r?.withholding) return null;
  const w = r.withholding;
  if (w.requireCustomerFlag !== false && !p.customer.subjectToWithholding) return null;
  if (w.minTotalMinor != null && p.totalTtcMinor < w.minTotalMinor) return null;
  return { ruleId: r._id, code: r.code, ratePct: w.ratePct, base: w.base as 'ht' | 'ttc' };
}

/** Timbre fiscal : règle validée concernant ce type de document, conditions remplies, client non exonéré. */
export async function resolveStamp(companyId: Id, p: { docType: string; date: Date; totalTtcMinor: number; customer: PartyFlags }, session?: ClientSession) {
  const rules = (await latestPerCode(companyId, 'stamp', startOfDay(p.date), session)).filter((r) => r.stamp!.docTypes.includes(p.docType));
  if (rules.length > 1) throw AppError.conflict(`Configuration fiscale ambiguë : plusieurs règles de timbre s’appliquent aux documents « ${p.docType} » (${rules.map((r) => r.code).join(', ')})`);
  const r = rules[0]; if (!r) return null;
  const s = r.stamp!;
  if (s.exemptCustomerFlag !== false && p.customer.stampExempt) return null;
  if (s.minTotalMinor != null && p.totalTtcMinor < s.minTotalMinor) return null;
  return { ruleId: r._id, code: r.code, amountMinor: s.amountMinor };
}
