/**
 * Plans d'exécution (explain « executionStats ») des requêtes de lecture critiques : repère les parcours complets (COLLSCAN)
 * et les index manquants. À lancer sur la base de volume (garde-fou identique à seed-perf).
 * Usage : MONGO_URI='mongodb://…/erp_perf?replicaSet=rs0' npm run perf:explain
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import '../models/index.js';
import { AuditLog } from '../models/audit-log.model.js';
import { Company } from '../models/company.model.js';
import { Invoice, Payment, Quotation } from '../models/sales.model.js';
import { CostHistory, ImportFile, PurchaseInvoice, StockMovement } from '../models/logistics.model.js';
import { Expense, SupplierPayment, TreasuryMovement } from '../models/finance.model.js';
import { Customer } from '../models/customer.model.js';
import { Product } from '../models/product.model.js';

const dbName = new URL(env.MONGO_URI.replace('mongodb://', 'http://')).pathname.slice(1);
if (env.NODE_ENV === 'production' || !/perf|e2e|test|demo/i.test(dbName)) { console.error('Refus : base non dédiée aux tests.'); process.exit(1); }
await connectDb(); const companyId = (await Company.findOne({}).lean())!._id;
const from = new Date(Date.now() - 365 * 86_400_000); const to = new Date();
interface Stage { stage?: string; indexName?: string; inputStage?: Stage; inputStages?: Stage[] }
const walk = (s: Stage | undefined, acc: { stages: string[]; index?: string }) => { if (!s) return; if (s.stage) acc.stages.push(s.stage); if (s.indexName) acc.index = s.indexName; walk(s.inputStage, acc); (s.inputStages ?? []).forEach((x) => walk(x, acc)); };
const rows: string[] = []; let bad = 0;
async function check(name: string, run: () => Promise<{ executionStats?: { nReturned?: number; totalDocsExamined?: number; totalKeysExamined?: number; executionTimeMillis?: number }; queryPlanner?: { winningPlan?: Stage }; stages?: unknown[] }>) {
  const r = (await run()) as never as { executionStats?: { nReturned?: number; totalDocsExamined?: number; totalKeysExamined?: number; executionTimeMillis?: number }; queryPlanner?: { winningPlan?: Stage }; stages?: { $cursor?: { executionStats?: never; queryPlanner?: { winningPlan?: Stage } } }[] };
  const cur = r.stages?.[0]?.$cursor as { executionStats?: { nReturned?: number; totalDocsExamined?: number; totalKeysExamined?: number; executionTimeMillis?: number }; queryPlanner?: { winningPlan?: Stage } } | undefined;
  const es = r.executionStats ?? cur?.executionStats; const wp = r.queryPlanner?.winningPlan ?? cur?.queryPlanner?.winningPlan; const acc = { stages: [] as string[], index: undefined as string | undefined }; walk(wp, acc);
  const scan = acc.stages.includes('COLLSCAN'); const ratio = (es?.nReturned ?? 0) ? (es?.totalDocsExamined ?? 0) / (es?.nReturned ?? 1) : (es?.totalDocsExamined ?? 0);
  const flag = scan ? 'COLLSCAN' : ratio > 20 && (es?.totalDocsExamined ?? 0) > 2000 ? 'à surveiller' : 'OK'; if (flag !== 'OK') bad++;
  rows.push(`| ${name} | ${acc.index ?? '—'} | ${es?.totalKeysExamined ?? '—'} | ${es?.totalDocsExamined ?? '—'} | ${es?.nReturned ?? '—'} | ${es?.executionTimeMillis ?? '—'} | ${flag} |`);
}
const m = { companyId };
await check('factures validées de la période (ventes)', () => Invoice.find({ ...m, status: 'validated', issueDate: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('factures impayées (liste)', () => Invoice.find({ ...m, type: 'invoice', paymentStatus: { $ne: 'paid' }, status: 'validated' }).sort({ issueDate: -1 }).limit(20).explain('executionStats') as never);
await check('encaissements par date (sans client)', () => Payment.find({ ...m, status: 'active', paidAt: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('devis par date d’émission', () => Quotation.find({ ...m, issueDate: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('mouvements de stock par période', () => StockMovement.find({ ...m, createdAt: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('mouvements de trésorerie par période', () => TreasuryMovement.find({ ...m, date: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('règlements fournisseurs par date', () => SupplierPayment.find({ ...m, status: 'active', paidAt: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('dépenses validées par date', () => Expense.find({ ...m, status: 'validated', date: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('factures d’achat par date', () => PurchaseInvoice.find({ ...m, status: 'validated', invoiceDate: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('dossiers d’importation par date', () => ImportFile.find({ ...m, orderDate: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('historique des coûts par date', () => CostHistory.find({ ...m, at: { $gte: from, $lte: to } }).explain('executionStats') as never);
await check('journal d’audit récent', () => AuditLog.find(m).sort({ at: -1 }).limit(8).explain('executionStats') as never);
await check('recherche client par nom', () => Customer.find({ ...m, name: /Client 0042/i }).limit(20).explain('executionStats') as never);
await check('recherche article par référence', () => Product.find({ ...m, reference: /ART-0150/i }).limit(20).explain('executionStats') as never);
console.log(`Base ${dbName}\n\n| Requête | Index utilisé | Clés examinées | Documents examinés | Renvoyés | ms | Verdict |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n${bad ? `${bad} requête(s) à examiner` : 'Aucun parcours complet détecté'}`);
await mongoose.disconnect(); await disconnectDb().catch(() => undefined); process.exit(bad ? 1 : 0);
