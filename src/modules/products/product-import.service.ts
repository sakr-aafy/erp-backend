import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { Types } from 'mongoose';
import { Category, Product, Unit } from '../../models/product.model.js';
import { FiscalRule } from '../../models/fiscal-rule.model.js';
import { Setting } from '../../models/setting.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { normalizeTaxId } from '../parties/party.shared.js';

type Id = Types.ObjectId;
export const MAX_ROWS = 5000;
export interface ImportIssue { row: number; field?: string; message: string }
export interface ImportReport { mode: 'create' | 'upsert'; dryRun: boolean; total: number; toCreate: number; toUpdate: number; created: number; updated: number; applied: boolean; errors: ImportIssue[] }

export const TEMPLATE_HEADERS = ['Référence', 'Désignation', 'Type', 'Famille', 'Sous-famille', 'Unité', 'Prix d\'achat', 'Prix de vente', 'Code TVA', 'Stock minimum', 'Fournisseur', 'Série', 'Description'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES: Record<string, string[]> = {
  reference: ['reference', 'ref', 'code', 'codearticle'], name: ['designation', 'nom', 'name', 'libelle'], kind: ['type'],
  family: ['famille', 'categorie', 'category'], subFamily: ['sousfamille', 'souscategorie'], unit: ['unite', 'unit', 'um', 'unitedemesure'],
  purchase: ['prixachat', 'prixdachat', 'purchaseprice', 'pa'], sale: ['prixvente', 'prixdevente', 'saleprice', 'pv'], vat: ['codetva', 'tva', 'vat'],
  minStock: ['stockminimum', 'stockmin', 'seuil', 'minstock'], supplier: ['fournisseur', 'supplier', 'matriculefournisseur'],
  serial: ['serie', 'numerodeserie', 'numeroserie', 'serial'], description: ['description'],
};

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
};
const parseNumber = (s: string): number | null => {
  if (s === '') return null;
  const n = Number(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/** Lit un classeur xlsx ou csv (séparateur , ou ; détecté). Vérifie la signature du fichier (pas seulement l'extension). */
export async function readRows(buffer: Buffer, filename: string): Promise<string[][]> {
  const isXlsx = buffer.subarray(0, 2).toString('latin1') === 'PK';
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'xlsx' && !isXlsx) throw AppError.badRequest('Fichier .xlsx invalide');
  if (ext === 'csv' && isXlsx) throw AppError.badRequest('Fichier .csv invalide');
  if (ext !== 'xlsx' && ext !== 'csv') throw AppError.badRequest('Format non supporté : utilisez .xlsx ou .csv');
  const wb = new ExcelJS.Workbook();
  try {
    if (isXlsx) await wb.xlsx.load(buffer as never);
    else {
      let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const first = text.split(/\r?\n/, 1)[0] ?? '';
      const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
      text = text.replace(/\r\n/g, '\n');
      await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter, quote: '"' } });
    }
  } catch { throw AppError.badRequest('Fichier illisible'); }
  const ws = wb.worksheets[0];
  if (!ws) throw AppError.badRequest('Fichier vide');
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => { const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText); rows.push(vals); });
  return rows;
}

interface ParsedRow {
  row: number; reference: string; name: string; kind: 'product' | 'service'; categoryId?: Id; unitId: Id; purchasePriceMinor: number; salePriceMinor: number;
  vatRateCode: string; minStock: number; mainSupplierId?: Id; hasSerial: boolean; description?: string;
}

export async function importProducts(companyId: Id, buffer: Buffer, filename: string, opts: { mode: 'create' | 'upsert'; dryRun: boolean }): Promise<ImportReport> {
  const rows = await readRows(buffer, filename);
  const report: ImportReport = { mode: opts.mode, dryRun: opts.dryRun, total: 0, toCreate: 0, toUpdate: 0, created: 0, updated: 0, applied: false, errors: [] };
  if (rows.length < 2) { report.errors.push({ row: 1, message: 'Aucune ligne de données' }); return report; }
  if (rows.length - 1 > MAX_ROWS) throw AppError.badRequest(`Trop de lignes (maximum ${MAX_ROWS})`);

  // En-têtes
  const header = rows[0]!.map(norm);
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(ALIASES)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) col[key] = i; }
  for (const req of ['reference', 'name', 'unit', 'vat'] as const) if (col[req] === undefined) report.errors.push({ row: 1, field: req, message: `Colonne obligatoire manquante : ${req}` });
  if (report.errors.length) return report;

  const [settings, cats, units, suppliers, existing] = await Promise.all([
    Setting.findOne({ companyId }).lean(), Category.find({ companyId }).lean(), Unit.find({ companyId }).lean(),
    Supplier.find({ companyId }).select('name taxId').lean(), Product.find({ companyId }).select('reference').lean(),
  ]);
  const decimals = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.decimals ?? 3;
  const vatCodes = new Set((await FiscalRule.distinct('code', { companyId, kind: 'vat', status: 'validated' })) as string[]);
  const families = new Map(cats.filter((c) => !c.parentId).map((c) => [c.name.toLowerCase(), c]));
  const unitByCode = new Map(units.map((u) => [u.code.toLowerCase(), u]));
  const supByTax = new Map(suppliers.filter((s) => s.taxId).map((s) => [s.taxId!, s]));
  const supByName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s]));
  const existingByRef = new Map(existing.map((p) => [p.reference.toLowerCase(), p._id]));

  const get = (r: string[], k: string) => (col[k] === undefined ? '' : (r[col[k]!] ?? '').trim());
  const parsed: (ParsedRow & { existingId?: Id })[] = [];
  const seen = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!; const rowNo = i + 1;
    if (r.every((c) => c === '')) continue;
    report.total++;
    const err = (field: string, message: string) => report.errors.push({ row: rowNo, field, message });
    const before = report.errors.length;
    const reference = get(r, 'reference'); const name = get(r, 'name');
    if (!reference) err('reference', 'Référence obligatoire'); else if (reference.length > 60) err('reference', 'Référence trop longue (60 max)');
    if (name.length < 2) err('name', 'Désignation obligatoire (2 caractères min.)');
    if (reference) {
      const k = reference.toLowerCase();
      if (seen.has(k)) err('reference', `Référence en double dans le fichier (ligne ${seen.get(k)})`); else seen.set(k, rowNo);
    }
    const kindRaw = norm(get(r, 'kind'));
    if (kindRaw && !['produit', 'product', 'service'].includes(kindRaw)) err('kind', 'Type invalide (Produit ou Service)');
    const unit = unitByCode.get(get(r, 'unit').toLowerCase());
    if (!unit) err('unit', `Unité inconnue « ${get(r, 'unit')} » (à créer dans les catégories/unités)`);
    const vat = get(r, 'vat');
    if (!vat) err('vat', 'Code TVA obligatoire'); else if (!vatCodes.has(vat.toUpperCase())) err('vat', `Code TVA inconnu « ${vat} »`);

    let categoryId: Id | undefined;
    const famName = get(r, 'family'); const subName = get(r, 'subFamily');
    if (subName && !famName) err('subFamily', 'Sous-famille renseignée sans famille');
    else if (famName) {
      const fam = families.get(famName.toLowerCase());
      if (!fam) err('family', `Famille inconnue « ${famName} »`);
      else if (subName) {
        const sub = cats.find((c) => c.parentId?.equals(fam._id) && c.name.toLowerCase() === subName.toLowerCase());
        if (!sub) err('subFamily', `Sous-famille inconnue « ${subName} » dans « ${famName} »`); else categoryId = sub._id;
      } else categoryId = fam._id;
    }
    const money = (k: string, label: string) => {
      const n = parseNumber(get(r, k));
      if (n === null) return 0;
      if (Number.isNaN(n) || n < 0) { err(k, `${label} invalide`); return 0; }
      return Math.round(n * 10 ** decimals);
    };
    const purchasePriceMinor = money('purchase', 'Prix d\'achat'); const salePriceMinor = money('sale', 'Prix de vente');
    const ms = parseNumber(get(r, 'minStock'));
    if (ms !== null && (Number.isNaN(ms) || ms < 0)) err('minStock', 'Stock minimum invalide');
    let mainSupplierId: Id | undefined;
    const supRaw = get(r, 'supplier');
    if (supRaw) {
      const s = supByTax.get(normalizeTaxId(supRaw)!) ?? supByName.get(supRaw.toLowerCase());
      if (!s) err('supplier', `Fournisseur introuvable « ${supRaw} »`); else mainSupplierId = s._id;
    }
    const serialRaw = norm(get(r, 'serial'));
    const hasSerial = ['oui', 'yes', 'true', '1', 'x', 'o'].includes(serialRaw);
    if (serialRaw && !hasSerial && !['non', 'no', 'false', '0', 'n'].includes(serialRaw)) err('serial', 'Valeur « Série » invalide (Oui/Non)');

    const existingId = reference ? existingByRef.get(reference.toLowerCase()) : undefined;
    if (existingId && opts.mode === 'create') err('reference', `La référence « ${reference} » existe déjà (utilisez le mode mise à jour)`);
    if (report.errors.length === before) {
      parsed.push({ row: rowNo, reference, name, kind: kindRaw === 'service' ? 'service' : 'product', ...(categoryId && { categoryId }), unitId: unit!._id,
        purchasePriceMinor, salePriceMinor, vatRateCode: vat, minStock: ms ?? 0, ...(mainSupplierId && { mainSupplierId }), hasSerial,
        ...(get(r, 'description') && { description: get(r, 'description') }), ...(existingId && { existingId }) });
    }
  }
  report.toCreate = parsed.filter((p) => !p.existingId).length;
  report.toUpdate = parsed.filter((p) => p.existingId).length;
  if (opts.dryRun || report.errors.length || !parsed.length) return report;

  // Application atomique : tout ou rien
  await withTransaction(async (session) => {
    const creates = parsed.filter((p) => !p.existingId).map(({ row: _r, existingId: _e, ...p }) => ({ ...p, companyId }));
    if (creates.length) await Product.insertMany(creates, { session });
    const updates = parsed.filter((p) => p.existingId);
    if (updates.length) {
      await Product.bulkWrite(updates.map(({ row: _r, existingId, ...p }) => ({
        updateOne: { filter: { _id: existingId, companyId }, update: { $set: p, ...(!p.categoryId && { $unset: { categoryId: 1 } }) } },
      })), { session });
    }
  });
  report.created = report.toCreate; report.updated = report.toUpdate; report.applied = true;
  return report;
}

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Articles');
  ws.columns = TEMPLATE_HEADERS.map((h) => ({ header: h, width: 18 }));
  ws.getRow(1).font = { bold: true };
  const help = wb.addWorksheet('Aide');
  [['Colonne', 'Règle'],
    ['Référence', 'Obligatoire, unique dans la société.'], ['Désignation', 'Obligatoire.'], ['Type', 'Produit (défaut) ou Service.'],
    ['Famille / Sous-famille', 'Doivent exister (menu Catégories). La sous-famille nécessite sa famille.'], ['Unité', 'Code d\'une unité existante. Obligatoire.'],
    ['Prix d\'achat / Prix de vente', 'Montants dans la devise de base, ex. 12,500.'], ['Code TVA', 'Code d\'un taux configuré dans Paramètres. Obligatoire.'],
    ['Stock minimum', 'Nombre (défaut 0).'], ['Fournisseur', 'Matricule fiscal ou raison sociale d\'un fournisseur existant.'], ['Série', 'Oui / Non : suivi par numéro de série.'],
    ['Import', 'Mode « création » : refuse les références existantes ; mode « mise à jour » : met à jour par référence. Tout est refusé si une ligne est en erreur.']].forEach((r) => help.addRow(r));
  help.getRow(1).font = { bold: true }; help.columns = [{ width: 30 }, { width: 100 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
