import { Types, type ClientSession } from 'mongoose';
import { Product, ProductSerial } from '../models/product.model.js';
import { CostHistory, StockLevel, StockMovement, Warehouse, type MovementDoc } from '../models/logistics.model.js';
import { AppError } from '../utils/errors.js';
import { proportion } from './calculation.service.js';

type Id = Types.ObjectId;
export type MovementReason = MovementDoc['reason'];
export interface MovementInput {
  companyId: Id; session: ClientSession; userId?: Id | undefined; productId: Id | string; warehouseId: Id | string; direction: 'in' | 'out'; quantity: number; reason: MovementReason;
  eventKey: string; source?: { type: string; id: Id; number?: string | undefined } | undefined;
  /** Entrée : coût unitaire (valeur = qté × coût arrondie) OU valeur totale exacte (retour, transfert). */
  unitCostMinor?: number | undefined; totalValueMinor?: number | undefined;
  /** Répartition du coût pour l'historique (achat / frais annexes par unité). */
  costInfo?: { purchaseUnitMinor: number; extraUnitMinor: number } | undefined;
  serials?: string[] | undefined; allowNegative?: boolean | undefined; note?: string | undefined; touchCost?: boolean | undefined;
}
export interface MovementResult { movement: Awaited<ReturnType<typeof StockMovement.create>>[number] | null; duplicate: boolean; skipped?: 'service'; belowMin: boolean }

const roundInt = (n: number) => Math.round(n);

/** Prépare les niveaux AVANT d'ouvrir la transaction (évite les conflits de clé unique à la première entrée en stock). */
export async function ensureLevels(companyId: Id, pairs: { productId: Id | string; warehouseId: Id | string }[]) {
  for (const p of pairs) {
    await StockLevel.updateOne({ companyId, productId: p.productId, warehouseId: p.warehouseId }, { $setOnInsert: { qty: 0, valueMinor: 0 } }, { upsert: true }).catch((e) => { if (e?.code !== 11000) throw e; });
  }
}

export async function defaultWarehouseId(companyId: Id, session?: ClientSession): Promise<Id> {
  const w = (await Warehouse.findOne({ companyId, isActive: true, isDefault: true }).session(session ?? null).lean()) ?? (await Warehouse.findOne({ companyId, isActive: true }).sort({ createdAt: 1 }).session(session ?? null).lean());
  if (!w) throw new AppError(409, 'Aucun magasin actif : créez un magasin avant tout mouvement de stock', 'NO_WAREHOUSE');
  return w._id;
}

/**
 * Applique UN mouvement de stock (valorisation CMP en entiers). Idempotent par `eventKey`.
 *  - entrée : valeur += qté × coût (ou valeur exacte) ;
 *  - sortie : valeur sortie = valeur × qté / qté avant ; la dernière unité emporte toute la valeur restante ;
 *  - stock négatif interdit sauf `allowNegative` (la part manquante est alors valorisée au coût de revient de l'article).
 * Doit être appelé DANS une transaction.
 */
/**
 * Conséquences du statut de l'article sur le stock : livraison (vente) = actif seulement ; réception, importation et entrée manuelle = actif ou inactif ;
 * transferts, inventaires, sorties manuelles = tout sauf archivé ; l'annulation d'une livraison reste toujours possible (correction d'une opération passée).
 */
function assertProductAllows(p: { reference: string; status?: string | null | undefined; isActive?: boolean | null | undefined }, reason: MovementReason) {
  const st = p.status ?? (p.isActive === false ? 'inactive' : 'active');
  const ok = reason === 'delivery' ? st === 'active' : reason === 'receipt' || reason === 'import' || reason === 'manual_in' ? st === 'active' || st === 'inactive' : reason === 'delivery_cancel' ? true : st !== 'archived';
  if (!ok) { const label = ({ inactive: 'inactif', blocked: 'bloqué', archived: 'archivé' } as Record<string, string>)[st] ?? st; throw new AppError(409, `Article « ${p.reference} » ${label} : opération de stock impossible`, `PRODUCT_${st.toUpperCase()}`); }
}

export async function applyMovement(inp: MovementInput): Promise<MovementResult> {
  const { companyId, session } = inp;
  const existing = await StockMovement.findOne({ companyId, eventKey: inp.eventKey }).session(session);
  if (existing) return { movement: existing, duplicate: true, belowMin: false };
  if (!(inp.quantity > 0)) throw AppError.badRequest('Quantité de mouvement invalide');
  const product = await Product.findOne({ _id: inp.productId, companyId }).session(session).lean();
  if (!product) throw AppError.notFound('Article introuvable');
  if (product.kind === 'service') return { movement: null, duplicate: false, skipped: 'service', belowMin: false };
  assertProductAllows(product, inp.reason);
  if (!(await Warehouse.exists({ _id: inp.warehouseId, companyId }).session(session))) throw AppError.badRequest('Magasin invalide');
  if (product.hasSerial && Math.abs(inp.quantity - Math.round(inp.quantity)) > 1e-9) throw AppError.badRequest(`« ${product.reference} » : quantité entière requise (articles suivis par numéro de série)`);

  const level = await StockLevel.findOneAndUpdate({ companyId, productId: inp.productId, warehouseId: inp.warehouseId }, { $setOnInsert: { qty: 0, valueMinor: 0 } }, { upsert: true, returnDocument: 'after', session });
  const qtyBefore = level!.qty, valueBefore = level!.valueMinor;
  let qtyAfter: number, valueAfter: number, moveValue: number, forced = false;

  if (inp.direction === 'in') {
    moveValue = inp.totalValueMinor ?? roundInt((inp.unitCostMinor ?? 0) * inp.quantity);
    qtyAfter = qtyBefore + inp.quantity;
    // Entrée sur un niveau négatif : seule la partie qui reconstitue du stock positif porte de la valeur
    valueAfter = qtyBefore >= 0 ? valueBefore + moveValue : (qtyAfter > 0 ? proportion(moveValue, qtyAfter, inp.quantity) : 0);
  } else {
    const available = Math.max(0, qtyBefore);
    if (inp.quantity > available + 1e-9) {
      if (!inp.allowNegative) throw new AppError(409, `Stock insuffisant pour « ${product.reference} » : demandé ${inp.quantity}, disponible ${available}`, 'INSUFFICIENT_STOCK', { productId: String(inp.productId), warehouseId: String(inp.warehouseId), requested: inp.quantity, available });
      forced = true;
    }
    const take = Math.min(inp.quantity, available);
    const takeValue = take <= 0 ? 0 : take >= qtyBefore - 1e-9 ? valueBefore : proportion(valueBefore, take, qtyBefore);
    const fallback = roundInt((product.costPriceMinor ?? product.purchasePriceMinor ?? 0) * Math.max(0, inp.quantity - take));
    moveValue = takeValue + fallback; qtyAfter = qtyBefore - inp.quantity; valueAfter = valueBefore - takeValue;
  }
  const upd = await StockLevel.updateOne({ _id: level!._id, qty: qtyBefore, valueMinor: valueBefore }, { $set: { qty: qtyAfter, valueMinor: valueAfter } }, { session });
  if (!upd.matchedCount) throw new AppError(409, 'Le stock a changé entre-temps : réessayez', 'STOCK_CONFLICT');

  await handleSerials(inp, product, level!.warehouseId);
  const [movement] = await StockMovement.create([{ companyId, productId: inp.productId, warehouseId: inp.warehouseId, direction: inp.direction, reason: inp.reason, quantity: inp.quantity,
    unitCostMinor: inp.quantity ? roundInt(moveValue / inp.quantity) : 0, valueMinor: moveValue, qtyBefore, qtyAfter, valueBefore, valueAfter, source: inp.source, serials: inp.serials ?? [], note: inp.note, forced,
    eventKey: inp.eventKey, userId: inp.userId }] as never[], { session });

  if (inp.direction === 'in' && inp.touchCost) await refreshCost(inp, product);
  const total = await StockLevel.aggregate<{ q: number }>([{ $match: { companyId, productId: new Types.ObjectId(String(inp.productId)) } }, { $group: { _id: null, q: { $sum: '$qty' } } }]).session(session);
  return { movement: movement!, duplicate: false, belowMin: (product.minStock ?? 0) > 0 && (total[0]?.q ?? 0) < (product.minStock ?? 0) };
}

/** Numéros de série : cohérence entre le mouvement et les numéros enregistrés. */
async function handleSerials(inp: MovementInput, product: { _id: Id; reference: string; hasSerial?: boolean | null }, _wh: Id) {
  const { companyId, session } = inp;
  const serials = [...new Set(inp.serials ?? [])];
  if (!product.hasSerial) { if (serials.length) throw AppError.badRequest(`« ${product.reference} » n'est pas suivi par numéro de série`); return; }
  if (serials.length !== inp.quantity) throw AppError.badRequest(`« ${product.reference} » : ${inp.quantity} numéro(s) de série requis, ${serials.length} fourni(s)`);
  const rows = await ProductSerial.find({ companyId, productId: product._id, serialNumber: { $in: serials } }).session(session);
  const byNumber = new Map(rows.map((r) => [r.serialNumber, r]));
  if (inp.direction === 'in') {
    const reuse = inp.reason === 'delivery_cancel' || inp.reason === 'transfer_in';
    for (const sn of serials) {
      const row = byNumber.get(sn);
      if (reuse) {
        if (!row) throw AppError.conflict(`Numéro de série inconnu : ${sn}`);
        row.status = 'available'; row.warehouseId = inp.warehouseId as never; row.set('soldOn', undefined); await row.save({ session });
      } else {
        if (row && !(row.status === 'returned' || row.status === 'scrapped')) throw AppError.conflict(`Numéro de série déjà enregistré : ${sn}`);
        if (row) { row.status = 'available'; row.warehouseId = inp.warehouseId as never; await row.save({ session }); } else await ProductSerial.create([{ companyId, productId: product._id, serialNumber: sn, status: 'available', warehouseId: inp.warehouseId }] as never[], { session });
      }
    }
  } else {
    for (const sn of serials) {
      const row = byNumber.get(sn);
      if (!row || row.status !== 'available' || String(row.warehouseId) !== String(inp.warehouseId)) throw AppError.conflict(`Numéro de série indisponible dans ce magasin : ${sn}`);
      if (inp.reason === 'delivery') { row.status = 'sold'; row.set('soldOn', inp.source); await row.save({ session }); }
      else if (inp.reason === 'manual_out' || inp.reason === 'inventory_out') { row.status = 'scrapped'; await row.save({ session }); }
      // transfer_out : le numéro reste disponible jusqu'à l'entrée dans le magasin destinataire (même transaction)
    }
  }
}

/** Coût de revient = CMP global de l'article (Σ valeur / Σ quantité des magasins). Historisé à chaque variation. */
async function refreshCost(inp: MovementInput, product: { _id: Id; costPriceMinor?: number | null | undefined }) {
  const agg = await StockLevel.aggregate<{ q: number; v: number }>([{ $match: { companyId: inp.companyId, productId: product._id, qty: { $gt: 0 } } }, { $group: { _id: null, q: { $sum: '$qty' }, v: { $sum: '$valueMinor' } } }]).session(inp.session);
  const q = agg[0]?.q ?? 0; if (q <= 0) return;
  const newCost = roundInt((agg[0]!.v) / q); const prev = product.costPriceMinor ?? null;
  if (prev === newCost) return;
  await Product.updateOne({ _id: product._id }, { costPriceMinor: newCost }, { session: inp.session });
  await CostHistory.create([{ companyId: inp.companyId, productId: product._id, previousCostMinor: prev, newCostMinor: newCost, purchaseUnitCostMinor: inp.costInfo?.purchaseUnitMinor ?? 0, extraUnitCostMinor: inp.costInfo?.extraUnitMinor ?? 0,
    quantity: inp.quantity, reason: inp.reason === 'import' ? 'import_integration' : 'goods_receipt', source: inp.source, userId: inp.userId }] as never[], { session: inp.session });
}
