import { allocateProportional, mulQty } from '../../services/calculation.service.js';

/** Conversion d'un montant de devise étrangère (plus petite unité) en devise de base (plus petite unité) au taux donné (6 décimales). */
export function toBaseMinor(amountMinor: number, rate: number, foreignDecimals: number, baseDecimals: number): number {
  if (!(rate > 0)) throw new Error('Taux de change invalide');
  const num = BigInt(amountMinor) * BigInt(Math.round(rate * 1e6)) * 10n ** BigInt(baseDecimals);
  const den = 10n ** BigInt(foreignDecimals) * 1_000_000n;
  return Number((num * 2n + den) / (den * 2n));
}

export interface CalcLine { quantity: number; unitPriceMinor: number }
export interface CalcCharge { id: string; amountBaseMinor: number; allocation: 'value' | 'quantity' }
export interface ImportComputation {
  lines: { fobBaseMinor: number; allocatedChargesMinor: number; landedTotalMinor: number; unitLandedMinor: number; shares: Record<string, number> }[];
  totals: { fobBaseMinor: number; chargesBaseMinor: number; landedMinor: number }; byType: Record<string, number>;
}

/**
 * Coût de revient rendu : FOB converti au taux du dossier + frais (déjà convertis au taux du jour de chaque frais), répartis sur les lignes
 * par valeur ou par quantité (plus fort reste : la somme des parts égale exactement le frais). Recalcul complet à chaque changement.
 */
export function computeImport(lines: CalcLine[], charges: (CalcCharge & { type?: string })[], rate: number, foreignDecimals: number, baseDecimals: number): ImportComputation {
  const fob = lines.map((l) => toBaseMinor(mulQty(l.unitPriceMinor, l.quantity), rate, foreignDecimals, baseDecimals));
  const alloc = lines.map(() => 0); const shares = lines.map(() => ({} as Record<string, number>)); const byType: Record<string, number> = {};
  const qtyWeights = lines.map((l) => Math.round(l.quantity * 1000));
  for (const c of charges) {
    const parts = allocateProportional(c.amountBaseMinor, c.allocation === 'quantity' ? qtyWeights : fob);
    parts.forEach((p, i) => { alloc[i]! += p; shares[i]![c.id] = p; });
    const t = c.type ?? 'other'; byType[t] = (byType[t] ?? 0) + c.amountBaseMinor;
  }
  const out = lines.map((l, i) => { const landed = fob[i]! + alloc[i]!; return { fobBaseMinor: fob[i]!, allocatedChargesMinor: alloc[i]!, landedTotalMinor: landed, unitLandedMinor: l.quantity ? Math.round(landed / l.quantity) : 0, shares: shares[i]! }; });
  const chargesBase = charges.reduce((s, c) => s + c.amountBaseMinor, 0);
  return { lines: out, totals: { fobBaseMinor: fob.reduce((a, b) => a + b, 0), chargesBaseMinor: chargesBase, landedMinor: out.reduce((a, l) => a + l.landedTotalMinor, 0) }, byType };
}
