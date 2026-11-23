import type { Request, Response } from 'express';
import { audit } from '../../services/audit.service.js';
import * as svc from './user.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;

export const list = async (req: Request, res: Response) => res.json(await svc.listUsers(cid(req), req.query as never));
export const stats = async (req: Request, res: Response) => res.json(await svc.userStats(cid(req)));
export const get = async (req: Request, res: Response) => res.json(await svc.getUser(cid(req), pid(req)));
export async function create(req: Request, res: Response) {
  const u = await svc.createUser(cid(req), req.body);
  await audit(req, { action: 'create', resource: 'user', resourceId: u.id, meta: { email: u.email, roleId: u.roleId } });
  res.status(201).json(u);
}
export async function update(req: Request, res: Response) {
  const u = await svc.updateUser(cid(req), pid(req), req.body);
  await audit(req, { action: 'update', resource: 'user', resourceId: u.id, meta: { fields: Object.keys(req.body) } });
  res.json(u);
}
export async function setActive(req: Request, res: Response) {
  const u = await svc.setActive(cid(req), req.auth!.userId, pid(req), req.body.isActive);
  await audit(req, { action: req.body.isActive ? 'activate' : 'deactivate', resource: 'user', resourceId: u.id });
  res.json(u);
}
export async function resetPassword(req: Request, res: Response) {
  await svc.adminResetPassword(cid(req), pid(req), req.body.newPassword);
  await audit(req, { action: 'reset-password', resource: 'user', resourceId: pid(req) });
  res.status(204).end();
}
