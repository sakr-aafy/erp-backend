import { Router } from 'express';
import { asyncHandler as h } from '../../utils/async-handler.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requirePermission as can } from '../../middlewares/auth.js';
import * as c from './supplier.controller.js';
import * as v from './supplier.validator.js';
import * as svc from './supplier.service.js';
import { Supplier } from '../../models/supplier.model.js';
import { GoodsReceipt, PurchaseOrder } from '../../models/logistics.model.js';
import { mountDeliveryAddresses } from '../parties/delivery-address.routes.js';

export const supplierRoutes = Router();
supplierRoutes.use(authenticate);
supplierRoutes.get('/', can('suppliers:view'), validate({ query: v.listQuery }), h(c.list));
supplierRoutes.get('/export', can('suppliers:view'), validate({ query: v.exportQuery }), h(c.exportList));
supplierRoutes.post('/', can('suppliers:create'), validate({ body: v.createSupplierBody }), h(c.create));
supplierRoutes.get('/:id', can('suppliers:view'), validate({ params: v.idParam }), h(c.get));
supplierRoutes.get('/:id/pdf', can('suppliers:view'), validate({ params: v.idParam }), h(c.fichePdf));
supplierRoutes.put('/:id', can('suppliers:update'), validate({ params: v.idParam, body: v.updateSupplierBody }), h(c.update));
supplierRoutes.post('/:id/archive', can('suppliers:update'), validate({ params: v.idParam }), h(c.archive));
supplierRoutes.post('/:id/reactivate', can('suppliers:update'), validate({ params: v.idParam }), h(c.reactivate));
supplierRoutes.delete('/:id', can('suppliers:delete'), validate({ params: v.idParam }), h(c.remove));

mountDeliveryAddresses(supplierRoutes, {
  resource: 'supplier', permission: 'suppliers:update', model: Supplier, notFound: 'Fournisseur introuvable', dto: (companyId, id) => svc.get(companyId, id),
  readOnly: (s) => (s.isArchived ? 'Fournisseur archivé : réactivez-le avant de modifier ses adresses' : null),
  isReferenced: async (companyId, addressId, supplierId) => {
    const q = { companyId, supplierId, 'supplierAddress.addressId': addressId };
    return !!(await PurchaseOrder.exists(q) || await GoodsReceipt.exists(q));
  },
});
