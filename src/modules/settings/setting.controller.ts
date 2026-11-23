import type { Request, Response } from 'express';
import { Setting } from '../../models/setting.model.js';
import { vatCatalog } from '../../services/fiscal.service.js';
import { audit } from '../../services/audit.service.js';

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
    currencies: s?.currencies ?? [], vatRates: await vatCatalog(req.auth!.companyId),
  });
}
