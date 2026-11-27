import type { Request, Response, Router } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { requirePermission as can } from '../../middlewares/auth.js';
import { audit } from '../../services/audit.service.js';
import { objectId } from '../../utils/pagination.js';
import { z } from 'zod';
import { addressParams, addressService, deliveryAddressBody, deliveryAddressUpdateBody, type AddressOwner } from './delivery-address.js';

const idParam = z.object({ id: objectId });

/** Routes `/:id/delivery-addresses…` d'un tiers (client ou fournisseur). Chaque réponse renvoie la fiche à jour. */
export function mountDeliveryAddresses<T>(router: Router, opts: AddressOwner & {
  resource: 'customer' | 'supplier'; permission: string; dto: (companyId: Types.ObjectId, id: string) => Promise<T>;
  onChange?: (req: Request, partyId: string, title: string) => Promise<void>;
  /** Filtre la fiche renvoyée selon les permissions de l'utilisateur. */
  view?: (req: Request, dto: T) => T;
}) {
  const svc = addressService(opts);
  const cid = (req: Request) => req.auth!.companyId;
  const pid = (req: Request) => req.params.id as string;
  const aid = (req: Request) => req.params.addressId as string;
  const done = async (req: Request, res: Response, action: string, title: string, r: { id: string; label: string; archived?: boolean }, status = 200) => {
    await audit(req, { action, resource: opts.resource, resourceId: pid(req), meta: { addressId: r.id, label: r.label, ...(r.archived !== undefined && { archived: r.archived }) } });
    await opts.onChange?.(req, pid(req), `${title} : ${r.label}`);
    const dto = await opts.dto(cid(req), pid(req));
    res.status(status).json({ ...(opts.view ? opts.view(req, dto) : dto), ...(r.archived !== undefined && { addressArchived: r.archived }) });
  };
  const base = '/:id/delivery-addresses';
  router.post(base, can(opts.permission), validate({ params: idParam, body: deliveryAddressBody }),
    h(async (req: Request, res: Response) => done(req, res, 'address-add', 'Adresse de livraison ajoutée', await svc.add(cid(req), pid(req), req.body), 201)));
  router.put(`${base}/:addressId`, can(opts.permission), validate({ params: addressParams, body: deliveryAddressUpdateBody }),
    h(async (req: Request, res: Response) => done(req, res, 'address-update', 'Adresse de livraison modifiée', await svc.update(cid(req), pid(req), aid(req), req.body))));
  router.post(`${base}/:addressId/default`, can(opts.permission), validate({ params: addressParams }),
    h(async (req: Request, res: Response) => done(req, res, 'address-default', 'Adresse de livraison par défaut', await svc.setDefault(cid(req), pid(req), aid(req)))));
  router.post(`${base}/:addressId/restore`, can(opts.permission), validate({ params: addressParams }),
    h(async (req: Request, res: Response) => done(req, res, 'address-restore', 'Adresse de livraison réactivée', await svc.restore(cid(req), pid(req), aid(req)))));
  router.delete(`${base}/:addressId`, can(opts.permission), validate({ params: addressParams }), h(async (req: Request, res: Response) => {
    const r = await svc.remove(cid(req), pid(req), aid(req));
    await done(req, res, r.archived ? 'address-archive' : 'address-remove', r.archived ? 'Adresse de livraison archivée' : 'Adresse de livraison supprimée', r);
  }));
}
