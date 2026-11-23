import type { Types } from 'mongoose';
import { renderDocumentPdf } from '../../services/document-pdf.service.js';

type Any = Record<string, any>;
const RS: Record<string, string> = {};

/** Rend le PDF d'un document à partir de son DTO. Mentions obligatoires : « PROFORMA » sur la facture proforma. */
export async function pdfOf(companyId: Types.ObjectId, kind: 'quotation' | 'proforma' | 'invoice' | 'deliveryNote', d: Any): Promise<Buffer> {
  const common = { customer: d.customer, lines: d.lines, totals: d.totals ?? {}, notes: d.notes, terms: d.terms };
  switch (kind) {
    case 'quotation': return renderDocumentPdf(companyId, { ...common, title: 'DEVIS', number: d.number, date: d.issueDate, secondaryDateLabel: 'Valable jusqu’au', secondaryDate: d.validUntil });
    case 'proforma': return renderDocumentPdf(companyId, { ...common, title: 'FACTURE PROFORMA', mention: 'PROFORMA', number: d.number, date: d.issueDate, secondaryDateLabel: 'Valable jusqu’au', secondaryDate: d.validUntil });
    case 'invoice': return renderDocumentPdf(companyId, { ...common, title: d.type === 'credit_note' ? 'FACTURE D’AVOIR' : 'FACTURE', number: d.number, draft: d.status === 'draft', date: d.issueDate,
      schedule: d.schedule?.length ? d.schedule : undefined, withholdingLabel: d.withholding ? `Retenue à la source ${d.withholding.ratePct} %` : RS['x'],
      ...(d.creditReason && { extra: [['Motif', d.creditReason]] as [string, string][] }) });
    case 'deliveryNote': return renderDocumentPdf(companyId, { ...common, title: 'BON DE LIVRAISON', number: d.number, date: d.deliveryDate, showPrices: false,
      ...(d.carrier && { extra: [['Transporteur', d.carrier]] as [string, string][] }), ...(d.source && { secondaryDateLabel: 'Réf. source', secondaryDate: null }) });
  }
}
