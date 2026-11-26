import type { ClientSession, Types } from 'mongoose';
import { computeDocument, pctOf } from '../../services/calculation.service.js';
import { resolveVat, type VatSnapshot } from '../../services/fiscal.service.js';
import { AppError } from '../../utils/errors.js';

type Id = Types.ObjectId;
const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface Packaging { lengthMm?: number | null | undefined; widthMm?: number | null | undefined; heightMm?: number | null | undefined; netWeightKg?: number | null | undefined; grossWeightKg?: number | null | undefined;
  /** Champs historiques (saisie « par colis », supprimée) : conservés en base, plus modifiés. */
  parcelCount?: number | null | undefined; dimensionsPerParcel?: boolean | null | undefined; reviewedAt?: Date | null | undefined }

/**
 * Volume total (m³) = longueur × largeur × hauteur (mm) / 1 000 000 000 — jamais multiplié par un nombre de colis.
 * Conservé à 12 décimales (seul le bruit binaire est retiré, aucun arrondi logistique). null si une dimension manque.
 */
export function volumeM3(p: Packaging | null | undefined): number | null {
  if (!p || !num(p.lengthMm) || !num(p.widthMm) || !num(p.heightMm)) return null;
  return r((p.lengthMm * p.widthMm * p.heightMm) / 1_000_000_000, 12);
}
/** Ancienne saisie « dimensions d'un colis × N colis » : les dimensions doivent être revérifiées (rien n'est présumé). */
export const needsDimensionReview = (p: Packaging | null | undefined) => !!p && (p.parcelCount ?? 0) > 1 && p.dimensionsPerParcel !== false && !p.reviewedAt;

/** Règles métier des dimensions et poids (le serveur est l'autorité ; le front ne fait que prévenir). */
export function packagingProblems(p: Packaging | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const [k, label] of [['lengthMm', 'Longueur'], ['widthMm', 'Largeur'], ['heightMm', 'Hauteur'], ['netWeightKg', 'Poids net'], ['grossWeightKg', 'Poids brut']] as const) {
    const v = p[k]; if (v !== undefined && v !== null && (!num(v) || v < 0)) out.push(`${label} : valeur négative ou invalide`);
  }
  if (num(p.netWeightKg) && num(p.grossWeightKg) && p.grossWeightKg < p.netWeightKg) out.push('Le poids brut ne peut pas être inférieur au poids net');
  return out;
}

export interface Margins {
  /** Marge HT = prix de vente HT − coût de revient HT. */
  marginHtMinor: number;
  /** Taux de marge (sur coût) = marge HT / coût × 100. null si coût nul. */
  marginRatePct: number | null;
  /** Taux de marque (sur prix de vente) = marge HT / prix de vente HT × 100. null si prix de vente nul. */
  markPct: number | null;
  /** Marge TTC INDICATIVE = prix TTC − coût TTC, où coût TTC = coût HT + TVA au taux de l'article. La TVA n'est jamais comptée comme un bénéfice : marge TTC = marge HT × (1 + taux TVA). À valider avec le comptable. */
  marginTtcMinor: number; marginTtcRatePct: number | null; costTtcMinor: number;
}
export function margins(saleHtMinor: number, costHtMinor: number, saleTtcMinor: number, vatRatePct: number): Margins {
  const marginHt = saleHtMinor - costHtMinor;
  const costTtc = costHtMinor + pctOf(costHtMinor, vatRatePct);
  const marginTtc = saleTtcMinor - costTtc;
  return {
    marginHtMinor: marginHt, marginRatePct: costHtMinor > 0 ? r((marginHt / costHtMinor) * 100, 2) : null, markPct: saleHtMinor > 0 ? r((marginHt / saleHtMinor) * 100, 2) : null,
    marginTtcMinor: marginTtc, marginTtcRatePct: costTtc > 0 ? r((marginTtc / costTtc) * 100, 2) : null, costTtcMinor: costTtc,
  };
}

/** Prix TTC d'un prix HT : service de calcul fiscal unique (régimes taxable / zéro / exonéré / suspendu), TVA issue des règles VALIDÉES (aucun taux codé en dur). */
export function ttcOf(htMinor: number, vat: Pick<VatSnapshot, 'code' | 'regime' | 'ratePct'>): number {
  return computeDocument({ lines: [{ quantity: 1, unitPriceMinor: htMinor, vatCode: vat.code, vatRegime: vat.regime, vatRatePct: vat.ratePct }] }).totals.totalTtcMinor;
}

const cache = new Map<string, { at: number; v: VatSnapshot }>();
/** TVA applicable (cache court : une liste d'articles ne résout chaque code qu'une fois). */
export async function vatFor(companyId: Id, code: string, session?: ClientSession): Promise<VatSnapshot | null> {
  const key = `${companyId}:${code.toUpperCase()}`; const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5_000 && !session) return hit.v;
  try { const v = await resolveVat(companyId, code, new Date(), session); if (!session) cache.set(key, { at: Date.now(), v }); return v; } catch (e) { if (e instanceof AppError) return null; throw e; }
}
