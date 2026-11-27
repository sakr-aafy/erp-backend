import { Schema, model, type InferSchemaType } from 'mongoose';
import { lineSchema, totalsSchema } from './sales.model.js';
import { addressSnapshotSchema } from '../modules/parties/delivery-address.js';

const oid = (ref: string, required = false) => ({ type: Schema.Types.ObjectId, ref, required });
const company = oid('Company', true);

// ---- Magasins et stock ----
const warehouseSchema = new Schema({
  companyId: company, code: { type: String, required: true, trim: true, uppercase: true }, name: { type: String, required: true, trim: true }, address: { type: String, trim: true },
  isDefault: { type: Boolean, default: false }, isActive: { type: Boolean, default: true },
}, { timestamps: true });
warehouseSchema.index({ companyId: 1, code: 1 }, { unique: true });
export type WarehouseDoc = InferSchemaType<typeof warehouseSchema>;
export const Warehouse = model('Warehouse', warehouseSchema);

/** Niveau de stock par article et magasin. CMP = valueMinor / qty (valeur totale entière : pas de dérive d'arrondi). */
const stockLevelSchema = new Schema({ companyId: company, productId: oid('Product', true), warehouseId: oid('Warehouse', true), qty: { type: Number, default: 0 }, valueMinor: { type: Number, default: 0 } }, { timestamps: true });
stockLevelSchema.index({ companyId: 1, productId: 1, warehouseId: 1 }, { unique: true });
stockLevelSchema.index({ companyId: 1, warehouseId: 1 });
export type StockLevelDoc = InferSchemaType<typeof stockLevelSchema>;
export const StockLevel = model('StockLevel', stockLevelSchema);

export const MOVEMENT_REASONS = ['receipt', 'import', 'delivery', 'delivery_cancel', 'transfer_out', 'transfer_in', 'inventory_in', 'inventory_out', 'manual_in', 'manual_out'] as const;
/** Mouvement de stock : IMMUABLE (aucune route de modification ; correction = mouvement inverse). `eventKey` unique = idempotence. */
const movementSchema = new Schema({
  companyId: company, productId: oid('Product', true), warehouseId: oid('Warehouse', true), direction: { type: String, enum: ['in', 'out'], required: true },
  reason: { type: String, enum: MOVEMENT_REASONS, required: true }, quantity: { type: Number, required: true }, unitCostMinor: { type: Number, default: 0 }, valueMinor: { type: Number, default: 0 },
  qtyBefore: Number, qtyAfter: Number, valueBefore: Number, valueAfter: Number,
  source: new Schema({ type: String, id: Schema.Types.ObjectId, number: String }, { _id: false }), serials: [String], note: String, forced: { type: Boolean, default: false },
  eventKey: { type: String, required: true }, userId: oid('User'),
}, { timestamps: { createdAt: true, updatedAt: false } });
movementSchema.index({ companyId: 1, eventKey: 1 }, { unique: true });
movementSchema.index({ companyId: 1, productId: 1, createdAt: -1 });
movementSchema.index({ companyId: 1, warehouseId: 1, createdAt: -1 });
movementSchema.index({ companyId: 1, createdAt: -1 }); // rapports : mouvements par période
movementSchema.index({ companyId: 1, 'source.id': 1 });
export type MovementDoc = InferSchemaType<typeof movementSchema>;
export const StockMovement = model('StockMovement', movementSchema);

/** Journal des traitements d'événements : idempotence (clé unique) + traçabilité des succès et des échecs (reprise). */
const eventLogSchema = new Schema({
  companyId: company, event: { type: String, required: true }, documentId: { type: Schema.Types.ObjectId, required: true }, handler: { type: String, required: true }, key: { type: String, required: true },
  status: { type: String, enum: ['processed', 'failed'], required: true }, attempts: { type: Number, default: 0 }, error: String, movements: { type: Number, default: 0 }, payload: Schema.Types.Mixed, processedAt: Date,
  documentNumber: String,
}, { timestamps: true });
eventLogSchema.index({ companyId: 1, key: 1 }, { unique: true });
eventLogSchema.index({ companyId: 1, status: 1, updatedAt: -1 });
export type EventLogDoc = InferSchemaType<typeof eventLogSchema>;
export const EventLog = model('EventLog', eventLogSchema);

// ---- Achats ----
const purchaseLineSchema = new Schema({
  productId: oid('Product'), reference: String, designation: { type: String, required: true }, unit: String, quantity: { type: Number, required: true }, unitPriceMinor: { type: Number, required: true, min: 0 }, discountPct: { type: Number, default: 0 },
  vat: lineSchema.path('vat').schema ?? new Schema({ ruleId: oid('FiscalRule'), code: String, regime: String, ratePct: Number }, { _id: false }),
  grossMinor: Number, discountMinor: Number, netHtMinor: Number, globalShareMinor: { type: Number, default: 0 }, receivedQty: { type: Number, default: 0 }, receivedValueMinor: { type: Number, default: 0 }, invoicedQty: { type: Number, default: 0 },
  orderLineId: Schema.Types.ObjectId,
}, { _id: true });
const supplierSnapshot = new Schema({ name: String, taxId: String }, { _id: false });
/** Adresse de réception de l'entreprise (magasin), copiée sur la commande et la réception. */
const receivingSnapshot = new Schema({ warehouseId: oid('Warehouse'), code: String, name: String, address: String }, { _id: false });
const purchaseAddresses = { supplierAddress: { type: addressSnapshotSchema }, receivingAddress: { type: receivingSnapshot } };

const purchaseOrderSchema = new Schema({
  ...purchaseAddresses, companyId: company, number: { type: String, required: true }, supplierId: oid('Supplier', true), supplier: supplierSnapshot, orderDate: { type: Date, required: true }, expectedDate: Date,
  status: { type: String, enum: ['draft', 'confirmed', 'partially_received', 'received', 'cancelled'], default: 'draft' },
  lines: [purchaseLineSchema], totals: { type: totalsSchema, required: true }, notes: String,
  /** Conditions de paiement convenues, copiées de la fiche fournisseur à la création (modifiables en brouillon). */
  paymentTerms: String, createdBy: oid('User'), confirmedAt: Date, cancelledAt: Date, cancelReason: String,
}, { timestamps: true });
purchaseOrderSchema.index({ companyId: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ companyId: 1, status: 1, orderDate: -1 });
purchaseOrderSchema.index({ companyId: 1, supplierId: 1 });
purchaseOrderSchema.index({ companyId: 1, 'lines.productId': 1 });
export type PurchaseOrderDoc = InferSchemaType<typeof purchaseOrderSchema>;
export const PurchaseOrder = model('PurchaseOrder', purchaseOrderSchema);

const receiptLineSchema = new Schema({ orderLineId: Schema.Types.ObjectId, importLineId: Schema.Types.ObjectId, productId: oid('Product', true), designation: String, quantity: { type: Number, required: true },
  unitCostMinor: { type: Number, default: 0 }, extraUnitCostMinor: { type: Number, default: 0 }, valueMinor: { type: Number, default: 0 }, serials: [String] }, { _id: true });
const goodsReceiptSchema = new Schema({
  ...purchaseAddresses, companyId: company, number: { type: String, required: true }, purchaseOrderId: oid('PurchaseOrder'), importFileId: oid('ImportFile'), supplierId: oid('Supplier', true), supplier: supplierSnapshot,
  warehouseId: oid('Warehouse', true), receiptDate: { type: Date, required: true }, status: { type: String, enum: ['draft', 'validated'], default: 'draft' }, lines: [receiptLineSchema], notes: String,
  deliveryNoteRef: String, createdBy: oid('User'), validatedAt: Date, validatedBy: oid('User'),
}, { timestamps: true });
goodsReceiptSchema.index({ companyId: 1, number: 1 }, { unique: true });
goodsReceiptSchema.index({ companyId: 1, purchaseOrderId: 1 });
goodsReceiptSchema.index({ companyId: 1, importFileId: 1 });
goodsReceiptSchema.index({ companyId: 1, 'lines.productId': 1 });
export type GoodsReceiptDoc = InferSchemaType<typeof goodsReceiptSchema>;
export const GoodsReceipt = model('GoodsReceipt', goodsReceiptSchema);

const purchaseInvoiceSchema = new Schema({
  companyId: company, number: String, supplierInvoiceNumber: { type: String, required: true, trim: true }, supplierId: oid('Supplier', true), supplier: supplierSnapshot, purchaseOrderId: oid('PurchaseOrder'),
  invoiceDate: { type: Date, required: true }, dueDate: Date, status: { type: String, enum: ['draft', 'validated'], default: 'draft' }, lines: [purchaseLineSchema], totals: { type: totalsSchema, required: true },
  /** Écarts constatés à la validation (prix / quantités vs commande et réceptions). */
  variances: [new Schema({ lineId: Schema.Types.ObjectId, type: String, message: String, ordered: Number, received: Number, invoiced: Number, orderPriceMinor: Number, invoicePriceMinor: Number }, { _id: false })],
  paidMinor: { type: Number, default: 0 }, paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid' },
  notes: String, createdBy: oid('User'), validatedAt: Date, validatedBy: oid('User'),
}, { timestamps: true });
purchaseInvoiceSchema.index({ companyId: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
purchaseInvoiceSchema.index({ companyId: 1, supplierId: 1, supplierInvoiceNumber: 1 }, { unique: true });
purchaseInvoiceSchema.index({ companyId: 1, status: 1, invoiceDate: -1 });
purchaseInvoiceSchema.index({ companyId: 1, 'lines.productId': 1 });
export type PurchaseInvoiceDoc = InferSchemaType<typeof purchaseInvoiceSchema>;
export const PurchaseInvoice = model('PurchaseInvoice', purchaseInvoiceSchema);

// ---- Transferts et inventaires ----
const transferSchema = new Schema({
  companyId: company, number: { type: String, required: true }, fromWarehouseId: oid('Warehouse', true), toWarehouseId: oid('Warehouse', true), date: { type: Date, required: true },
  status: { type: String, enum: ['draft', 'validated'], default: 'draft' }, lines: [new Schema({ productId: oid('Product', true), designation: String, quantity: { type: Number, required: true }, serials: [String], valueMinor: { type: Number, default: 0 } }, { _id: true })],
  notes: String, createdBy: oid('User'), validatedAt: Date, validatedBy: oid('User'),
}, { timestamps: true });
transferSchema.index({ companyId: 1, number: 1 }, { unique: true });
transferSchema.index({ companyId: 1, status: 1, date: -1 });
export type TransferDoc = InferSchemaType<typeof transferSchema>;
export const StockTransfer = model('StockTransfer', transferSchema);

const inventorySchema = new Schema({
  companyId: company, number: { type: String, required: true }, warehouseId: oid('Warehouse', true), status: { type: String, enum: ['draft', 'validated'], default: 'draft' }, date: { type: Date, required: true },
  lines: [new Schema({ productId: oid('Product', true), designation: String, reference: String, systemQty: { type: Number, default: 0 }, countedQty: { type: Number, default: null }, appliedDelta: { type: Number, default: 0 } }, { _id: true })],
  reason: String, notes: String, createdBy: oid('User'), validatedAt: Date, validatedBy: oid('User'),
}, { timestamps: true });
inventorySchema.index({ companyId: 1, number: 1 }, { unique: true });
inventorySchema.index({ companyId: 1, warehouseId: 1, status: 1 });
export type InventoryDoc = InferSchemaType<typeof inventorySchema>;
export const Inventory = model('Inventory', inventorySchema);

// ---- Importations ----
export const CHARGE_TYPES = ['freight', 'customs_duty', 'customs_fees', 'transit', 'insurance', 'other'] as const;
export const IMPORT_STATUSES = ['draft', 'ordered', 'shipped', 'customs', 'arrived', 'closed', 'integrated', 'cancelled'] as const;
const importFileSchema = new Schema({
  companyId: company, number: { type: String, required: true }, supplierId: oid('Supplier', true), supplier: supplierSnapshot, currency: { type: String, required: true, uppercase: true },
  exchangeRate: { type: Number, required: true }, exchangeRateDate: { type: Date, required: true }, orderDate: { type: Date, required: true }, reference: String,
  status: { type: String, enum: IMPORT_STATUSES, default: 'draft' },
  lines: [new Schema({ productId: oid('Product', true), reference: String, designation: String, quantity: { type: Number, required: true }, unitPriceMinor: { type: Number, required: true, min: 0 }, // en devise étrangère (plus petite unité)
    fobBaseMinor: { type: Number, default: 0 }, allocatedChargesMinor: { type: Number, default: 0 }, landedTotalMinor: { type: Number, default: 0 }, unitLandedMinor: { type: Number, default: 0 }, serials: [String],
    /** Valeurs douanières et logistiques de l'article À LA DATE d'ajout au dossier (instantané : une modification ultérieure de l'article ne change jamais un dossier). */
    customs: { type: new Schema({ supplierHsCode: String, tnHsCode: String, ddPct: Number, fodecPct: Number, rpdPct: Number, originCountry: String, provenanceCountry: String, specialRegulation: String, vatRateCode: String, capturedAt: Date }, { _id: false }) },
    packaging: { type: new Schema({ unitVolumeM3: Number, unitNetWeightKg: Number, unitGrossWeightKg: Number, packagingType: String, parcelCount: Number }, { _id: false }) } }, { _id: true })],
  charges: [new Schema({ type: { type: String, enum: CHARGE_TYPES, required: true }, label: String, amountMinor: { type: Number, required: true, min: 0 }, currency: { type: String, uppercase: true, required: true }, exchangeRate: { type: Number, required: true },
    rateDate: Date, amountBaseMinor: { type: Number, default: 0 }, allocation: { type: String, enum: ['value', 'quantity'], default: 'value' }, date: Date }, { _id: true })],
  documents: [new Schema({ name: { type: String, required: true }, kind: { type: String, default: 'other' }, status: { type: String, enum: ['pending', 'received'], default: 'pending' }, fileName: String, storedName: String, mime: String, size: Number, uploadedAt: Date }, { _id: true })],
  totals: new Schema({ fobBaseMinor: { type: Number, default: 0 }, chargesBaseMinor: { type: Number, default: 0 }, landedMinor: { type: Number, default: 0 } }, { _id: false }),
  warehouseId: oid('Warehouse'), receiptId: oid('GoodsReceipt'), notes: String, createdBy: oid('User'), closedAt: Date, integratedAt: Date, cancelledAt: Date,
}, { timestamps: true });
importFileSchema.index({ companyId: 1, number: 1 }, { unique: true });
importFileSchema.index({ companyId: 1, status: 1, orderDate: -1 });
importFileSchema.index({ companyId: 1, supplierId: 1 });
importFileSchema.index({ companyId: 1, 'lines.productId': 1 });
export type ImportFileDoc = InferSchemaType<typeof importFileSchema>;
export const ImportFile = model('ImportFile', importFileSchema);

const exchangeRateSchema = new Schema({ companyId: company, currency: { type: String, required: true, uppercase: true }, date: { type: Date, required: true }, rate: { type: Number, required: true, min: 0 }, source: String }, { timestamps: true });
exchangeRateSchema.index({ companyId: 1, currency: 1, date: -1 }, { unique: true });
export const ExchangeRate = model('ExchangeRate', exchangeRateSchema);

// ---- Coût de revient ----
export const COST_REASONS = ['goods_receipt', 'import_integration', 'manual_recalculation', 'initial'] as const;
const costHistorySchema = new Schema({
  companyId: company, productId: oid('Product', true), at: { type: Date, default: Date.now }, previousCostMinor: Number, newCostMinor: { type: Number, required: true },
  purchaseUnitCostMinor: { type: Number, default: 0 }, extraUnitCostMinor: { type: Number, default: 0 }, quantity: Number, reason: { type: String, enum: COST_REASONS, required: true }, justification: String,
  source: new Schema({ type: String, id: Schema.Types.ObjectId, number: String }, { _id: false }), userId: oid('User'),
});
costHistorySchema.index({ companyId: 1, productId: 1, at: -1 });
costHistorySchema.index({ companyId: 1, at: -1 }); // rapports : historique de valorisation par période
export type CostHistoryDoc = InferSchemaType<typeof costHistorySchema>;
export const CostHistory = model('CostHistory', costHistorySchema);
