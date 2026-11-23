import { GoodsReceipt, ImportFile, Inventory, PurchaseInvoice, PurchaseOrder, StockLevel, StockMovement, StockTransfer } from '../../models/logistics.model.js';
import { registerReferenceCheck } from '../../services/reference-guard.js';

/** Intégrité : fournisseurs / articles référencés par les achats, importations, stock. */
export function registerLogisticsReferences() {
  registerReferenceCheck('supplier', async (companyId, id) => {
    const [o, r, i, f] = await Promise.all([PurchaseOrder.exists({ companyId, supplierId: id }), GoodsReceipt.exists({ companyId, supplierId: id }), PurchaseInvoice.exists({ companyId, supplierId: id }), ImportFile.exists({ companyId, supplierId: id })]);
    return o || r || i || f ? 'le fournisseur est utilisé par des commandes, réceptions, factures d’achat ou importations' : null;
  });
  registerReferenceCheck('product', async (companyId, id) => {
    const [m, l, o, i, t, inv, f] = await Promise.all([StockMovement.exists({ companyId, productId: id }), StockLevel.exists({ companyId, productId: id, qty: { $ne: 0 } }), PurchaseOrder.exists({ companyId, 'lines.productId': id }),
      PurchaseInvoice.exists({ companyId, 'lines.productId': id }), StockTransfer.exists({ companyId, 'lines.productId': id }), Inventory.exists({ companyId, 'lines.productId': id }), ImportFile.exists({ companyId, 'lines.productId': id })]);
    return m || l || o || i || t || inv || f ? 'l’article a des mouvements de stock ou figure dans des documents d’achat / stock' : null;
  });
}
