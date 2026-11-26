import type { ClientSession, Types } from 'mongoose';
import { Warehouse } from '../../models/logistics.model.js';
import { AppError } from '../../utils/errors.js';
import { resolveAddress, snapshotDto, type AddressSnapshot } from '../parties/delivery-address.js';

type Id = Types.ObjectId;
export interface ReceivingSnapshot { warehouseId?: Id | null | undefined; code?: string | null | undefined; name?: string | null | undefined; address?: string | null | undefined }

/** Copie de l'adresse de réception (magasin ACTIF de la société). */
export async function receivingSnapshot(companyId: Id, warehouseId: string | Id, session?: ClientSession): Promise<ReceivingSnapshot> {
  const w = await Warehouse.findOne({ _id: warehouseId, companyId, isActive: true }).session(session ?? null).lean();
  if (!w) throw AppError.badRequest('Magasin invalide');
  return { warehouseId: w._id, code: w.code, name: w.name, ...(w.address && { address: w.address }) };
}

/**
 * Adresses d'une commande : adresse du fournisseur (parmi ses adresses enregistrées) et adresse de réception de l'entreprise.
 * Absent : copie existante conservée, sinon adresse par défaut du fournisseur / magasin par défaut. null : aucune.
 */
export async function orderAddresses(companyId: Id, supplier: Parameters<typeof resolveAddress>[0], b: { supplierAddressId?: string | null | undefined; receivingWarehouseId?: string | null | undefined },
  session: ClientSession, current?: { supplierAddress?: unknown; receivingAddress?: unknown }) {
  const supplierAddress = resolveAddress(supplier, b.supplierAddressId, current?.supplierAddress as AddressSnapshot | null | undefined);
  let receivingAddress: ReceivingSnapshot | null;
  if (b.receivingWarehouseId === null) receivingAddress = null;
  else if (b.receivingWarehouseId) receivingAddress = await receivingSnapshot(companyId, b.receivingWarehouseId, session);
  else if (current && current.receivingAddress !== undefined) receivingAddress = current.receivingAddress as ReceivingSnapshot | null;
  else {
    const def = await Warehouse.findOne({ companyId, isActive: true, isDefault: true }).session(session).lean();
    receivingAddress = def ? await receivingSnapshot(companyId, def._id, session) : null;
  }
  return { supplierAddress, receivingAddress };
}

export const addressesDto = (d: { supplierAddress?: unknown; receivingAddress?: unknown }) => {
  const r = d.receivingAddress as ReceivingSnapshot | null | undefined;
  return {
    supplierAddress: snapshotDto(d.supplierAddress as AddressSnapshot | null | undefined),
    receivingAddress: r?.name ? { warehouseId: r.warehouseId?.toString() ?? null, code: r.code ?? null, name: r.name, address: r.address ?? null } : null,
  };
};
