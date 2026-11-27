import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { Types } from 'mongoose';
import { Category, Product, ProductActivity, Unit } from '../../models/product.model.js';
import { ensureFixedUnits, matchFixed } from './units.js';
import { FiscalRule } from '../../models/fiscal-rule.model.js';
import { Setting } from '../../models/setting.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../utils/transaction.js';
import { normalizeTaxId } from '../parties/party.shared.js';
import { resolveRate } from '../imports/import.service.js';
import { toBaseMinor } from '../imports/import.calc.js';
import { needsDimensionReview, packagingProblems, volumeM3 } from './product.pricing.js';
import { estimateRateFor } from './estimate-rate.js';

type Id = Types.ObjectId;
export const MAX_ROWS = 5000;
export interface ImportIssue { row: number; field?: string; message: string }
export interface ImportReport { mode: 'create' | 'upsert'; dryRun: boolean; total: number; toCreate: number; toUpdate: number; created: number; updated: number; applied: boolean; errors: ImportIssue[]; warnings: string[] }

export const TEMPLATE_HEADERS = ['Référence', 'Désignation', 'Type', 'Catégorie', 'Sous-catégorie', 'Unité', 'Prix d\'achat', 'Prix de vente', 'Code TVA', 'Stock minimum', 'Fournisseur', 'Série', 'Description',
  'Longueur (mm)', 'Largeur (mm)', 'Hauteur (mm)', 'Poids net (kg)', 'Poids brut (kg)', 'Type d\'emballage', 'Devise d\'achat', 'Prix d\'achat en devise', 'Coût de revient estimé',
  'Prix minimum de vente', 'Remise maximale (%)', 'Code NGP fournisseur', 'Code NGP tunisien', 'DD (%)', 'FODEC (%)', 'RPD (%)', 'Pays d\'origine', 'Pays de provenance', 'Règlement particulier', 'Statut'];
/** Colonnes à garder en texte (zéros initiaux des codes NGP). */
const TEXT_COLUMNS = ['Code NGP fournisseur', 'Code NGP tunisien'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES: Record<string, string[]> = {
  reference: ['reference', 'ref', 'code', 'codearticle'], name: ['designation', 'nom', 'name', 'libelle'], kind: ['type'],
  family: ['categorie', 'famille', 'category'], subFamily: ['souscategorie', 'sousfamille'], unit: ['unite', 'unit', 'um', 'unitedemesure'],
  purchase: ['prixachat', 'prixdachat', 'purchaseprice', 'pa'], sale: ['prixvente', 'prixdevente', 'saleprice', 'pv'], vat: ['codetva', 'tva', 'vat'],
  minStock: ['stockminimum', 'stockmin', 'seuil', 'minstock'], supplier: ['fournisseur', 'supplier', 'matriculefournisseur'],
  serial: ['serie', 'numerodeserie', 'numeroserie', 'serial'], description: ['description'],
  lengthMm: ['longueurmm', 'longueur'], widthMm: ['largeurmm', 'largeur'], heightMm: ['hauteurmm', 'hauteur'], netWeightKg: ['poidsnetkg', 'poidsnet'], grossWeightKg: ['poidsbrutkg', 'poidsbrut'],
  packType: ['typedemballage', 'typeemballage', 'emballage'], purchaseCurrency: ['devisedachat', 'deviseachat', 'devise'], purchaseForeign: ['prixdachatendevise', 'prixachatdevise'],
  estimatedCost: ['coutderevientestime', 'coutestime'], minSale: ['prixminimumdevente', 'prixminimum', 'prixminvente'], maxDiscount: ['remisemaximalepct', 'remisemaximale', 'remisemax'],
  hsSupplier: ['codengpfournisseur', 'ngpfournisseur'], hsTn: ['codengptunisien', 'ngptunisien', 'ngp'], dd: ['ddpct', 'dd', 'droitsdedouane'], fodec: ['fodecpct', 'fodec'], rpd: ['rpdpct', 'rpd'],
  origin: ['paysdorigine', 'origine'], provenance: ['paysdeprovenance', 'provenance'], regulation: ['reglementparticulier', 'reglement'], status: ['statut', 'status'],
};
/** Anciennes colonnes retirées : ignorées (aucune valeur historique n'est modifiée) et signalées. */
const OBSOLETE: Record<string, string> = { marque: 'Marque', brand: 'Marque', modele: 'Modèle', model: 'Modèle', nombredecolis: 'Nombre de colis', nbcolis: 'Nombre de colis', colis: 'Nombre de colis' };
const PACK_LABELS: Record<string, string> = { carton: 'carton', cairedebois: 'wooden_crate', caisseenbois: 'wooden_crate', palette: 'pallet', filmplastique: 'plastic_film', autre: 'other' };
const STATUS_WORDS: Record<string, string> = { actif: 'active', active: 'active', inactif: 'inactive', inactive: 'inactive', bloque: 'blocked', blocked: 'blocked', archive: 'archived', archived: 'archived' };

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
      await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter, quote: '"' }, map: (value: unknown) => value }); // valeurs lues en texte : les codes NGP gardent leurs zéros initiaux
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
  absent?: string[];
  /** Champs facultatifs de la fiche : clés pointées (« packaging.lengthMm »…), présents seulement si la colonne et la valeur existent. */
  extra: Record<string, unknown>; status?: string;
}

export async function importProducts(companyId: Id, buffer: Buffer, filename: string, opts: { mode: 'create' | 'upsert'; dryRun: boolean }): Promise<ImportReport> {
  const rows = await readRows(buffer, filename);
  const report: ImportReport = { mode: opts.mode, dryRun: opts.dryRun, total: 0, toCreate: 0, toUpdate: 0, created: 0, updated: 0, applied: false, errors: [], warnings: [] };
  if (rows.length < 2) { report.errors.push({ row: 1, message: 'Aucune ligne de données' }); return report; }
  if (rows.length - 1 > MAX_ROWS) throw AppError.badRequest(`Trop de lignes (maximum ${MAX_ROWS})`);

  // En-têtes
  const header = rows[0]!.map(norm);
  const col: Record<string, number> = {};
  const obsolete = [...new Set(header.map((h) => OBSOLETE[h]).filter(Boolean))];
  if (obsolete.length) report.warnings.push(`Colonnes ignorées (champs supprimés) : ${obsolete.join(', ')}`);
  for (const [key, names] of Object.entries(ALIASES)) { const i = header.findIndex((h) => names.includes(h)); if (i >= 0) col[key] = i; }
  for (const req of ['reference', 'name', 'unit', 'vat'] as const) if (col[req] === undefined) report.errors.push({ row: 1, field: req, message: `Colonne obligatoire manquante : ${req}` });
  if (report.errors.length) return report;

  await ensureFixedUnits(companyId);
  const [settings, cats, units, suppliers, existing] = await Promise.all([
    Setting.findOne({ companyId }).lean(), Category.find({ companyId }).lean(), Unit.find({ companyId }).lean(),
    Supplier.find({ companyId }).select('name taxId code isArchived status').lean(), Product.find({ companyId }).select('reference unitId categoryId mainSupplierId purchaseCurrency purchasePriceForeignMinor').lean(),
  ]);
  const decimals = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.decimals ?? 3;
  const vatCodes = new Set((await FiscalRule.distinct('code', { companyId, kind: 'vat', status: 'validated' })) as string[]);
  const families = new Map(cats.filter((c) => !c.parentId).map((c) => [c.name.toLowerCase(), c]));
  const supByCode = new Map(suppliers.filter((s) => s.code).map((s) => [s.code!.toLowerCase(), s]));
  const unitByCode = new Map(units.map((u) => [u.code.toLowerCase(), u]));
  const supByTax = new Map(suppliers.filter((s) => s.taxId).map((s) => [s.taxId!, s]));
  const supByName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s]));
  const existingByRef = new Map(existing.map((p) => [p.reference.toLowerCase(), p]));

  const get = (r: string[], k: string) => (col[k] === undefined ? '' : (r[col[k]!] ?? '').trim());
  const parsed: (ParsedRow & { existingId?: Id })[] = [];
  const seen = new Map<string, number>();
  const rates = new Map<string, Awaited<ReturnType<typeof resolveRate>>>();

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
    const rawUnit = get(r, 'unit'); const current0 = get(r, 'reference') ? existingByRef.get(get(r, 'reference').toLowerCase()) : undefined;
    const named = unitByCode.get(rawUnit.toLowerCase());
    // Unité proposée (code ou nom : PC, Pièce, m, kg…) ou unité historique déjà portée par l'article mis à jour
    const match = matchFixed(rawUnit, rawUnit);
    const unit = named && (named.fixedKey || current0?.unitId?.equals(named._id)) ? named : match ? units.find((u) => u.fixedKey === match.key) : undefined;
    if (!unit) err('unit', `Unité « ${rawUnit} » non proposée : utilisez Pièce (PC), Mètre (M) ou Kilogramme (KG)`);
    const vat = get(r, 'vat');
    if (!vat) err('vat', 'Code TVA obligatoire'); else if (!vatCodes.has(vat.toUpperCase())) err('vat', `Code TVA inconnu « ${vat} »`);

    const current = reference ? existingByRef.get(reference.toLowerCase()) : undefined;
    let categoryId: Id | undefined;
    const famName = get(r, 'family'); const subName = get(r, 'subFamily');
    const archivedCat = (c: { _id: Id; isArchived?: boolean | null; parentId?: Id | null }) => (c.isArchived || cats.some((x) => x.isArchived && c.parentId?.equals(x._id))) && !current?.categoryId?.equals(c._id);
    if (subName && !famName) err('subFamily', 'Sous-catégorie renseignée sans catégorie');
    else if (famName) {
      const fam = families.get(famName.toLowerCase());
      if (!fam) err('family', `Catégorie inconnue « ${famName} »`);
      else if (subName) {
        const sub = cats.find((c) => c.parentId?.equals(fam._id) && c.name.toLowerCase() === subName.toLowerCase());
        if (!sub) err('subFamily', `Sous-catégorie inconnue « ${subName} » dans « ${famName} »`); else if (archivedCat(sub)) err('subFamily', `Sous-catégorie « ${subName} » archivée`); else categoryId = sub._id;
      } else if (archivedCat(fam)) err('family', `Catégorie « ${famName} » archivée`); else categoryId = fam._id;
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
      const s = supByCode.get(supRaw.toLowerCase()) ?? supByTax.get(normalizeTaxId(supRaw)!) ?? supByName.get(supRaw.toLowerCase());
      if (!s) err('supplier', `Fournisseur introuvable « ${supRaw} »`);
      else if ((s.isArchived || s.status === 'inactive') && !current?.mainSupplierId?.equals(s._id)) err('supplier', `Fournisseur « ${supRaw} » ${s.isArchived ? 'archivé' : 'inactif'}`);
      else mainSupplierId = s._id;
    }
    const serialRaw = norm(get(r, 'serial'));
    const hasSerial = ['oui', 'yes', 'true', '1', 'x', 'o'].includes(serialRaw);
    if (serialRaw && !hasSerial && !['non', 'no', 'false', '0', 'n'].includes(serialRaw)) err('serial', 'Valeur « Série » invalide (Oui/Non)');

    // ---- Champs étendus (dimensions et poids, devise, douane, statut) ----
    const extra: Record<string, unknown> = {};
    const txt = (k: string, path: string, max: number) => { const v = get(r, k); if (v) { if (v.length > max) err(k, `Valeur trop longue (${max} max)`); else extra[path] = v; } };
    txt('origin', 'customs.originCountry', 60); txt('provenance', 'customs.provenanceCountry', 60); txt('regulation', 'customs.specialRegulation', 500);
    for (const [k, path] of [['hsSupplier', 'customs.supplierHsCode'], ['hsTn', 'customs.tnHsCode']] as const) { const v = get(r, k); if (v) { if (!/^[0-9A-Za-z .-]{1,20}$/.test(v)) err(k, 'Code NGP invalide'); else extra[path] = v; } }
    const nonNeg = (k: string, path: string, label: string, max = 1e7, int = false) => { const n = parseNumber(get(r, k)); if (n === null) return; if (Number.isNaN(n) || n < 0 || n > max || (int && !Number.isInteger(n))) err(k, `${label} invalide`); else extra[path] = n; };
    for (const [k, path, label] of [['lengthMm', 'packaging.lengthMm', 'Longueur'], ['widthMm', 'packaging.widthMm', 'Largeur'], ['heightMm', 'packaging.heightMm', 'Hauteur'], ['netWeightKg', 'packaging.netWeightKg', 'Poids net'], ['grossWeightKg', 'packaging.grossWeightKg', 'Poids brut']] as const) nonNeg(k, path, label);
    nonNeg('dd', 'customs.ddPct', 'DD', 1000); nonNeg('fodec', 'customs.fodecPct', 'FODEC', 1000); nonNeg('rpd', 'customs.rpdPct', 'RPD', 1000); nonNeg('maxDiscount', 'maxDiscountPct', 'Remise maximale', 100);
    const dims = ['packaging.lengthMm', 'packaging.widthMm', 'packaging.heightMm'].filter((x) => x in extra).length; if (dims > 0 && dims < 3) err('lengthMm', 'Dimensions incomplètes : renseignez longueur, largeur et hauteur (ou aucune)');
    const pk = { lengthMm: extra['packaging.lengthMm'] as number | undefined, widthMm: extra['packaging.widthMm'] as number | undefined, heightMm: extra['packaging.heightMm'] as number | undefined, netWeightKg: extra['packaging.netWeightKg'] as number | undefined, grossWeightKg: extra['packaging.grossWeightKg'] as number | undefined };
    for (const m of packagingProblems(pk)) err('packaging', m);
    const packRaw = norm(get(r, 'packType')); if (packRaw) { const t = PACK_LABELS[packRaw]; if (t) extra['packaging.type'] = t === 'carton' ? 'carton' : t; else { extra['packaging.type'] = 'other'; extra['packaging.typeLabel'] = get(r, 'packType').slice(0, 60); } }
    const minSale = parseNumber(get(r, 'minSale')); if (minSale !== null) { if (Number.isNaN(minSale) || minSale < 0) err('minSale', 'Prix minimum de vente invalide'); else { extra['minSalePriceMinor'] = Math.round(minSale * 10 ** decimals); if ((extra['minSalePriceMinor'] as number) > salePriceMinor && salePriceMinor > 0) err('minSale', 'Le prix minimum de vente dépasse le prix de vente'); } }
    const est = parseNumber(get(r, 'estimatedCost')); if (est !== null) { if (Number.isNaN(est) || est < 0) err('estimatedCost', 'Coût de revient estimé invalide'); else extra['estimatedCostMinor'] = Math.round(est * 10 ** decimals); }
    const curRaw = get(r, 'purchaseCurrency').toUpperCase(); const foreign = parseNumber(get(r, 'purchaseForeign'));
    if (curRaw || foreign !== null) {
      const base = settings?.baseCurrency ?? 'TND';
      if (!curRaw || foreign === null) err('purchaseCurrency', 'Devise et prix d’achat en devise vont ensemble');
      else if (Number.isNaN(foreign) || foreign < 0) err('purchaseForeign', 'Prix d’achat en devise invalide');
      else if (curRaw !== base) {
        const cur = settings?.currencies.find((c) => c.code === curRaw);
        if (!cur) err('purchaseCurrency', `Devise « ${curRaw} » non configurée`);
        else {
          const fm = Math.round(foreign * 10 ** cur.decimals);
          const unchanged = !!current && current.purchaseCurrency === curRaw && current.purchasePriceForeignMinor === fm;
          if (unchanged) { /* prix inchangé : la contre-valeur enregistrée n'est pas recalculée */ }
          else if (estimateRateFor(settings, curRaw)) {
            // Devise à taux estimatif (EUR) : aucun taux réel requis, aucune contre-valeur enregistrée
            Object.assign(extra, { purchaseCurrency: curRaw, purchasePriceForeignMinor: fm, purchaseRate: null, purchaseRateDate: null, purchasePriceMinor: 0 });
          } else { try {
            const rr = rates.get(curRaw) ?? await resolveRate(companyId, curRaw, new Date()); rates.set(curRaw, rr);
            Object.assign(extra, { purchaseCurrency: curRaw, purchasePriceForeignMinor: fm, purchaseRate: rr.rate, purchaseRateDate: rr.rateDate, purchasePriceMinor: toBaseMinor(fm, rr.rate, cur.decimals, decimals) });
          } catch (e) { err('purchaseCurrency', e instanceof AppError ? e.message : 'Taux de change indisponible'); } }
        }
      } else Object.assign(extra, { purchaseCurrency: null, purchasePriceForeignMinor: null, purchaseRate: null, purchaseRateDate: null, purchasePriceMinor: Math.round(foreign * 10 ** decimals) });
    }
    const stRaw = norm(get(r, 'status')); let status: string | undefined;
    if (stRaw) { status = STATUS_WORDS[stRaw]; if (!status) err('status', 'Statut invalide (Actif, Inactif, Bloqué, Archivé)'); }

    const existingId = current?._id;
    if (existingId && opts.mode === 'create') err('reference', `La référence « ${reference} » existe déjà (utilisez le mode mise à jour)`);
    if (report.errors.length === before) {
      // Mise à jour : seules les colonnes présentes ET renseignées modifient l'article (aucune remise à zéro implicite)
      const absent = existingId ? ([['kind', 'kind'], ['purchasePriceMinor', 'purchase'], ['salePriceMinor', 'sale'], ['minStock', 'minStock'], ['hasSerial', 'serial']] as const).filter(([, k]) => get(r, k) === '').map(([f]) => f) : [];
      parsed.push({ row: rowNo, reference, name, kind: kindRaw === 'service' ? 'service' : 'product', ...(categoryId && { categoryId }), unitId: unit!._id, ...({ absent } as object),
        purchasePriceMinor, salePriceMinor, vatRateCode: vat, minStock: ms ?? 0, ...(mainSupplierId && { mainSupplierId }), hasSerial,
        ...(get(r, 'description') && { description: get(r, 'description') }), extra, ...(status && { status }), ...(existingId && { existingId }) });
    }
  }
  report.toCreate = parsed.filter((p) => !p.existingId).length;
  report.toUpdate = parsed.filter((p) => p.existingId).length;
  if (opts.dryRun || report.errors.length || !parsed.length) return report;

  // Application atomique : tout ou rien. Les quantités de stock ne sont JAMAIS importées (elles passent par les mouvements de stock).
  const nest = (flat: Record<string, unknown>) => { const o: Record<string, any> = {}; for (const [k, v] of Object.entries(flat)) { const [a, b] = k.split('.'); if (b) (o[a!] ??= {})[b] = v; else o[a!] = v; } return o; };
  await withTransaction(async (session) => {
    const creates = parsed.filter((p) => !p.existingId).map(({ row: _r, existingId: _e, extra, status, absent: _a, ...p }) => ({ ...p, ...nest(Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null))), companyId, ...(status && { status, isActive: status === 'active', ...(status !== 'active' && { statusChangedAt: new Date() }) }) }));
    for (const c of creates) { const pk = (c as Record<string, any>).packaging; if (pk) { const v = volumeM3(pk); if (v !== null) pk.volumeM3 = v; } }
    if (creates.length) {
      const made = await Product.insertMany(creates as never, { session });
      await ProductActivity.insertMany(made.map((m) => ({ companyId, productId: m._id, auto: true, kind: 'product_created', title: 'Article créé (import)', occurredAt: new Date(), userName: 'Import', meta: { reference: m.reference } })), { session });
    }
    const updates = parsed.filter((p) => p.existingId);
    if (updates.length) {
      const previous = new Map((await Product.find({ companyId, _id: { $in: updates.map((u) => u.existingId) } }).session(session).lean()).map((d) => [d._id.toString(), d]));
      await Product.bulkWrite(updates.map(({ row: _r, existingId, extra, status, absent, ...p }) => {
        const $set: Record<string, unknown> = { ...p, ...(status && { status, isActive: status === 'active', statusChangedAt: new Date() }) }; const $unset: Record<string, 1> = {};
        for (const f of absent ?? []) delete $set[f];
        for (const [k, v] of Object.entries(extra)) { if (v === null) $unset[k] = 1; else $set[k] = v; }
        return { updateOne: { filter: { _id: existingId, companyId }, update: { $set, ...(Object.keys($unset).length && { $unset }) } } };
      }) as never, { session });
      // Volume recalculé depuis les dimensions ENREGISTRÉES (une ligne peut ne fournir qu'une partie des dimensions)
      for (const u of updates.filter((x) => Object.keys(x.extra).some((k) => k.startsWith('packaging.')))) {
        const doc = await Product.findById(u.existingId).session(session).lean(); const pk = doc?.packaging; const before = previous.get(String(u.existingId))?.packaging;
        const v = volumeM3(pk); const resized = (['lengthMm', 'widthMm', 'heightMm'] as const).some((k) => (pk?.[k] ?? null) !== (before?.[k] ?? null));
        await Product.updateOne({ _id: u.existingId }, { ...(v === null ? { $unset: { 'packaging.volumeM3': 1 } } : { $set: { 'packaging.volumeM3': v, ...(resized && needsDimensionReview(before) && { 'packaging.reviewedAt': new Date() }) } }) }, { session });
      }
    }
  });
  report.created = report.toCreate; report.updated = report.toUpdate; report.applied = true;
  return report;
}

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Articles');
  ws.columns = TEMPLATE_HEADERS.map((h) => ({ header: h, width: 18, ...(TEXT_COLUMNS.includes(h) && { style: { numFmt: '@' } }) }));
  ws.getRow(1).font = { bold: true };
  const help = wb.addWorksheet('Aide');
  [['Colonne', 'Règle'],
    ['Référence', 'Obligatoire, unique dans la société.'], ['Désignation', 'Obligatoire.'], ['Type', 'Produit (défaut) ou Service.'],
    ['Catégorie / Sous-catégorie', 'Doivent exister et être actives (Catégories & unités). La sous-catégorie doit appartenir à la catégorie.'], ['Unité', 'PC (Pièce), M (Mètre) ou KG (Kilogramme). Obligatoire.'],
    ['Prix d\'achat / Prix de vente', 'Montants dans la devise de base, ex. 12,500.'], ['Code TVA', 'Code d\'un taux configuré dans Paramètres. Obligatoire.'],
    ['Stock minimum', 'Nombre (défaut 0).'], ['Fournisseur', 'Code, matricule fiscal ou raison sociale d\'un fournisseur actif.'], ['Série', 'Oui / Non : suivi par numéro de série.'],
    ['Longueur / Largeur / Hauteur (mm)', 'Les trois ensemble ou aucune ; volume total (m³) = L × l × h / 1 000 000 000, calculé automatiquement.'], ['Poids net / brut (kg)', 'Positifs ; le poids brut ne peut pas être inférieur au poids net.'],
    ['Type d\'emballage', 'Carton, Caisse en bois, Palette, Film plastique ou texte libre (Autre).'], ['Devise d\'achat + Prix d\'achat en devise', 'Ensemble. EUR : aucun taux requis (contre-valeur au taux estimatif de la société, pour l\'estimation seulement). Autres devises : dernier taux réel enregistré (sinon erreur). Devise de base : prix saisi directement.'],
    ['Coût de revient estimé / Prix minimum de vente / Remise maximale (%)', 'Facultatifs ; prix minimum ≤ prix de vente ; remise entre 0 et 100.'], ['Code NGP fournisseur / tunisien', 'Texte (zéros initiaux conservés). Jamais présumés.'], ['DD / FODEC / RPD (%)', 'Valeurs saisies : aucun taux n\'est présumé. La TVA vient du Code TVA.'], ['Pays / Règlement particulier', 'Textes libres.'], ['Statut', 'Actif, Inactif, Bloqué ou Archivé (défaut Actif). Les quantités de stock ne s\'importent pas : utilisez réceptions, mouvements ou inventaires.'],
    ['Import', 'Mode « création » : refuse les références existantes ; mode « mise à jour » : met à jour par référence, les colonnes absentes ou vides ne changent rien. Tout est refusé si une ligne est en erreur.']].forEach((r) => help.addRow(r));
  help.getRow(1).font = { bold: true }; help.columns = [{ width: 30 }, { width: 100 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
