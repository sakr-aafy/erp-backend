import type { Types } from 'mongoose';
import { Proforma } from '../../models/sales.model.js';
import { startOfDay } from '../../services/fiscal.service.js';

/** Une proforma expire seulement tant qu'aucune livraison n'est acquise : une commande en cours de livraison reste exécutable. */
export async function expireOverdue(companyId?: Types.ObjectId) {
  return (await Proforma.updateMany({ ...(companyId && { companyId }), status: 'pending', validUntil: { $lt: startOfDay(new Date()) }, 'lines.deliveredQty': { $not: { $gt: 0 } } }, { status: 'expired' })).modifiedCount;
}
