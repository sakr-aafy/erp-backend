import { toBaseMinor } from '../imports/import.calc.js';

/**
 * Taux de change ESTIMATIFS (paramètre par société) — SEULE source de la valeur initiale 1 EUR = 3,5 TND.
 *
 * Usage exclusif : fiche article (contre-valeur estimée du prix d'achat), coût de revient estimé et simulations de marge.
 * Ils ne sont JAMAIS enregistrés dans les taux de change réels (collection ExchangeRate) ni utilisés par une opération
 * d'achat, de stock, d'importation ou de comptabilité : voir purchase-price.ts.
 */
export interface EstimateRate { currency: string; targetCurrency: string; rate: number }
export const DEFAULT_ESTIMATE_RATES: readonly EstimateRate[] = [{ currency: 'EUR', targetCurrency: 'TND', rate: 3.5 }];

export type RateSettings = {
  baseCurrency?: string | null | undefined;
  currencies?: { code: string; decimals: number }[] | null | undefined;
  estimateRates?: { currency?: string | null | undefined; targetCurrency?: string | null | undefined; rate?: number | null | undefined }[] | null | undefined;
} | null | undefined;

/** Taux configurés de la société ; une société qui n'a encore rien enregistré utilise la valeur initiale. */
export function estimateRatesOf(s: RateSettings): EstimateRate[] {
  const list = (s?.estimateRates ?? []).filter((r): r is EstimateRate => !!r.currency && !!r.targetCurrency && typeof r.rate === 'number' && r.rate > 0);
  return list.length ? list.map((r) => ({ currency: r.currency, targetCurrency: r.targetCurrency, rate: r.rate })) : DEFAULT_ESTIMATE_RATES.map((r) => ({ ...r }));
}

/** Taux estimatif applicable à une devise d'achat, vers la devise de base de la société ; absent pour toute autre devise. */
export function estimateRateFor(s: RateSettings, currency: string | null | undefined): EstimateRate | null {
  const base = s?.baseCurrency ?? 'TND';
  if (!currency || currency === base) return null;
  return estimateRatesOf(s).find((r) => r.currency === currency && r.targetCurrency === base) ?? null;
}

const decimals = (s: RateSettings, code: string, fallback: number) => s?.currencies?.find((c) => c.code === code)?.decimals ?? fallback;
/** Multiplicateur « plus petite unité de la devise » → « plus petite unité de la devise de base » (hors taux). */
export const decimalsFactor = (s: RateSettings, currency: string) => 10 ** (decimals(s, s?.baseCurrency ?? 'TND', 3) - decimals(s, currency, 2));

/** Contre-valeur ESTIMÉE (plus petite unité de la devise de base), calcul entier exact ; null si la devise n'a pas de taux estimatif. */
export function estimatedPurchaseMinor(s: RateSettings, currency: string | null | undefined, foreignMinor: number | null | undefined): number | null {
  const r = estimateRateFor(s, currency);
  if (!r || foreignMinor === null || foreignMinor === undefined) return null;
  return toBaseMinor(foreignMinor, r.rate, decimals(s, r.currency, 2), decimals(s, r.targetCurrency, 3));
}
