/**
 * Montants : entiers en plus petite unité de la devise (ex. TND avec 3 décimales => millimes).
 * La précision (decimals) est configurable par devise dans les paramètres de la société.
 */
export function toMinor(amount: number | string, decimals: number): number {
  const n = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  if (!Number.isFinite(n)) throw new Error('Montant invalide');
  return Math.round(n * 10 ** decimals);
}
export function fromMinor(minor: number, decimals: number): number {
  return minor / 10 ** decimals;
}
export function formatMinor(minor: number, decimals: number): string {
  return fromMinor(minor, decimals).toFixed(decimals);
}
