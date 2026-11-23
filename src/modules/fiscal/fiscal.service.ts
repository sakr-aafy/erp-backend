import type { Types } from 'mongoose';
import { FiscalRule, type FiscalRuleDoc } from '../../models/fiscal-rule.model.js';
import { AppError } from '../../utils/errors.js';
import { startOfDay } from '../../services/fiscal.service.js';

type Id = Types.ObjectId;
type Lean = FiscalRuleDoc & { _id: Id };

export const toDto = (r: Lean, currentId?: string) => ({
  id: r._id.toString(), kind: r.kind, code: r.code, label: r.label ?? null, effectiveFrom: r.effectiveFrom, status: r.status, active: r.active,
  legalReference: r.legalReference ?? null, vat: r.vat ?? null, withholding: r.withholding ?? null, stamp: r.stamp ?? null,
  validatedAt: r.validatedAt ?? null, isCurrent: r._id.toString() === currentId,
});

/** Toutes les versions (historique complet), avec repérage de la version en vigueur aujourd'hui. */
export async function list(companyId: Id, f: { kind?: string | undefined; code?: string | undefined; status?: string | undefined }) {
  const filter: Record<string, unknown> = { companyId };
  if (f.kind) filter.kind = f.kind; if (f.code) filter.code = f.code.toUpperCase(); if (f.status) filter.status = f.status;
  const rules = (await FiscalRule.find(filter).sort({ kind: 1, code: 1, effectiveFrom: -1 }).lean()) as Lean[];
  const today = startOfDay(new Date()); const current = new Set<string>(); const seen = new Set<string>();
  for (const r of rules) { // trié par date décroissante dans chaque code : 1re version validée ≤ aujourd'hui = en vigueur
    const k = `${r.kind}:${r.code}`;
    if (!seen.has(k) && r.status === 'validated' && r.effectiveFrom <= today) { seen.add(k); if (r.active) current.add(r._id.toString()); }
  }
  return rules.map((r) => toDto(r, current.has(r._id.toString()) ? r._id.toString() : undefined));
}

type Body = Record<string, unknown> & { kind: 'vat' | 'withholding' | 'stamp'; code: string; effectiveFrom: Date };
function normalize(b: Body) {
  const out: Record<string, unknown> = { ...b, code: b.code.toUpperCase(), effectiveFrom: startOfDay(b.effectiveFrom) };
  if (b.kind === 'vat') { const v = b['vat'] as { regime: string; ratePct?: number }; out.vat = { regime: v.regime, ratePct: v.regime === 'taxable' ? v.ratePct : 0 }; }
  return out;
}

export async function createDraft(companyId: Id, userId: Id, b: Body) {
  const doc = await FiscalRule.create({ ...normalize(b), companyId, status: 'draft', createdBy: userId });
  return toDto(doc.toObject() as Lean);
}
async function getOwn(companyId: Id, id: string) {
  const r = await FiscalRule.findOne({ _id: id, companyId });
  if (!r) throw AppError.notFound('Règle fiscale introuvable');
  return r;
}
export async function updateDraft(companyId: Id, id: string, b: Body) {
  const r = await getOwn(companyId, id);
  if (r.status === 'validated') throw AppError.conflict('Règle validée : non modifiable. Créez une nouvelle version avec une date d’effet postérieure.');
  if (b.kind !== r.kind) throw AppError.badRequest('Le type de règle ne peut pas changer');
  r.set(normalize(b)); await r.save();
  return toDto(r.toObject() as Lean);
}
export async function deleteDraft(companyId: Id, id: string) {
  const r = await getOwn(companyId, id);
  if (r.status === 'validated') throw AppError.conflict('Règle validée : non supprimable (historique fiscal conservé)');
  await r.deleteOne(); return r;
}
/** Validation = mise en application à partir de la date d'effet. Doit être strictement postérieure à la dernière version validée du même code. */
export async function validate(companyId: Id, userId: Id, id: string) {
  const r = await getOwn(companyId, id);
  if (r.status === 'validated') throw AppError.conflict('Règle déjà validée');
  const last = await FiscalRule.findOne({ companyId, kind: r.kind, code: r.code, status: 'validated' }).sort({ effectiveFrom: -1 }).lean();
  if (last && r.effectiveFrom <= last.effectiveFrom) {
    throw AppError.conflict(`Une version validée existe déjà au ${last.effectiveFrom.toISOString().slice(0, 10)} : la date d’effet doit lui être postérieure`);
  }
  r.status = 'validated'; r.validatedAt = new Date(); r.validatedBy = userId; await r.save();
  return toDto(r.toObject() as Lean);
}

/**
 * Modèle de démarrage : brouillons de codes TVA courants. Rien n'est appliqué tant que chaque règle n'est pas VALIDÉE
 * (à confirmer avec le comptable de l'entreprise). Les codes déjà présents à cette date sont ignorés.
 */
export const VAT_TEMPLATE = [
  { code: 'T19', label: 'TVA 19 %', vat: { regime: 'taxable', ratePct: 19 } }, { code: 'T13', label: 'TVA 13 %', vat: { regime: 'taxable', ratePct: 13 } },
  { code: 'T7', label: 'TVA 7 %', vat: { regime: 'taxable', ratePct: 7 } }, { code: 'T0', label: 'TVA 0 % (taux zéro)', vat: { regime: 'zero', ratePct: 0 } },
  { code: 'EXO', label: 'Exonéré de TVA', vat: { regime: 'exempt', ratePct: 0 } }, { code: 'SUS', label: 'Achat en suspension de TVA', vat: { regime: 'suspended', ratePct: 0 } },
] as const;
export async function createVatTemplate(companyId: Id, userId: Id, effectiveFrom: Date) {
  const from = startOfDay(effectiveFrom); const created = [];
  for (const t of VAT_TEMPLATE) {
    if (await FiscalRule.exists({ companyId, kind: 'vat', code: t.code, effectiveFrom: from })) continue;
    created.push(toDto((await FiscalRule.create({ companyId, kind: 'vat', status: 'draft', effectiveFrom: from, createdBy: userId, legalReference: 'À valider avec le comptable', ...t })).toObject() as Lean));
  }
  return created;
}
