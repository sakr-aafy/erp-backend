/**
 * Service unique de calcul des documents commerciaux (devis, proforma, facture, avoir, BL).
 * Fonctions PURES, sans accès base : testables unitairement. Montants en entiers (plus petite unité de la devise, ex. millimes).
 *
 * Méthode (conforme à l'usage des factures à taux multiples) :
 *  1. brut de ligne = quantité × prix unitaire ; remise de ligne en % ; net HT de ligne ;
 *  2. remise globale (% ou montant) répartie par groupe de TVA (plus fort reste pour un montant) ;
 *  3. TVA calculée PAR TAUX sur la base HT du groupe (pas ligne par ligne : pas d'écart d'arrondi) ;
 *  4. retenue à la source sur base HT ou TTC ; timbre ajouté au net à payer (hors assiette de TVA).
 * Arrondi : à l'unité entière la plus proche, 0,5 arrondi vers le haut (valeurs positives). Aucune règle fiscale n'est codée ici :
 * taux, régimes, retenue et timbre sont fournis par l'appelant (règles fiscales configurées et validées).
 */
export type VatRegime = 'taxable' | 'zero' | 'exempt' | 'suspended';

export interface CalcLine {
  quantity: number;            // jusqu'à 3 décimales
  unitPriceMinor: number;
  discountPct?: number;        // remise de ligne, 0-100, 2 décimales max
  vatCode: string;
  vatRegime: VatRegime;
  vatRatePct: number;          // ignoré si le régime n'est pas « taxable »
  /** Avoirs : net HT imposé (après toutes remises), calculé par le builder d'avoir à partir de la facture d'origine. */
  netHtOverrideMinor?: number;
  /** Facturation de livraisons : brut et part de remise globale affectés à la ligne (prorata du document source, au millime). */
  grossOverrideMinor?: number;
  globalShareOverrideMinor?: number;
}
export interface CalcInput {
  lines: CalcLine[];
  globalDiscountPct?: number;
  globalDiscountMinor?: number; // exclusif avec globalDiscountPct
  withholding?: { ratePct: number; base: 'ht' | 'ttc'; amountOverrideMinor?: number } | null;
  stampMinor?: number;
  /** Avoirs : TVA imposée par groupe (clé `code|régime|taux`), pour que la somme des avoirs égale exactement la TVA d'origine. */
  vatOverrides?: Record<string, number>;
}
/** `globalShareMinor` : part de la remise globale imputée à la ligne (permet de créditer proportionnellement). */
export interface CalcLineResult { grossMinor: number; discountMinor: number; netHtMinor: number; globalShareMinor: number }
export interface VatGroup { vatCode: string; regime: VatRegime; ratePct: number; baseMinor: number; vatMinor: number }
export interface DocTotals {
  grossMinor: number; lineDiscountsMinor: number; globalDiscountMinor: number; totalHtMinor: number;
  vatGroups: VatGroup[]; totalVatMinor: number; totalTtcMinor: number;
  stampMinor: number; withholdingMinor: number; totalPayableMinor: number;
}
export interface CalcResult { lines: CalcLineResult[]; totals: DocTotals }

export class CalculationError extends Error {}

const big = BigInt;
/** Division entière arrondie « half up » pour des valeurs positives. */
function divRound(n: bigint, d: bigint): number {
  return Number((n * 2n + d) / (d * 2n));
}
const toScaled = (v: number, scale: number, label: string): bigint => {
  if (!Number.isFinite(v)) throw new CalculationError(`${label} invalide`);
  return big(Math.round(v * scale));
};

/** montant × quantité (3 décimales) */
export const mulQty = (amountMinor: number, quantity: number): number => divRound(big(amountMinor) * toScaled(quantity, 1000, 'Quantité'), 1000n);
/** montant × pourcentage (2 décimales) */
/** amount × num / den, arrondi demi-haut (BigInt, valeurs positives). */
export const proportion = (amount: number, num: number, den: number): number => (den === 0 ? 0 : divRound(big(amount) * toScaled(num, 1000, 'Quantité'), toScaled(den, 1000, 'Quantité')));
export const groupKey = (code: string, regime: string, ratePct: number) => `${code}|${regime}|${regime === 'taxable' ? ratePct : 0}`;
export const pctOf = (amountMinor: number, pct: number): number => divRound(big(amountMinor) * toScaled(pct, 100, 'Pourcentage'), 10000n);

function assertLine(l: CalcLine, i: number) {
  if (!(l.quantity > 0)) throw new CalculationError(`Ligne ${i + 1} : quantité > 0 requise`);
  if (!Number.isInteger(l.unitPriceMinor) || l.unitPriceMinor < 0) throw new CalculationError(`Ligne ${i + 1} : prix unitaire invalide`);
  const d = l.discountPct ?? 0;
  if (d < 0 || d > 100) throw new CalculationError(`Ligne ${i + 1} : remise entre 0 et 100 %`);
  if (l.vatRegime === 'taxable' && !(l.vatRatePct >= 0)) throw new CalculationError(`Ligne ${i + 1} : taux de TVA invalide`);
}

/** Répartit `amount` entre des bases proportionnellement (méthode du plus fort reste) : la somme est exacte. */
export function allocateProportional(amount: number, bases: number[]): number[] {
  const total = bases.reduce((s, b) => s + b, 0);
  if (amount === 0 || total === 0) return bases.map(() => 0);
  const shares = bases.map((b) => (big(amount) * big(b)));
  const floors = shares.map((s) => Number(s / big(total)));
  let remaining = amount - floors.reduce((s, f) => s + f, 0);
  const order = shares.map((s, i) => ({ i, r: s % big(total) })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = [...floors];
  for (const o of order) { if (remaining <= 0) break; out[o.i]! += 1; remaining--; }
  return out;
}

export function computeDocument(input: CalcInput): CalcResult {
  if (!input.lines.length) throw new CalculationError('Au moins une ligne est requise');
  if (input.globalDiscountPct !== undefined && input.globalDiscountMinor !== undefined && input.globalDiscountPct > 0 && input.globalDiscountMinor > 0) {
    throw new CalculationError('Remise globale : pourcentage OU montant, pas les deux');
  }
  const lines: CalcLineResult[] = input.lines.map((l, i) => {
    assertLine(l, i);
    const grossMinor = l.grossOverrideMinor ?? mulQty(l.unitPriceMinor, l.quantity);
    if (l.netHtOverrideMinor !== undefined) {
      if (!Number.isInteger(l.netHtOverrideMinor) || l.netHtOverrideMinor < 0) throw new CalculationError(`Ligne ${i + 1} : montant net invalide`);
      const share = l.globalShareOverrideMinor ?? 0;
      if (!Number.isInteger(share) || share < 0 || share > l.netHtOverrideMinor) throw new CalculationError(`Ligne ${i + 1} : part de remise invalide`);
      return { grossMinor, discountMinor: Math.max(0, grossMinor - l.netHtOverrideMinor), netHtMinor: l.netHtOverrideMinor, globalShareMinor: share };
    }
    const discountMinor = pctOf(grossMinor, l.discountPct ?? 0);
    return { grossMinor, discountMinor, netHtMinor: grossMinor - discountMinor, globalShareMinor: 0 };
  });

  // Groupes de TVA (ordre d'apparition conservé)
  const groups = new Map<string, { vatCode: string; regime: VatRegime; ratePct: number; base: number; idx: number[] }>();
  input.lines.forEach((l, i) => {
    const ratePct = l.vatRegime === 'taxable' ? l.vatRatePct : 0;
    const key = groupKey(l.vatCode, l.vatRegime, ratePct);
    const g = groups.get(key) ?? { vatCode: l.vatCode, regime: l.vatRegime, ratePct, base: 0, idx: [] };
    g.base += lines[i]!.netHtMinor; g.idx.push(i); groups.set(key, g);
  });
  const list = [...groups.values()];
  const baseBeforeGlobal = list.reduce((s, g) => s + g.base, 0);

  let globalDiscount = 0;
  let perGroup: number[];
  // Parts de remise déjà affectées ligne par ligne : jamais réparties ni appliquées une seconde fois
  const fixed = input.lines.some((l) => l.globalShareOverrideMinor !== undefined);
  if (fixed && ((input.globalDiscountPct ?? 0) > 0 || (input.globalDiscountMinor ?? 0) > 0)) throw new CalculationError('Remise globale déjà affectée aux lignes');
  if (fixed) {
    perGroup = list.map((g) => g.idx.reduce((s, i) => s + lines[i]!.globalShareMinor, 0));
    globalDiscount = perGroup.reduce((s, v) => s + v, 0);
  } else if ((input.globalDiscountPct ?? 0) > 0) {
    if (input.globalDiscountPct! > 100) throw new CalculationError('Remise globale : maximum 100 %');
    perGroup = list.map((g) => pctOf(g.base, input.globalDiscountPct!));
    globalDiscount = perGroup.reduce((s, v) => s + v, 0);
  } else if ((input.globalDiscountMinor ?? 0) > 0) {
    if (!Number.isInteger(input.globalDiscountMinor)) throw new CalculationError('Remise globale invalide');
    if (input.globalDiscountMinor! > baseBeforeGlobal) throw new CalculationError('La remise globale dépasse le total HT');
    globalDiscount = input.globalDiscountMinor!;
    perGroup = allocateProportional(globalDiscount, list.map((g) => g.base));
  } else perGroup = list.map(() => 0);

  // Imputation de la remise globale de chaque groupe aux lignes du groupe (plus fort reste) : somme exacte
  if (!fixed) list.forEach((g, gi) => { const shares = allocateProportional(perGroup[gi]!, g.idx.map((i) => lines[i]!.netHtMinor)); g.idx.forEach((i, k) => { lines[i]!.globalShareMinor = shares[k]!; }); });
  const vatGroups: VatGroup[] = list.map((g, i) => {
    const baseMinor = g.base - perGroup[i]!;
    const forced = input.vatOverrides?.[groupKey(g.vatCode, g.regime, g.ratePct)];
    return { vatCode: g.vatCode, regime: g.regime, ratePct: g.ratePct, baseMinor, vatMinor: g.regime !== 'taxable' ? 0 : forced ?? pctOf(baseMinor, g.ratePct) };
  });
  const totalHtMinor = vatGroups.reduce((s, g) => s + g.baseMinor, 0);
  const totalVatMinor = vatGroups.reduce((s, g) => s + g.vatMinor, 0);
  const totalTtcMinor = totalHtMinor + totalVatMinor;
  const stampMinor = input.stampMinor ?? 0;
  if (!Number.isInteger(stampMinor) || stampMinor < 0) throw new CalculationError('Timbre invalide');
  const withholdingMinor = input.withholding ? input.withholding.amountOverrideMinor ?? pctOf(input.withholding.base === 'ht' ? totalHtMinor : totalTtcMinor, input.withholding.ratePct) : 0;

  return {
    lines,
    totals: {
      grossMinor: lines.reduce((s, l) => s + l.grossMinor, 0), lineDiscountsMinor: lines.reduce((s, l) => s + l.discountMinor, 0),
      globalDiscountMinor: globalDiscount, totalHtMinor, vatGroups, totalVatMinor, totalTtcMinor, stampMinor, withholdingMinor,
      totalPayableMinor: totalTtcMinor + stampMinor - withholdingMinor,
    },
  };
}
