import type { ClientSession, Types } from 'mongoose';
import { Setting } from '../../models/setting.model.js';
import { AppError } from '../../utils/errors.js';
import { resolveRate } from '../imports/import.service.js';
import { toBaseMinor } from '../imports/import.calc.js';

/**
 * Prix d'achat RÉEL d'un article, pour les opérations d'achat, de stock et les rapports financiers.
 *
 * Un article dont le prix d'achat est dans une devise à taux estimatif (EUR) ne stocke aucune contre-valeur réelle
 * (`purchaseRate` absent) : la conversion se fait ici, au taux de change RÉEL applicable à la date de l'opération.
 * Le taux estimatif n'est jamais utilisé, même en l'absence de taux réel : l'opération est alors refusée.
 */
export interface PricedProduct {
  purchasePriceMinor?: number | null | undefined; purchaseCurrency?: string | null | undefined;
  purchasePriceForeignMinor?: number | null | undefined; purchaseRate?: number | null | undefined;
}

/** Prix en devise étrangère sans contre-valeur réelle enregistrée. */
export const needsRealRate = (p: PricedProduct) => !!p.purchaseCurrency && !p.purchaseRate;

export async function realPurchaseMinor(companyId: Types.ObjectId, p: PricedProduct, date: Date, session?: ClientSession): Promise<number> {
  if (!needsRealRate(p)) return p.purchasePriceMinor ?? 0;
  const foreign = p.purchasePriceForeignMinor ?? 0;
  if (!foreign) return 0;
  const s = await Setting.findOne({ companyId }).session(session ?? null).lean();
  const decimals = (code: string, fallback: number) => s?.currencies.find((c) => c.code === code)?.decimals ?? fallback;
  const { rate } = await resolveRate(companyId, p.purchaseCurrency!, date, session);
  return toBaseMinor(foreign, rate, decimals(p.purchaseCurrency!, 2), decimals(s?.baseCurrency ?? 'TND', 3));
}

/** Même valeur pour les écrans et rapports : null (« inconnu ») au lieu d'un refus lorsqu'aucun taux réel n'existe. */
export async function realPurchaseOrNull(companyId: Types.ObjectId, p: PricedProduct, date: Date = new Date()): Promise<number | null> {
  try { return await realPurchaseMinor(companyId, p, date); } catch (e) { if (e instanceof AppError) return null; throw e; }
}
