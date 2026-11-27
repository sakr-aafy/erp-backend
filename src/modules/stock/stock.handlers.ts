import type { Types } from 'mongoose';
import { DeliveryNote } from '../../models/sales.model.js';
import { slice } from '../sales/billing.js';
import { GoodsReceipt, Inventory, StockLevel, StockMovement, StockTransfer } from '../../models/logistics.model.js';
import { Product } from '../../models/product.model.js';
import { applyMovement, defaultWarehouseId } from '../../services/stock.service.js';
import { realPurchaseMinor } from '../products/purchase-price.js';
import { onDomainEvent } from '../../services/domain-events.js';

/**
 * Abonnés du module Stock. Exécutés dans la transaction de l'opération émettrice ; idempotents (clés de mouvement + journal d'événements).
 */
export function registerStockHandlers() {
  // BL validé → sortie de stock au CMP (blocage du stock négatif sauf autorisation explicite)
  onDomainEvent('deliveryNote.validated', async (ctx) => {
    const bl = await DeliveryNote.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean();
    if (!bl) return;
    const p = (ctx.payload ?? {}) as { allowNegativeStock?: boolean; warehouseId?: string };
    const warehouseId = p.warehouseId ?? bl.warehouseId ?? await defaultWarehouseId(ctx.companyId, ctx.session);
    let n = 0;
    for (const l of bl.lines) {
      if (!l.productId) continue;
      const r = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId, warehouseId, direction: 'out', quantity: l.quantity, reason: 'delivery',
        eventKey: `deliveryNote.validated:${bl._id}:${(l as { _id: unknown })._id}`, source: { type: 'deliveryNote', id: bl._id, number: bl.number }, serials: l.serials ?? undefined, allowNegative: !!p.allowNegativeStock });
      if (r.movement && !r.duplicate) n++;
    }
    await DeliveryNote.updateOne({ _id: bl._id }, { warehouseId }, { session: ctx.session });
    return { movements: n };
  }, 'stock');

  // BL annulé → réintégration à la valeur d'origine
  onDomainEvent('deliveryNote.cancelled', async (ctx) => {
    const moves = await StockMovement.find({ companyId: ctx.companyId, 'source.id': ctx.documentId, reason: 'delivery' }).session(ctx.session).lean();
    let n = 0;
    for (const m of moves) {
      const r = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: m.productId, warehouseId: m.warehouseId, direction: 'in', quantity: m.quantity, reason: 'delivery_cancel',
        eventKey: `deliveryNote.cancelled:${ctx.documentId}:${m._id}`, source: m.source ? { type: m.source.type!, id: m.source.id!, number: m.source.number ?? undefined } : undefined, totalValueMinor: m.valueMinor, serials: m.serials });
      if (r.movement && !r.duplicate) n++;
    }
    return { movements: n };
  }, 'stock');

  // Retour physique confirmé → réintégration à la valeur de la sortie d'origine ; jamais d'entrée sans sortie préalable
  onDomainEvent('deliveryNote.returned', async (ctx) => {
    const noteId = (ctx.payload as { deliveryNoteId: Types.ObjectId }).deliveryNoteId;
    const bl = await DeliveryNote.findOne({ _id: noteId, companyId: ctx.companyId }).session(ctx.session).lean();
    const index = (bl?.returns ?? []).findIndex((r) => String((r as { _id: unknown })._id) === String(ctx.documentId));
    if (!bl || index < 0) return;
    const ret = bl.returns![index]!;
    let n = 0;
    for (const l of ret.lines) {
      const out = await StockMovement.findOne({ companyId: ctx.companyId, eventKey: `deliveryNote.validated:${bl._id}:${l.lineId}` }).session(ctx.session).lean();
      if (!out) continue; // service, ligne libre ou livraison sans mouvement : aucun stock à réintégrer
      const before = Math.round(bl.returns!.slice(0, index).flatMap((r) => r.lines).filter((x) => String(x.lineId) === String(l.lineId)).reduce((s, x) => s + (x.quantity ?? 0), 0) * 1000) / 1000;
      const r = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: out.productId, warehouseId: ret.warehouseId!, direction: 'in', quantity: l.quantity!, reason: 'customer_return',
        eventKey: `deliveryNote.returned:${ctx.documentId}:${l.lineId}`, source: { type: 'deliveryNote', id: bl._id, number: bl.number }, totalValueMinor: slice(out.valueMinor ?? 0, before, l.quantity!, out.quantity), serials: l.serials ?? undefined, note: ret.reason });
      if (r.movement && !r.duplicate) n++;
    }
    return { movements: n };
  }, 'stock');

  // Réception validée → entrée de stock au coût de la commande (ou au coût rendu pour une importation) ; met à jour le coût de revient
  onDomainEvent('goodsReceipt.validated', async (ctx) => {
    const r = await GoodsReceipt.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session).lean();
    if (!r) return;
    let n = 0;
    for (const l of r.lines) {
      const res = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId, warehouseId: r.warehouseId, direction: 'in', quantity: l.quantity, reason: r.importFileId ? 'import' : 'receipt',
        eventKey: `goodsReceipt.validated:${r._id}:${(l as { _id: unknown })._id}`, source: { type: 'goodsReceipt', id: r._id, number: r.number }, totalValueMinor: l.valueMinor ?? 0, serials: l.serials ?? undefined, touchCost: true,
        costInfo: { purchaseUnitMinor: l.unitCostMinor ?? 0, extraUnitMinor: l.extraUnitCostMinor ?? 0 } });
      if (res.movement && !res.duplicate) n++;
    }
    return { movements: n };
  }, 'stock');

  // Transfert validé → sortie + entrée de même valeur dans la même transaction
  onDomainEvent('stockTransfer.validated', async (ctx) => {
    const t = await StockTransfer.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session);
    if (!t) return;
    let n = 0;
    for (const l of t.lines) {
      const src = { type: 'stockTransfer', id: t._id, number: t.number };
      const out = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId!, warehouseId: t.fromWarehouseId!, direction: 'out', quantity: l.quantity, reason: 'transfer_out',
        eventKey: `stockTransfer.validated:${t._id}:${l._id}:out`, source: src, serials: l.serials });
      if (!out.movement) continue; // service
      const inn = await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId!, warehouseId: t.toWarehouseId!, direction: 'in', quantity: l.quantity, reason: 'transfer_in',
        eventKey: `stockTransfer.validated:${t._id}:${l._id}:in`, source: src, totalValueMinor: out.movement.valueMinor, serials: l.serials });
      l.valueMinor = out.movement.valueMinor; if (!out.duplicate) n += 2; void inn;
    }
    await t.save({ session: ctx.session });
    return { movements: n };
  }, 'stock');

  // Inventaire validé → ajustements des écarts (qté comptée − qté en stock au moment de la validation), valorisés au CMP
  onDomainEvent('inventory.validated', async (ctx) => {
    const inv = await Inventory.findOne({ _id: ctx.documentId, companyId: ctx.companyId }).session(ctx.session);
    if (!inv) return;
    let n = 0;
    for (const l of inv.lines) {
      if (l.countedQty == null) continue;
      const level = await StockLevel.findOne({ companyId: ctx.companyId, productId: l.productId, warehouseId: inv.warehouseId }).session(ctx.session).lean();
      const current = level?.qty ?? 0; const delta = Math.round((l.countedQty - current) * 1000) / 1000;
      l.appliedDelta = delta; if (delta === 0) continue;
      const src = { type: 'inventory', id: inv._id, number: inv.number };
      const key = `inventory.validated:${inv._id}:${l._id}`;
      if (delta < 0) await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId!, warehouseId: inv.warehouseId!, direction: 'out', quantity: -delta, reason: 'inventory_out', eventKey: key, source: src, note: inv.reason ?? undefined });
      else {
        const p = await Product.findById(l.productId).session(ctx.session).lean();
        // Excédent d'inventaire sans stock valorisé : coût réel, sinon prix d'achat au taux RÉEL du jour (jamais le taux estimatif)
        const unit = level && level.qty > 0 ? Math.round(level.valueMinor / level.qty) : (p?.costPriceMinor ?? (p ? await realPurchaseMinor(ctx.companyId, p, inv.date, ctx.session) : 0));
        await applyMovement({ companyId: ctx.companyId, session: ctx.session, userId: ctx.userId, productId: l.productId!, warehouseId: inv.warehouseId!, direction: 'in', quantity: delta, reason: 'inventory_in', eventKey: key, source: src, unitCostMinor: unit, note: inv.reason ?? undefined });
      }
      n++;
    }
    await inv.save({ session: ctx.session });
    return { movements: n };
  }, 'stock');
}
