import { Customer } from '../../models/customer.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation } from '../../models/sales.model.js';
import { registerReferenceCheck } from '../../services/reference-guard.js';
import { Supplier } from '../../models/supplier.model.js';

void Customer; void Supplier;
/** Protection de l'intégrité : un client / article référencé par un document commercial ne peut pas être supprimé (archivage / désactivation à la place). */
export function registerSalesReferences() {
  registerReferenceCheck('customer', async (companyId, id) => {
    const [q, p, i, d] = await Promise.all([Quotation.countDocuments({ companyId, customerId: id }), Proforma.countDocuments({ companyId, customerId: id }), Invoice.countDocuments({ companyId, customerId: id }), DeliveryNote.countDocuments({ companyId, customerId: id })]);
    const parts = [q && `${q} devis`, p && `${p} proforma(s)`, i && `${i} facture(s)/avoir(s)`, d && `${d} bon(s) de livraison`].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  });
  registerReferenceCheck('product', async (companyId, id) => {
    const [q, p, i, d] = await Promise.all([Quotation.exists({ companyId, 'lines.productId': id }), Proforma.exists({ companyId, 'lines.productId': id }), Invoice.exists({ companyId, 'lines.productId': id }), DeliveryNote.exists({ companyId, 'lines.productId': id })]);
    return q || p || i || d ? 'l’article figure dans des documents commerciaux' : null;
  });
}
