import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { vatCatalog } from '../../services/fiscal.service.js';
import { audit } from '../../services/audit.service.js';
import { estimateRatesOf } from '../products/estimate-rate.js';
import { AppError } from '../../utils/errors.js';

export async function get(req: Request, res: Response) {
  const s = await Setting.findOneAndUpdate({ companyId: req.auth!.companyId }, { $setOnInsert: { companyId: req.auth!.companyId } }, { upsert: true, returnDocument: 'after' }).lean();
  res.json(s);
}
export async function update(req: Request, res: Response) {
  const { supplierBlockThresholdMinor, ...rest } = req.body as { supplierBlockThresholdMinor?: number | null };
  const update: Record<string, unknown> = { $set: { ...rest, ...(typeof supplierBlockThresholdMinor === 'number' && { supplierBlockThresholdMinor }) } };
  if (supplierBlockThresholdMinor === null) update.$unset = { supplierBlockThresholdMinor: 1 }; // null = retirer le seuil global
  const s = await Setting.findOneAndUpdate({ companyId: req.auth!.companyId }, update, { returnDocument: 'after', upsert: true, runValidators: true }).lean();
  await audit(req, { action: 'update', resource: 'settings', resourceId: s._id, meta: { fields: Object.keys(req.body) } });
  res.json(s);
}

export async function reference(req: Request, res: Response) {
  const s = await Setting.findOne({ companyId: req.auth!.companyId }).lean();
  const base = s?.currencies.find((c) => c.code === s.baseCurrency);
  res.json({
    baseCurrency: s?.baseCurrency ?? 'TND', baseDecimals: base?.decimals ?? 3, baseSymbol: base?.symbol ?? null,
    currencies: s?.currencies ?? [], vatRates: await vatCatalog(req.auth!.companyId), estimateRates: estimateRatesOf(s),
  });
}


export async function updateEstimateRate(req: Request, res: Response) {
  const companyId = req.auth!.companyId; const { currency, rate } = req.body as { currency: string; rate: number };
  const current = await Setting.findOne({ companyId }).lean();
  const rates = estimateRatesOf(current); const target = rates.find((r) => r.currency === currency && r.targetCurrency === (current?.baseCurrency ?? 'TND'));
  if (!target) throw AppError.badRequest(`Aucun taux estimatif n’est paramétré pour la devise « ${currency} »`);
  const next = rates.map((r) => (r === target ? { ...r, rate, updatedAt: new Date(), updatedBy: req.auth!.userId } : r));
  const s = await Setting.findOneAndUpdate({ companyId }, { $set: { estimateRates: next } }, { returnDocument: 'after', upsert: true, runValidators: true }).lean();
  await audit(req, { action: 'update', resource: 'estimate-rate', resourceId: s!._id, meta: { currency, targetCurrency: target.targetCurrency, from: target.rate, to: rate } });
  res.json({ estimateRates: estimateRatesOf(s) });
}
