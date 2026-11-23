import type { Request, Response } from 'express';
import { ACTIONS, ALL_MODULES } from '../../config/permissions.js';
import { audit } from '../../services/audit.service.js';
import * as svc from './role.service.js';

const cid = (req: Request) => req.auth!.companyId;
const pid = (req: Request) => req.params.id as string;

export const catalog = (_req: Request, res: Response) => res.json({ modules: ALL_MODULES, actions: ACTIONS });
export const list = async (req: Request, res: Response) => res.json(await svc.listRoles(cid(req)));
export const get = async (req: Request, res: Response) => res.json(await svc.getRole(cid(req), pid(req)));
export async function create(req: Request, res: Response) {
  const r = await svc.createRole(cid(req), req.body);
  await audit(req, { action: 'create', resource: 'role', resourceId: r._id, meta: { name: r.name, permissions: r.permissions.length } });
  res.status(201).json(r);
}
export async function update(req: Request, res: Response) {
  const r = await svc.updateRole(cid(req), pid(req), req.body);
  await audit(req, { action: 'update', resource: 'role', resourceId: r._id, meta: { name: r.name, permissions: r.permissions } });
  res.json(r);
}
export async function remove(req: Request, res: Response) {
  await svc.deleteRole(cid(req), pid(req));
  await audit(req, { action: 'delete', resource: 'role', resourceId: pid(req) });
  res.status(204).end();
}
