import { Schema, model, type InferSchemaType } from 'mongoose';
import { PAYMENT_METHODS } from './sales.model.js';

const oid = (ref: string, required = false) => ({ type: Schema.Types.ObjectId, ref, required });
const company = oid('Company', true);

// ---- Trésorerie : comptes (banque / caisse) ----
/** `balanceMinor` = solde courant tenu atomiquement ($inc) ; contrôlé contre ouverture + Σ mouvements. */
const treasuryAccountSchema = new Schema({
  companyId: company, code: { type: String, required: true, trim: true, uppercase: true }, name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['bank', 'cash'], required: true }, bankName: { type: String, trim: true }, iban: { type: String, trim: true },
  /** Code comptable (non inventé : saisi par la société). */
  accountCode: { type: String, trim: true },
  openingBalanceMinor: { type: Number, default: 0 }, balanceMinor: { type: Number, default: 0 },
  allowNegative: { type: Boolean, default: false }, isActive: { type: Boolean, default: true },
  /** Verrou de période : plus aucun mouvement daté ≤ cette date (dernier relevé rapproché). */
  lastReconciledDate: Date, lastReconciledBalanceMinor: Number,
}, { timestamps: true });
treasuryAccountSchema.index({ companyId: 1, code: 1 }, { unique: true });
export type TreasuryAccountDoc = InferSchemaType<typeof treasuryAccountSchema>;
export const TreasuryAccount = model('TreasuryAccount', treasuryAccountSchema);

export const MOVEMENT_KINDS = ['customer_receipt', 'supplier_payment', 'expense', 'transfer', 'reversal'] as const;
/**
 * Mouvement de trésorerie : IMMUABLE (aucune route de modification ; correction = mouvement inverse `reversalOf`).
 * Seuls les marqueurs posés par le système (`reversedById`, `reconciledAt`, `reconciliationId`) évoluent.
 */
const movementSchema = new Schema({
  companyId: company, accountId: oid('TreasuryAccount', true), direction: { type: String, enum: ['in', 'out'], required: true },
  amountMinor: { type: Number, required: true, min: 1 }, date: { type: Date, required: true },
  kind: { type: String, enum: MOVEMENT_KINDS, required: true }, label: { type: String, required: true },
  source: new Schema({ type: String, id: Schema.Types.ObjectId, number: String }, { _id: false }),
  thirdParty: new Schema({ type: { type: String, enum: ['customer', 'supplier'] }, id: Schema.Types.ObjectId, name: String }, { _id: false }),
  method: { type: String, enum: PAYMENT_METHODS }, reference: String,
  balanceAfterMinor: Number, reversalOf: oid('TreasuryMovement'), reversedById: oid('TreasuryMovement'),
  reconciledAt: Date, reconciliationId: oid('BankReconciliation'),
  eventKey: { type: String, required: true }, createdBy: oid('User'),
}, { timestamps: true });
movementSchema.index({ companyId: 1, eventKey: 1 }, { unique: true });
movementSchema.index({ companyId: 1, accountId: 1, date: -1, _id: -1 });
movementSchema.index({ companyId: 1, date: -1 }); // rapports : flux par période
movementSchema.index({ companyId: 1, accountId: 1, reconciledAt: 1 });
movementSchema.index({ companyId: 1, 'source.id': 1 });
export type TreasuryMovementDoc = InferSchemaType<typeof movementSchema>;
export const TreasuryMovement = model('TreasuryMovement', movementSchema);

const transferSchema = new Schema({
  companyId: company, number: { type: String, required: true }, fromAccountId: oid('TreasuryAccount', true), toAccountId: oid('TreasuryAccount', true),
  amountMinor: { type: Number, required: true, min: 1 }, date: { type: Date, required: true }, note: String,
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' }, cancelledAt: Date, cancelledBy: oid('User'), cancelReason: String, createdBy: oid('User'),
}, { timestamps: true });
transferSchema.index({ companyId: 1, number: 1 }, { unique: true });
transferSchema.index({ companyId: 1, date: -1 });
export type TreasuryTransferDoc = InferSchemaType<typeof transferSchema>;
export const TreasuryTransfer = model('TreasuryTransfer', transferSchema);

/** Rapprochement validé (définitif : aucune annulation, les mouvements pointés sont verrouillés). */
const reconciliationSchema = new Schema({
  companyId: company, number: { type: String, required: true }, accountId: oid('TreasuryAccount', true), statementDate: { type: Date, required: true },
  statementBalanceMinor: { type: Number, required: true }, previousBalanceMinor: { type: Number, required: true },
  movementIds: [oid('TreasuryMovement')], totalMinor: { type: Number, required: true }, note: String, createdBy: oid('User'),
}, { timestamps: true });
reconciliationSchema.index({ companyId: 1, number: 1 }, { unique: true });
reconciliationSchema.index({ companyId: 1, accountId: 1, statementDate: -1 });
export type ReconciliationDoc = InferSchemaType<typeof reconciliationSchema>;
export const BankReconciliation = model('BankReconciliation', reconciliationSchema);

// ---- Règlements fournisseurs ----
const supplierPaymentSchema = new Schema({
  companyId: company, number: { type: String, required: true }, supplierId: oid('Supplier', true), supplier: new Schema({ name: String }, { _id: false }),
  treasuryAccountId: oid('TreasuryAccount', true), amountMinor: { type: Number, required: true, min: 1 }, method: { type: String, enum: PAYMENT_METHODS, required: true },
  paidAt: { type: Date, required: true }, reference: String, note: String,
  /** Affectation aux factures d'achat (règlement partiel ou groupé). */
  allocations: [new Schema({ purchaseInvoiceId: oid('PurchaseInvoice', true), number: String, amountMinor: { type: Number, required: true, min: 1 } }, { _id: false })],
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' }, cancelledAt: Date, cancelledBy: oid('User'), cancelReason: String, createdBy: oid('User'),
}, { timestamps: true });
supplierPaymentSchema.index({ companyId: 1, number: 1 }, { unique: true });
supplierPaymentSchema.index({ companyId: 1, supplierId: 1, paidAt: -1 });
supplierPaymentSchema.index({ companyId: 1, status: 1, paidAt: -1 }); // rapports : décaissements par période
supplierPaymentSchema.index({ companyId: 1, 'allocations.purchaseInvoiceId': 1 });
export type SupplierPaymentDoc = InferSchemaType<typeof supplierPaymentSchema>;
export const SupplierPayment = model('SupplierPayment', supplierPaymentSchema);

// ---- Dépenses ----
const expenseCategorySchema = new Schema({ companyId: company, name: { type: String, required: true, trim: true }, accountCode: { type: String, trim: true }, isActive: { type: Boolean, default: true } }, { timestamps: true });
expenseCategorySchema.index({ companyId: 1, name: 1 }, { unique: true });
export type ExpenseCategoryDoc = InferSchemaType<typeof expenseCategorySchema>;
export const ExpenseCategory = model('ExpenseCategory', expenseCategorySchema);

export const EXPENSE_STATUSES = ['draft', 'submitted', 'validated', 'rejected', 'cancelled'] as const;
const expenseSchema = new Schema({
  companyId: company, number: { type: String, required: true }, categoryId: oid('ExpenseCategory', true), categoryName: String, categoryAccountCode: String,
  amountMinor: { type: Number, required: true, min: 1 }, date: { type: Date, required: true }, beneficiary: { type: String, required: true, trim: true },
  method: { type: String, enum: PAYMENT_METHODS, required: true }, reference: { type: String, trim: true }, description: { type: String, trim: true },
  treasuryAccountId: oid('TreasuryAccount'),
  attachments: [new Schema({ originalName: String, storedName: String, ext: String, size: Number, uploadedAt: Date }, { _id: true })],
  status: { type: String, enum: EXPENSE_STATUSES, default: 'draft' },
  createdBy: oid('User'), submittedAt: Date, submittedBy: oid('User'), validatedAt: Date, validatedBy: oid('User'), rejectedAt: Date, rejectedBy: oid('User'), rejectReason: String,
  cancelledAt: Date, cancelledBy: oid('User'), cancelReason: String,
}, { timestamps: true });
expenseSchema.index({ companyId: 1, number: 1 }, { unique: true });
expenseSchema.index({ companyId: 1, status: 1, date: -1 });
expenseSchema.index({ companyId: 1, categoryId: 1, date: -1 });
export type ExpenseDoc = InferSchemaType<typeof expenseSchema>;
export const Expense = model('Expense', expenseSchema);

// ---- Comptabilité de base ----
export const JOURNALS = ['sales', 'purchases', 'cash', 'bank'] as const;
export type Journal = (typeof JOURNALS)[number];
/** Rôles fonctionnels des lignes ; le code comptable (facultatif) vient de la correspondance configurée par la société. */
export const ENTRY_ROLES = ['customer', 'sales', 'vat_collected', 'withholding', 'stamp', 'supplier', 'purchases', 'vat_deductible', 'cash', 'bank', 'expense', 'internal_transfer'] as const;
const entryLineSchema = new Schema({
  role: { type: String, enum: ENTRY_ROLES, required: true }, accountCode: String, label: String, debitMinor: { type: Number, default: 0 }, creditMinor: { type: Number, default: 0 },
  thirdPartyId: Schema.Types.ObjectId, treasuryAccountId: Schema.Types.ObjectId,
}, { _id: false });
/** Écriture : IMMUABLE, équilibrée (Σ débit = Σ crédit), liée à son document source. `eventKey` unique = jamais deux écritures pour un même événement. */
const journalEntrySchema = new Schema({
  companyId: company, journal: { type: String, enum: JOURNALS, required: true }, number: { type: String, required: true }, date: { type: Date, required: true }, label: { type: String, required: true },
  source: new Schema({ type: String, id: Schema.Types.ObjectId, number: String }, { _id: false }), eventKey: { type: String, required: true },
  lines: { type: [entryLineSchema], default: [] }, totalMinor: { type: Number, required: true }, reversal: { type: Boolean, default: false },
}, { timestamps: true });
journalEntrySchema.index({ companyId: 1, eventKey: 1 }, { unique: true });
journalEntrySchema.index({ companyId: 1, journal: 1, number: 1 }, { unique: true });
journalEntrySchema.index({ companyId: 1, journal: 1, date: -1 });
journalEntrySchema.index({ companyId: 1, 'source.id': 1 });
export type JournalEntryDoc = InferSchemaType<typeof journalEntrySchema>;
export const JournalEntry = model('JournalEntry', journalEntrySchema);

/** Paramètres comptables : correspondance rôle → code, option de validation des dépenses. */
const accountingSettingsSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  accounts: { type: Map, of: String, default: {} }, allowExpenseSelfValidation: { type: Boolean, default: false },
}, { timestamps: true });
export type AccountingSettingsDoc = InferSchemaType<typeof accountingSettingsSchema>;
export const AccountingSettings = model('AccountingSettings', accountingSettingsSchema);
