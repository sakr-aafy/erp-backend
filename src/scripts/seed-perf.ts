/**
 * Jeu de données SYNTHÉTIQUE de volume, pour mesurer les performances (rapports, listes, recherche) et contrôler l'interface avec des données.
 * Il n'est JAMAIS exécuté contre une base réelle : le nom de la base doit contenir « perf », « e2e », « test » ou « demo » et NODE_ENV ≠ production.
 * Les documents sont insérés directement (sans passer par les services) : ils servent à mesurer les LECTURES, pas à tester les règles métier.
 * Usage : MONGO_URI='mongodb://127.0.0.1:27017/erp_perf?replicaSet=rs0' npm run db:seed-perf -- [facteur] [--reset]   (facteur 1 = ~20 000 factures)
 */
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { Category, Product, Unit } from '../models/product.model.js';
import { Customer } from '../models/customer.model.js';
import { Supplier } from '../models/supplier.model.js';
import { FiscalRule } from '../models/fiscal-rule.model.js';
import { Invoice, Payment, Quotation } from '../models/sales.model.js';
import { ExchangeRate, ImportFile, PurchaseInvoice, StockLevel, StockMovement, Warehouse } from '../models/logistics.model.js';
import { Expense, ExpenseCategory, TreasuryAccount, TreasuryMovement } from '../models/finance.model.js';
import { AuditLog } from '../models/audit-log.model.js';
import { User } from '../models/user.model.js';
import { createCompanyWithAdmin } from '../modules/companies/company.service.js';

const dbName = new URL(env.MONGO_URI.replace('mongodb://', 'http://')).pathname.slice(1);
if (env.NODE_ENV === 'production' || !/perf|e2e|test|demo/i.test(dbName)) { console.error(`Refus : la base « ${dbName} » n'est pas une base de test/performance (NODE_ENV=${env.NODE_ENV}).`); process.exit(1); }
const F = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 1) || 1; const RESET = process.argv.includes('--reset');
let s = 42; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!; const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const DAY = 86_400_000; const now = Date.now(); const dayAgo = (n: number) => new Date(Math.floor((now - n * DAY) / DAY) * DAY);
const batch = async <T,>(rows: T[], insert: (b: T[]) => Promise<unknown>, size = 2000) => { for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size)); };
const t0 = Date.now(); const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);

await connectDb(); if (RESET) { await mongoose.connection.dropDatabase(); log(`base « ${dbName} » vidée (--reset)`); } for (const m of Object.values(mongoose.models)) await m.syncIndexes();
const email = 'perf@example.com';
if (await User.exists({ email })) { console.error('Base déjà initialisée (utilisateur perf@example.com existe) : videz la base de test avant de relancer.'); process.exit(1); }
const { company, user } = await createCompanyWithAdmin({ company: { name: 'Société de test (volume)' }, admin: { name: 'Admin Perf', username: 'admin', email, password: 'Perf#Pass2026xy', isPlatformAdmin: true } });
await User.updateOne({ _id: user._id }, { mustChangePassword: false }); const companyId = company._id;
await FiscalRule.create({ companyId, kind: 'vat', code: 'T19', effectiveFrom: new Date('2000-01-01'), status: 'validated', validatedAt: new Date(), active: true, vat: { regime: 'taxable', ratePct: 19 } });
const unit = await Unit.create({ companyId, code: 'PCE', name: 'Pièce' });
const cats = await Category.insertMany(Array.from({ length: 20 }, (_, i) => ({ companyId, name: `Catégorie ${i + 1}` })));
const customers = await Customer.insertMany(Array.from({ length: 1000 * F }, (_, i) => ({ companyId, name: `Client ${String(i + 1).padStart(4, '0')}`, taxId: `C${i + 1}`, isActive: true })), { ordered: false });
const suppliers = await Supplier.insertMany(Array.from({ length: 100 }, (_, i) => ({ companyId, name: `Fournisseur ${i + 1}`, taxId: `S${i + 1}` })), { ordered: false });
const products = await Product.insertMany(Array.from({ length: 3000 * F }, (_, i) => ({ companyId, reference: `ART-${String(i + 1).padStart(5, '0')}`, name: `Article ${i + 1}`, categoryId: pick(cats)._id, unitId: unit._id, purchasePriceMinor: int(1, 80) * 1000, salePriceMinor: int(90, 300) * 1000,
  costPriceMinor: int(1, 80) * 1000, vatRateCode: 'T19', minStock: int(0, 20), isActive: true })), { ordered: false });
const whs = await Warehouse.insertMany([{ companyId, code: 'WH1', name: 'Principal', isDefault: true }, { companyId, code: 'WH2', name: 'Secondaire' }]);
log(`référentiels : ${customers.length} clients, ${products.length} articles, ${suppliers.length} fournisseurs`);

// Factures validées (+ avoirs 3 %) avec échéancier, encaissements partiels
const vat = { code: 'T19', regime: 'taxable', ratePct: 19 }; const invoices: object[] = []; const payments: object[] = [];
for (let i = 0; i < 20000 * F; i++) {
  const c = pick(customers); const d = dayAgo(int(0, 540)); const nl = int(1, 5); const credit = rnd() < 0.03; let ht = 0;
  const lines = Array.from({ length: nl }, () => { const p = pick(products); const q = int(1, 10); const net = q * p.salePriceMinor!; ht += net; return { _id: new Types.ObjectId(), productId: p._id, reference: p.reference, designation: p.name, kind: 'product', quantity: q, unitPriceMinor: p.salePriceMinor, discountPct: 0, vat, grossMinor: net, discountMinor: 0, netHtMinor: net, globalShareMinor: 0 }; });
  const vatM = Math.round(ht * 0.19); const ttc = ht + vatM; const paid = credit ? 0 : rnd() < 0.6 ? ttc : rnd() < 0.5 ? Math.round(ttc / 2) : 0; const _id = new Types.ObjectId();
  invoices.push({ _id, companyId, customerId: c._id, customerSnapshot: { name: c.name }, type: credit ? 'credit_note' : 'invoice', number: `${credit ? 'AV' : 'FAC'}-${d.getUTCFullYear()}-${String(i + 1).padStart(6, '0')}`, status: 'validated', issueDate: d, createdBy: user._id,
    lines, totals: { grossMinor: ht, totalHtMinor: ht, totalVatMinor: vatM, totalTtcMinor: ttc, totalPayableMinor: ttc, vatGroups: [{ vatCode: 'T19', regime: 'taxable', ratePct: 19, baseMinor: ht, vatMinor: vatM }] },
    schedule: credit ? [] : [{ _id: new Types.ObjectId(), dueDate: new Date(d.getTime() + 30 * DAY), percent: 100, amountMinor: ttc, paidMinor: paid, creditedMinor: 0 }], paidMinor: paid, creditedMinor: 0, paymentStatus: credit || paid >= ttc ? 'paid' : paid > 0 ? 'partial' : 'unpaid', validatedAt: d });
  if (paid > 0) payments.push({ companyId, invoiceId: _id, customerId: c._id, amountMinor: paid, method: pick(['cash', 'check', 'transfer', 'card']), paidAt: new Date(d.getTime() + int(0, 40) * DAY), status: 'active' });
}
await batch(invoices, (b) => Invoice.collection.insertMany(b as never[], { ordered: false })); await batch(payments, (b) => Payment.collection.insertMany(b as never[], { ordered: false })); log(`${invoices.length} factures/avoirs, ${payments.length} encaissements`);
await batch(Array.from({ length: 5000 * F }, (_, i) => { const c = pick(customers); const ht = int(1, 500) * 1000; const d = dayAgo(int(0, 540)); return { companyId, customerId: c._id, customerSnapshot: { name: c.name }, number: `DEV-${d.getUTCFullYear()}-${String(i + 1).padStart(6, '0')}`, issueDate: d, validUntil: new Date(d.getTime() + 30 * DAY),
  status: pick(['pending', 'accepted', 'refused', 'expired']), lines: [], totals: { totalHtMinor: ht, totalTtcMinor: Math.round(ht * 1.19) } }; }), (b) => Quotation.collection.insertMany(b as never[], { ordered: false }));
// Stock : niveaux + mouvements
const levels = products.flatMap((p) => whs.map((w) => { const q = int(0, 200); return { companyId, productId: p._id, warehouseId: w._id, qty: q, valueMinor: q * (p.costPriceMinor ?? 0) }; }));
await batch(levels, (b) => StockLevel.collection.insertMany(b as never[], { ordered: false }));
await batch(Array.from({ length: 60000 * F }, (_, i) => { const p = pick(products); const q = int(1, 20); const dir = rnd() < 0.5 ? 'in' : 'out'; return { companyId, productId: p._id, warehouseId: pick(whs)._id, direction: dir, reason: dir === 'in' ? pick(['receipt', 'manual_in', 'inventory_in']) : pick(['delivery', 'manual_out', 'inventory_out']),
  quantity: q, unitCostMinor: p.costPriceMinor, valueMinor: q * (p.costPriceMinor ?? 0), eventKey: `perf:${i}`, createdAt: dayAgo(int(0, 540)) }; }), (b) => StockMovement.collection.insertMany(b as never[], { ordered: false })); log('stock : niveaux et mouvements');
// Achats, importations, dépenses, trésorerie
await batch(Array.from({ length: 5000 * F }, (_, i) => { const sp = pick(suppliers); const ht = int(1, 800) * 1000; const ttc = Math.round(ht * 1.19); const d = dayAgo(int(0, 540)); const paid = rnd() < 0.6 ? ttc : 0;
  return { companyId, number: `FA-${d.getUTCFullYear()}-${String(i + 1).padStart(6, '0')}`, supplierInvoiceNumber: `F${i + 1}`, supplierId: sp._id, supplier: { name: sp.name }, invoiceDate: d, dueDate: new Date(d.getTime() + 45 * DAY), status: 'validated', lines: [],
    totals: { totalHtMinor: ht, totalVatMinor: ttc - ht, totalTtcMinor: ttc }, paidMinor: paid, paymentStatus: paid ? 'paid' : 'unpaid' }; }), (b) => PurchaseInvoice.collection.insertMany(b as never[], { ordered: false }));
await ExchangeRate.insertMany(Array.from({ length: 400 }, (_, i) => ({ companyId, currency: 'EUR', date: dayAgo(i), rate: 3.2 + rnd() / 2 })), { ordered: false });
await batch(Array.from({ length: 300 * F }, (_, i) => { const sp = pick(suppliers); const fob = int(100, 9000) * 1000; const ch = Math.round(fob * 0.12); const d = dayAgo(int(0, 540)); return { companyId, number: `IMP-${d.getUTCFullYear()}-${String(i + 1).padStart(6, '0')}`, supplierId: sp._id, supplier: { name: sp.name }, currency: 'EUR', exchangeRate: 3.4, exchangeRateDate: d, orderDate: d,
  status: pick(['ordered', 'closed', 'integrated']), lines: [], charges: [{ type: 'freight', amountMinor: ch, currency: 'EUR', exchangeRate: 3.4, amountBaseMinor: ch, allocation: 'value' }], documents: [], totals: { fobBaseMinor: fob, chargesBaseMinor: ch, landedMinor: fob + ch } }; }), (b) => ImportFile.collection.insertMany(b as never[], { ordered: false }));
const ecs = await ExpenseCategory.insertMany(['Loyer', 'Électricité', 'Transport', 'Fournitures', 'Salaires', 'Divers'].map((name) => ({ companyId, name })));
const accs = await TreasuryAccount.insertMany([{ companyId, code: 'BNK1', name: 'Banque 1', type: 'bank', openingBalanceMinor: 5_000_000, balanceMinor: 5_000_000 }, { companyId, code: 'CAI1', name: 'Caisse', type: 'cash' }]);
await batch(Array.from({ length: 5000 * F }, (_, i) => { const d = dayAgo(int(0, 540)); const ec = pick(ecs); return { companyId, number: `DEP-${d.getUTCFullYear()}-${String(i + 1).padStart(6, '0')}`, categoryId: ec._id, categoryName: ec.name, amountMinor: int(1, 400) * 1000, date: d, beneficiary: 'Bénéficiaire', method: 'transfer', treasuryAccountId: accs[0]!._id, status: 'validated', attachments: [] }; }), (b) => Expense.collection.insertMany(b as never[], { ordered: false }));
await batch(Array.from({ length: 20000 * F }, (_, i) => ({ companyId, accountId: pick(accs)._id, direction: rnd() < 0.55 ? 'in' : 'out', amountMinor: int(1, 900) * 1000, date: dayAgo(int(0, 540)), kind: pick(['customer_receipt', 'supplier_payment', 'expense']), label: 'Mouvement', eventKey: `perf:tm:${i}` })), (b) => TreasuryMovement.collection.insertMany(b as never[], { ordered: false }));
await batch(Array.from({ length: 20000 * F }, () => ({ companyId, userId: user._id, userName: 'Admin Perf', action: pick(['create', 'update', 'validate', 'export']), resource: pick(['invoice', 'customer', 'expense']), success: true, at: dayAgo(int(0, 540)) })), (b) => AuditLog.collection.insertMany(b as never[], { ordered: false }));
log(`terminé — connexion : ${email} / Perf#Pass2026xy (base ${dbName})`);
await disconnectDb();
