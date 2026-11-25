import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ClientSession, QueryFilter, Types } from 'mongoose';
import { CHARGE_TYPES, ExchangeRate, GoodsReceipt, ImportFile, Warehouse, type ImportFileDoc } from '../../models/logistics.model.js';
import { Product } from '../../models/product.model.js';
import { Setting } from '../../models/setting.model.js';
import { AppError } from '../../utils/errors.js';
import { buildSort, escapeRegex, objectId } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { emitDomainEvent } from '../../services/domain-events.js';
import { ensureCounter, nextDocumentNumber } from '../../services/numbering.service.js';
import { ensureLevels } from '../../services/stock.service.js';
import { startOfDay } from '../../services/fiscal.service.js';
import { assertCanOrder } from '../suppliers/supplier.service.js';
import { Supplier } from '../../models/supplier.model.js';
import { minorInt } from '../parties/party.shared.js';
import { rangeFilter } from '../sales/document.http.js';
import { computeImport, toBaseMinor } from './import.calc.js';

type Id = Types.ObjectId; type Lean = ImportFileDoc & { _id: Id; createdAt?: Date };
const FLOW = ['draft', 'ordered', 'shipped', 'customs', 'arrived'] as const;

export const lineBody = z.object({ productId: objectId, quantity: z.number().gt(0).max(1e9).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, '3 décimales maximum'), unitPriceMinor: minorInt }).strict();
export const createBody = z.object({ supplierId: objectId, currency: z.string().trim().length(3).toUpperCase(), exchangeRate: z.number().gt(0).max(1e6).optional(), orderDate: z.coerce.date().optional(), reference: z.string().trim().max(80).optional(),
  lines: z.array(lineBody).min(1).max(300), notes: z.string().trim().max(2000).optional() }).strict();
export const chargeBody = z.object({ type: z.enum(CHARGE_TYPES), label: z.string().trim().max(120).optional(), amountMinor: minorInt, currency: z.string().trim().length(3).toUpperCase().optional(), exchangeRate: z.number().gt(0).max(1e6).optional(),
  date: z.coerce.date().optional(), allocation: z.enum(['value', 'quantity']).default('value') }).strict();
export const rateBody = z.object({ currency: z.string().trim().length(3).toUpperCase(), date: z.coerce.date(), rate: z.number().gt(0).max(1e6), source: z.string().trim().max(60).optional() }).strict();
export const docBody = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['invoice', 'packing_list', 'bill_of_lading', 'customs_declaration', 'insurance', 'certificate', 'other']).default('other') }).strict();

async function decimalsOf(companyId: Id, currency: string) {
  const s = await Setting.findOne({ companyId }).lean(); const cur = s?.currencies.find((c) => c.code === currency); const base = s?.currencies.find((c) => c.code === s.baseCurrency);
  if (!cur) throw AppError.badRequest(`Devise « ${currency} » non configurée dans les paramètres`);
  return { foreign: cur.decimals, base: base?.decimals ?? 3, baseCode: s?.baseCurrency ?? 'TND' };
}
/** Taux du jour : dernier taux enregistré ≤ date ; 1 pour la devise de base. */
export async function resolveRate(companyId: Id, currency: string, date: Date, session?: ClientSession) {
  const s = await Setting.findOne({ companyId }).lean(); if (currency === (s?.baseCurrency ?? 'TND')) return { rate: 1, rateDate: startOfDay(date) };
  const r = await ExchangeRate.findOne({ companyId, currency, date: { $lte: startOfDay(date) } }).sort({ date: -1 }).session(session ?? null).lean();
  if (!r) throw AppError.badRequest(`Aucun taux de change ${currency} enregistré au ${startOfDay(date).toISOString().slice(0, 10)} : saisissez le taux`);
  return { rate: r.rate, rateDate: r.date };
}
export async function listRates(companyId: Id, currency?: string) { return (await ExchangeRate.find({ companyId, ...(currency && { currency }) }).sort({ date: -1 }).limit(500).lean()).map((r) => ({ id: r._id.toString(), currency: r.currency, date: r.date, rate: r.rate, source: r.source ?? null })); }
export async function saveRate(companyId: Id, b: z.infer<typeof rateBody>) {
  const s = await Setting.findOne({ companyId }).lean(); if (!s?.currencies.some((c) => c.code === b.currency)) throw AppError.badRequest(`Devise « ${b.currency} » non configurée`);
  if (b.currency === s.baseCurrency) throw AppError.badRequest('Pas de taux pour la devise de base');
  const r = await ExchangeRate.findOneAndUpdate({ companyId, currency: b.currency, date: startOfDay(b.date) }, { rate: b.rate, source: b.source ?? 'manuel' }, { upsert: true, returnDocument: 'after' }).lean();
  return { id: r!._id.toString(), currency: r!.currency, date: r!.date, rate: r!.rate };
}

export function toDto(f: Lean) {
  return { id: f._id.toString(), number: f.number, status: f.status, supplierId: f.supplierId.toString(), supplier: f.supplier, currency: f.currency, exchangeRate: f.exchangeRate, exchangeRateDate: f.exchangeRateDate, orderDate: f.orderDate, reference: f.reference ?? null, notes: f.notes ?? null,
    lines: f.lines.map((l) => ({ id: (l as { _id: Id })._id.toString(), productId: l.productId!.toString(), reference: l.reference ?? null, designation: l.designation ?? null, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, fobBaseMinor: l.fobBaseMinor ?? 0,
      allocatedChargesMinor: l.allocatedChargesMinor ?? 0, landedTotalMinor: l.landedTotalMinor ?? 0, unitLandedMinor: l.unitLandedMinor ?? 0, serials: l.serials ?? [], customs: l.customs ?? null, packaging: l.packaging ?? null })),
    charges: f.charges.map((c) => ({ id: (c as { _id: Id })._id.toString(), type: c.type, label: c.label ?? null, amountMinor: c.amountMinor, currency: c.currency, exchangeRate: c.exchangeRate, rateDate: c.rateDate ?? null, amountBaseMinor: c.amountBaseMinor ?? 0, allocation: c.allocation, date: c.date ?? null })),
    documents: f.documents.map((d) => ({ id: (d as { _id: Id })._id.toString(), name: d.name, kind: d.kind, status: d.status, fileName: d.fileName ?? null, hasFile: !!d.storedName, size: d.size ?? null })),
    totals: f.totals, warehouseId: f.warehouseId?.toString() ?? null, receiptId: f.receiptId?.toString() ?? null, closedAt: f.closedAt ?? null, integratedAt: f.integratedAt ?? null,
    editableLines: ['draft', 'ordered'].includes(f.status), chargesOpen: !['closed', 'integrated', 'cancelled'].includes(f.status), createdAt: f.createdAt };
}
async function recompute(f: { _id: Id; lines: Lean['lines']; charges: Lean['charges']; exchangeRate: number; currency: string; companyId: Id; totals?: unknown }) {
  const d = await decimalsOf(f.companyId, f.currency);
  const r = computeImport(f.lines.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })), f.charges.map((c) => ({ id: (c as { _id: Id })._id.toString(), amountBaseMinor: c.amountBaseMinor ?? 0, allocation: c.allocation as 'value' | 'quantity', type: c.type })), f.exchangeRate, d.foreign, d.base);
  f.lines.forEach((l, i) => { const x = r.lines[i]!; l.fobBaseMinor = x.fobBaseMinor; l.allocatedChargesMinor = x.allocatedChargesMinor; l.landedTotalMinor = x.landedTotalMinor; l.unitLandedMinor = x.unitLandedMinor; });
  f.totals = r.totals; return r;
}

export async function list(companyId: Id, f: { q?: string | undefined; status?: string | undefined; open?: boolean | undefined; supplierId?: string | undefined; from?: Date | undefined; to?: Date | undefined; page: number; limit: number; sort?: string | undefined }) {
  const filter: QueryFilter<ImportFileDoc> = { companyId }; if (f.status) filter.status = f.status as never; if (f.supplierId) filter.supplierId = f.supplierId as never;
  if (f.open) filter.status = { $in: ['draft', 'ordered', 'shipped', 'customs', 'arrived', 'closed'] } as never; // dossiers en cours (non intégrés)
  const r = rangeFilter(f.from, f.to); if (r) filter.orderDate = r;
  if (f.q) { const rx = new RegExp(escapeRegex(f.q), 'i'); filter.$or = [{ number: rx }, { 'supplier.name': rx }, { reference: rx }]; }
  const [items, total] = await Promise.all([ImportFile.find(filter).select('-lines -charges -documents').sort(buildSort(f.sort, ['number', 'orderDate', 'createdAt'], { orderDate: -1, _id: -1 })).skip((f.page - 1) * f.limit).limit(f.limit).lean(), ImportFile.countDocuments(filter)]);
  return { items: items.map((i) => ({ ...toDto({ ...i, lines: [], charges: [], documents: [] } as unknown as Lean), lines: undefined, charges: undefined, documents: undefined })), total, page: f.page, limit: f.limit };
}
export async function getOwn(companyId: Id, id: string, session?: ClientSession) { const f = await ImportFile.findOne({ _id: id, companyId }).session(session ?? null); if (!f) throw AppError.notFound('Dossier d’importation introuvable'); return f; }
export const get = async (c: Id, id: string) => toDto((await getOwn(c, id)).toObject() as Lean);

async function buildLines(companyId: Id, lines: z.infer<typeof lineBody>[]) {
  const ps = await Product.find({ companyId, _id: { $in: lines.map((l) => l.productId) } }).lean(); const by = new Map(ps.map((p) => [p._id.toString(), p]));
  return lines.map((l) => { const p = by.get(l.productId); if (!p) throw AppError.badRequest('Article introuvable'); if (p.kind === 'service') throw AppError.badRequest(`« ${p.reference} » est un service : non importable en stock`);
    const st = p.status ?? (p.isActive === false ? 'inactive' : 'active'); if (st !== 'active') throw new AppError(409, `« ${p.reference} » est ${({ inactive: 'inactif', blocked: 'bloqué', archived: 'archivé' } as Record<string, string>)[st] ?? st} : achat à l'importation impossible`, `PRODUCT_${st.toUpperCase()}`);
    const c = p.customs; const pk = p.packaging;
    // Instantané des données douanières et logistiques à la date d'ajout : une modification ultérieure de l'article ne change jamais un dossier (clôturé ou non)
    return { productId: p._id, reference: p.reference, designation: p.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
      customs: { supplierHsCode: c?.supplierHsCode, tnHsCode: c?.tnHsCode, ddPct: c?.ddPct, fodecPct: c?.fodecPct, rpdPct: c?.rpdPct, originCountry: c?.originCountry, provenanceCountry: c?.provenanceCountry, specialRegulation: c?.specialRegulation, vatRateCode: p.vatRateCode, capturedAt: new Date() },
      packaging: { unitVolumeM3: pk?.volumeM3, unitNetWeightKg: pk?.netWeightKg, unitGrossWeightKg: pk?.grossWeightKg, packagingType: pk?.typeLabel ?? pk?.type, parcelCount: pk?.parcelCount } }; });
}
export async function create(companyId: Id, userId: Id, b: z.infer<typeof createBody>) {
  const sup = await Supplier.findOne({ _id: b.supplierId, companyId }).lean();
  if (!sup) throw AppError.badRequest('Fournisseur invalide'); if (!sup.isForeign) throw AppError.badRequest('Seul un fournisseur étranger peut faire l’objet d’un dossier d’importation');
  const date = startOfDay(b.orderDate ?? new Date()); await decimalsOf(companyId, b.currency);
  const rate = b.exchangeRate ? { rate: b.exchangeRate, rateDate: date } : await resolveRate(companyId, b.currency, date);
  const lines = await buildLines(companyId, b.lines); await ensureCounter(companyId, 'importFile', date);
  return withTransaction(async (session) => {
    await assertCanOrder(companyId, sup._id, session);
    const number = await nextDocumentNumber(companyId, 'importFile', session, date);
    const f = new ImportFile({ companyId, number, supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, currency: b.currency, exchangeRate: rate.rate, exchangeRateDate: rate.rateDate, orderDate: date, reference: b.reference, lines, notes: b.notes, createdBy: userId });
    await recompute(f as never); await f.save({ session }); return toDto(f.toObject() as Lean);
  });
}
export async function update(companyId: Id, id: string, b: z.infer<typeof createBody>) {
  const f = await getOwn(companyId, id); if (!['draft', 'ordered'].includes(f.status)) throw AppError.conflict('Lignes non modifiables à ce stade du dossier');
  const sup = await Supplier.findOne({ _id: b.supplierId, companyId }).lean(); if (!sup?.isForeign) throw AppError.badRequest('Fournisseur étranger requis');
  const date = startOfDay(b.orderDate ?? f.orderDate); await decimalsOf(companyId, b.currency);
  const rate = b.exchangeRate ? { rate: b.exchangeRate, rateDate: date } : await resolveRate(companyId, b.currency, date);
  f.set({ supplierId: sup._id, supplier: { name: sup.name, taxId: sup.taxId }, currency: b.currency, exchangeRate: rate.rate, exchangeRateDate: rate.rateDate, orderDate: date, reference: b.reference, lines: await buildLines(companyId, b.lines), notes: b.notes });
  // les frais déjà saisis dans une autre devise gardent leur propre taux ; ceux dans la devise du dossier suivent son taux
  await recompute(f as never); await f.save(); return toDto(f.toObject() as Lean);
}
export async function remove(companyId: Id, id: string) { const f = await getOwn(companyId, id); if (f.status !== 'draft') throw AppError.conflict('Seul un dossier en brouillon se supprime : annulez-le'); await f.deleteOne(); return f; }

export async function setStatus(companyId: Id, id: string, status: string, reason?: string) {
  const f = await getOwn(companyId, id);
  if (status === 'cancelled') { if (['closed', 'integrated', 'cancelled'].includes(f.status)) throw AppError.conflict('Dossier clôturé / intégré : annulation impossible'); f.status = 'cancelled'; f.cancelledAt = new Date(); if (reason) f.notes = `${f.notes ?? ''}\nAnnulé : ${reason}`.trim(); await f.save(); return toDto(f.toObject() as Lean); }
  const i = FLOW.indexOf(f.status as (typeof FLOW)[number]); const j = FLOW.indexOf(status as (typeof FLOW)[number]);
  if (i < 0 || j < 0 || j !== i + 1) throw AppError.conflict(`Transition impossible : ${f.status} → ${status}`);
  f.status = status as never; await f.save(); return toDto(f.toObject() as Lean);
}

// ---- Frais annexes : conversion au taux du jour du frais, recalcul automatique du coût de revient ----
async function chargeDoc(companyId: Id, f: { currency: string }, b: z.infer<typeof chargeBody>) {
  const currency = b.currency ?? f.currency; const d = await decimalsOf(companyId, currency); const date = startOfDay(b.date ?? new Date());
  const r = b.exchangeRate ? { rate: b.exchangeRate, rateDate: date } : await resolveRate(companyId, currency, date);
  return { type: b.type, label: b.label, amountMinor: b.amountMinor, currency, exchangeRate: r.rate, rateDate: r.rateDate, amountBaseMinor: toBaseMinor(b.amountMinor, r.rate, d.foreign, d.base), allocation: b.allocation, date };
}
export async function addCharge(companyId: Id, id: string, b: z.infer<typeof chargeBody>) {
  const f = await getOwn(companyId, id); if (['closed', 'integrated', 'cancelled'].includes(f.status)) throw AppError.conflict('Dossier clôturé : frais figés');
  f.charges.push(await chargeDoc(companyId, f, b) as never); await recompute(f as never); await f.save(); return toDto(f.toObject() as Lean);
}
export async function updateCharge(companyId: Id, id: string, chargeId: string, b: z.infer<typeof chargeBody>) {
  const f = await getOwn(companyId, id); if (['closed', 'integrated', 'cancelled'].includes(f.status)) throw AppError.conflict('Dossier clôturé : frais figés');
  const c = f.charges.find((x) => String((x as { _id: Id })._id) === chargeId); if (!c) throw AppError.notFound('Frais introuvable');
  c.set(await chargeDoc(companyId, f, b)); await recompute(f as never); await f.save(); return toDto(f.toObject() as Lean);
}
export async function removeCharge(companyId: Id, id: string, chargeId: string) {
  const f = await getOwn(companyId, id); if (['closed', 'integrated', 'cancelled'].includes(f.status)) throw AppError.conflict('Dossier clôturé : frais figés');
  if (!f.charges.some((x) => String((x as { _id: Id })._id) === chargeId)) throw AppError.notFound('Frais introuvable');
  f.set('charges', f.charges.filter((x) => String((x as { _id: Id })._id) !== chargeId)); await recompute(f as never); await f.save(); return toDto(f.toObject() as Lean);
}
/** Fiche du coût de revient à l'importation : par ligne (FOB, parts de chaque frais, coût rendu, coût unitaire) et total par type de frais. */
export async function costSheet(companyId: Id, id: string) {
  const f = await getOwn(companyId, id); const d = await decimalsOf(companyId, f.currency);
  const r = computeImport(f.lines.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })), f.charges.map((c) => ({ id: (c as { _id: Id })._id.toString(), amountBaseMinor: c.amountBaseMinor ?? 0, allocation: c.allocation as 'value' | 'quantity', type: c.type })), f.exchangeRate, d.foreign, d.base);
  return { number: f.number, currency: f.currency, exchangeRate: f.exchangeRate, status: f.status, totals: r.totals, byType: r.byType,
    lines: f.lines.map((l, i) => ({ productId: l.productId!.toString(), reference: l.reference, designation: l.designation, quantity: l.quantity, ...r.lines[i]!, coefficient: r.lines[i]!.fobBaseMinor ? Math.round((r.lines[i]!.landedTotalMinor / r.lines[i]!.fobBaseMinor) * 10000) / 10000 : null })) };
}

/** Clôture : fige les frais ; le coût rendu devient définitif. */
export async function close(companyId: Id, id: string) {
  const f = await getOwn(companyId, id); if (!['ordered', 'shipped', 'customs', 'arrived'].includes(f.status)) throw AppError.conflict(`Clôture impossible depuis le statut « ${f.status} »`);
  f.status = 'closed'; f.closedAt = new Date(); await recompute(f as never); await f.save(); return toDto(f.toObject() as Lean);
}
/** Intégration au stock : réception validée au coût rendu (événement stock, même transaction) ; le dossier passe à « intégré ». */
export async function integrate(companyId: Id, userId: Id, id: string, b: { warehouseId: string; serials?: Record<string, string[]> | undefined }) {
  const pre = await getOwn(companyId, id); await ensureLevels(companyId, pre.lines.map((l) => ({ productId: l.productId!, warehouseId: b.warehouseId }))); await ensureCounter(companyId, 'goodsReceipt');
  return withTransaction(async (session) => {
    const f = await getOwn(companyId, id, session); if (f.status !== 'closed') throw AppError.conflict('Clôturez le dossier (frais figés) avant d’intégrer les marchandises au stock');
    if (!(await Warehouse.exists({ _id: b.warehouseId, companyId, isActive: true }).session(session))) throw AppError.badRequest('Magasin invalide');
    const number = await nextDocumentNumber(companyId, 'goodsReceipt', session);
    const [rc] = await GoodsReceipt.create([{ companyId, number, importFileId: f._id, supplierId: f.supplierId, supplier: f.supplier, warehouseId: b.warehouseId, receiptDate: startOfDay(new Date()), status: 'validated', validatedAt: new Date(), validatedBy: userId, createdBy: userId,
      lines: f.lines.map((l) => ({ importLineId: (l as { _id: Id })._id, productId: l.productId, designation: l.designation, quantity: l.quantity, unitCostMinor: Math.round((l.fobBaseMinor ?? 0) / l.quantity),
        extraUnitCostMinor: Math.round(((l.landedTotalMinor ?? 0) - (l.fobBaseMinor ?? 0)) / l.quantity), valueMinor: l.landedTotalMinor ?? 0, serials: b.serials?.[(l as { _id: Id })._id.toString()] ?? [] })) }] as never[], { session });
    await emitDomainEvent('goodsReceipt.validated', { companyId, documentId: rc!._id, session, userId, documentNumber: number });
    f.status = 'integrated'; f.warehouseId = b.warehouseId as never; f.receiptId = rc!._id; f.integratedAt = new Date(); await f.save({ session });
    return toDto(f.toObject() as Lean);
  });
}

// ---- Documents d'importation : suivi + fichiers (stockage sécurisé) ----
const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
export const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.xlsx', '.csv', '.docx'] as const;
export async function addDocument(companyId: Id, id: string, b: z.infer<typeof docBody>) {
  const f = await getOwn(companyId, id); f.documents.push({ name: b.name, kind: b.kind, status: 'pending' } as never); await f.save(); return toDto(f.toObject() as Lean);
}
export async function storeDocumentFile(companyId: Id, id: string, docId: string, file: { originalname: string; buffer: Buffer; size: number }) {
  const f = await getOwn(companyId, id); const d = f.documents.find((x) => String((x as { _id: Id })._id) === docId); if (!d) throw AppError.notFound('Document introuvable');
  const ext = path.extname(file.originalname).toLowerCase(); if (!(ALLOWED_EXT as readonly string[]).includes(ext)) throw AppError.badRequest(`Type de fichier non autorisé (${ALLOWED_EXT.join(', ')})`);
  const magic = file.buffer.subarray(0, 4).toString('latin1');
  if ((ext === '.pdf' && !magic.startsWith('%PDF')) || (ext === '.png' && !file.buffer.subarray(1, 4).toString('latin1').startsWith('PNG')) || ((ext === '.jpg' || ext === '.jpeg') && file.buffer[0] !== 0xff) || (['.xlsx', '.docx'].includes(ext) && !magic.startsWith('PK'))) throw AppError.badRequest('Contenu du fichier incohérent avec son extension');
  const dir = path.join(UPLOAD_ROOT, companyId.toString()); await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (d.storedName) await fs.promises.rm(path.join(dir, d.storedName), { force: true });
  const stored = `${crypto.randomBytes(16).toString('hex')}${ext}`; await fs.promises.writeFile(path.join(dir, stored), file.buffer, { mode: 0o600 });
  d.storedName = stored; d.fileName = path.basename(file.originalname).slice(0, 120); d.size = file.size; d.uploadedAt = new Date(); d.status = 'received'; d.mime = ext;
  await f.save(); return toDto(f.toObject() as Lean);
}
export async function documentFile(companyId: Id, id: string, docId: string) {
  const f = await getOwn(companyId, id); const d = f.documents.find((x) => String((x as { _id: Id })._id) === docId); if (!d?.storedName) throw AppError.notFound('Fichier introuvable');
  return { path: path.join(UPLOAD_ROOT, companyId.toString(), path.basename(d.storedName)), name: d.fileName ?? 'document' };
}
export async function setDocumentStatus(companyId: Id, id: string, docId: string, status: 'pending' | 'received') {
  const f = await getOwn(companyId, id); const d = f.documents.find((x) => String((x as { _id: Id })._id) === docId); if (!d) throw AppError.notFound('Document introuvable'); d.status = status; await f.save(); return toDto(f.toObject() as Lean);
}
