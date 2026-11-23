import type { Request, Response } from 'express';
import { Company } from '../../models/company.model.js';
import { audit } from '../../services/audit.service.js';
import { AppError } from '../../utils/errors.js';
import * as svc from './company.service.js';

export const current = async (req: Request, res: Response) => res.json(await svc.getCompany(req.auth!.companyId));

export async function updateCurrent(req: Request, res: Response) {
  const c = await Company.findByIdAndUpdate(req.auth!.companyId, req.body, { returnDocument: 'after', runValidators: true }).lean();
  await audit(req, { action: 'update', resource: 'company', resourceId: req.auth!.companyId, meta: { fields: Object.keys(req.body) } });
  res.json(c);
}
export const list = async (_req: Request, res: Response) => res.json(await Company.find().sort({ name: 1 }).lean());

export async function create(req: Request, res: Response) {
  const r = await svc.createCompanyWithAdmin(req.body);
  await audit(req, { action: 'create', resource: 'company', resourceId: r.company._id, meta: { name: r.company.name, adminEmail: r.user.email } });
  res.status(201).json({ company: r.company, adminId: r.user._id });
}
export async function setActive(req: Request, res: Response) {
  const id = req.params.id as string;
  if (id === req.auth!.companyId.toString()) throw AppError.badRequest('Impossible de désactiver votre propre société');
  const c = await Company.findByIdAndUpdate(id, { isActive: req.body.isActive }, { returnDocument: 'after' }).lean();
  if (!c) throw AppError.notFound('Société introuvable');
  await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'company', resourceId: id });
  res.json(c);
}
