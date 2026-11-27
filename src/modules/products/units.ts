import type { ClientSession, Types } from 'mongoose';
import { Product, Unit } from '../../models/product.model.js';
import { AppError } from '../../utils/errors.js';

/** Les trois unités de mesure proposées pour les articles. La précision est portée par l'unité, jamais déduite d'un libellé à l'usage. */
export const FIXED_UNITS = [
  { key: 'piece', code: 'PC', name: 'Pièce', decimals: 0, names: ['piece', 'pieces', 'unite', 'unites'], codes: ['pc', 'pcs', 'pce', 'pces', 'piece', 'u'] },
  { key: 'meter', code: 'M', name: 'Mètre', decimals: 1, names: ['metre', 'metres', 'meter', 'metrelineaire', 'metreslineaires'], codes: ['m', 'metre', 'meter'] },
  { key: 'kilogram', code: 'KG', name: 'Kilogramme', decimals: 1, names: ['kilogramme', 'kilogrammes', 'kilogram', 'kilogramm', 'kilo', 'kilos'], codes: ['kg', 'kilo', 'kilogramme'] },
] as const;
export type FixedUnitKey = (typeof FIXED_UNITS)[number]['key'];
export const FIXED_UNIT_KEYS = FIXED_UNITS.map((u) => u.key) as unknown as [FixedUnitKey, ...FixedUnitKey[]];
/** Précision des unités historiques non reconnues : inchangée (3 décimales). */
export const MAX_DECIMALS = 3;

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
/** Unité fixe correspondant à une unité historique : d'abord par son nom, sinon par un code non ambigu (« ML » seul ne l'est pas). */
export function matchFixed(code: string | null | undefined, name?: string | null) {
  const n = fold(name ?? ''); const c = fold(code ?? '');
  return FIXED_UNITS.find((u) => (u.names as readonly string[]).includes(n)) ?? FIXED_UNITS.find((u) => (u.codes as readonly string[]).includes(c));
}
type UnitLike = { fixedKey?: string | null; decimals?: number | null; code?: string | null; name?: string | null };
export const unitDecimals = (u: UnitLike | null | undefined): number => u?.decimals ?? matchFixed(u?.code, u?.name)?.decimals ?? MAX_DECIMALS;
export const hasPrecision = (q: number, decimals: number) => Math.abs(q * 10 ** decimals - Math.round(q * 10 ** decimals)) < 1e-6;

type Id = Types.ObjectId;
/**
 * Garantit les trois unités fixes d'une société (idempotent) : une unité historique reconnue est RÉUTILISÉE (même identifiant,
 * mêmes code et nom) ; à défaut, elle est créée. Les autres unités sont conservées telles quelles.
 */
export async function ensureFixedUnits(companyId: Id, session?: ClientSession, dryRun = false) {
  const units = await Unit.find({ companyId }).sort({ createdAt: 1, _id: 1 }).session(session ?? null).lean();
  const report: { key: FixedUnitKey; action: 'existing' | 'adopted' | 'created'; code: string; name: string }[] = [];
  for (const f of FIXED_UNITS) {
    const done = units.find((u) => u.fixedKey === f.key);
    if (done) { report.push({ key: f.key, action: 'existing', code: done.code, name: done.name }); continue; }
    // Correspondance exacte du nom en priorité, puis la plus ancienne unité reconnue
    const matches = units.filter((u) => !u.fixedKey && matchFixed(u.code, u.name)?.key === f.key);
    const found = matches.find((u) => fold(u.name) === fold(f.name)) ?? matches[0];
    if (found) {
      report.push({ key: f.key, action: 'adopted', code: found.code, name: found.name });
      if (!dryRun) await Unit.updateOne({ _id: found._id, companyId }, { fixedKey: f.key, decimals: f.decimals }, { session });
    } else {
      const taken = new Set(units.map((u) => u.code.toLowerCase())); let code: string = f.code; for (let i = 2; taken.has(code.toLowerCase()); i++) code = `${f.code}${i}`;
      report.push({ key: f.key, action: 'created', code, name: f.name });
      if (!dryRun) await Unit.updateOne({ companyId, fixedKey: f.key }, { $setOnInsert: { companyId, fixedKey: f.key, code, name: f.name, decimals: f.decimals } }, { upsert: true, session });
    }
  }
  return report;
}

/** Une quantité reprise à l'identique d'un document source (même non conforme) est acceptée ; toute autre saisie suit l'unité. */
export const carriedOver = (requested: number, ...sources: (number | null | undefined)[]) => sources.some((s) => s !== null && s !== undefined && Math.abs(s - requested) < 1e-9);

export interface QuantityLine { productId?: unknown; unit?: string | null | undefined; quantity: number | null | undefined; /** Quantité reprise d'un document antérieur non conforme : conservée. */ exempt?: boolean | undefined; label?: string | undefined }
const fr = (n: number) => String(n).replace('.', ',');

/**
 * Contrôle serveur de la précision des quantités saisies, selon l'unité de l'article (ou l'unité écrite sur une ligne libre).
 * Un article suivi par numéro de série n'accepte que des quantités entières, quelle que soit son unité.
 */
export async function assertQuantities(companyId: Id, lines: QuantityLine[], session?: ClientSession) {
  const todo = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.quantity !== null && l.quantity !== undefined && !l.exempt && !Number.isInteger(l.quantity));
  if (!todo.length) return; // un nombre entier est valide pour toutes les unités
  const ids = [...new Set(todo.map(({ l }) => (l.productId ? String(l.productId) : '')).filter(Boolean))];
  const products = ids.length ? await Product.find({ _id: { $in: ids }, companyId }).select('reference hasSerial unitId').populate('unitId', 'code name decimals fixedKey').session(session ?? null).lean() : [];
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const units = todo.some(({ l }) => !l.productId && l.unit) ? await Unit.find({ companyId }).session(session ?? null).lean() : [];
  for (const { l, i } of todo) {
    const p = l.productId ? byId.get(String(l.productId)) : undefined;
    const u = p ? (p.unitId as unknown as UnitLike | null) : units.find((x) => x.code.toLowerCase() === (l.unit ?? '').toLowerCase()) ?? (l.unit ? { code: l.unit, name: l.unit } : null);
    const serial = !!p?.hasSerial; const decimals = serial ? 0 : unitDecimals(u);
    if (hasPrecision(l.quantity!, decimals)) continue;
    const who = l.label ?? `Ligne ${i + 1}${p ? ` (${p.reference})` : ''}`;
    const unitName = u?.name ?? u?.code ?? '';
    const rule = serial ? 'cet article est suivi par numéro de série : saisissez un nombre entier'
      : decimals === 0 ? `l’unité « ${unitName} » n’accepte que des nombres entiers`
      : decimals >= MAX_DECIMALS ? `${MAX_DECIMALS} chiffres au plus après la virgule`
      : `l’unité « ${unitName} » accepte ${decimals} chiffre après la virgule au plus`;
    throw new AppError(422, `${who} : quantité ${fr(l.quantity!)} refusée, ${rule}.`, 'QUANTITY_PRECISION', { line: i + 1, decimals });
  }
}
