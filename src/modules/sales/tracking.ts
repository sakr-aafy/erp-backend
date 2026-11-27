import { componentsOf, q3, type CycleLine } from './billing.js';

/**
 * Progression d'une proforma. Les quantités ne s'additionnent jamais entre unités différentes : le pourcentage est pondéré par le
 * montant convenu de chaque ligne (net HT après toutes remises) ; si toutes les lignes sont à zéro, moyenne des taux par ligne.
 */
export type ProgressState = 'none' | 'partial' | 'full';
export function progressOf(lines: CycleLine[], done: (l: CycleLine) => number): { state: ProgressState; pct: number } {
  const ratio = (l: CycleLine) => Math.max(0, Math.min(1, done(l) / l.quantity));
  const total = lines.reduce((s, l) => s + componentsOf(l).after, 0);
  const full = lines.length > 0 && lines.every((l) => q3(done(l)) >= l.quantity - 1e-9);
  const some = lines.some((l) => done(l) > 1e-9);
  const raw = !lines.length ? 0 : total > 0 ? lines.reduce((s, l) => s + componentsOf(l).after * ratio(l), 0) / total : lines.reduce((s, l) => s + ratio(l), 0) / lines.length;
  // 0 % et 100 % ne s'affichent que lorsqu'ils sont exacts
  const pct = full ? 100 : !some ? 0 : Math.min(99, Math.max(1, Math.round(raw * 100)));
  return { state: full ? 'full' : some ? 'partial' : 'none', pct };
}
export const DELIVERY_STATE_LABEL: Record<ProgressState, string> = { none: 'Non livrée', partial: 'Partiellement livrée', full: 'Totalement livrée' };
export const BILLING_STATE_LABEL: Record<ProgressState, string> = { none: 'Non facturée', partial: 'Partiellement facturée', full: 'Totalement facturée' };
