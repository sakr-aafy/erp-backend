import { Types } from 'mongoose';
import type { Chart, Ctx, Filters, GroupBy, Row } from './report.types.js';

export const oid = (s?: string | undefined) => (s ? new Types.ObjectId(s) : undefined);
/** Borne haute incluse (fin de journée UTC) : « jusqu'au 31/03 » inclut tout le 31/03. */
export const endOfDay = (d: Date) => new Date(d.getTime() + 86_399_999);
export function range(f: Pick<Filters, 'from' | 'to'>) {
  if (!f.from && !f.to) return undefined;
  return { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: endOfDay(f.to) }) };
}
export const SIGN = { $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] };
export const sumField = (path: string, signed = false) => ({ $sum: signed ? { $multiply: [SIGN, `$${path}`] } : `$${path}` });
export const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Expression Mongo du « seau » de période (UTC). Semaine = ISO (lundi). */
export function bucketExpr(groupBy: GroupBy, field: string) {
  const d = `$${field}`;
  switch (groupBy) {
    case 'day': return { $dateToString: { format: '%Y-%m-%d', date: d } };
    case 'week': return { $dateToString: { format: '%G-S%V', date: d } };
    case 'month': return { $dateToString: { format: '%Y-%m', date: d } };
    case 'quarter': return { $concat: [{ $toString: { $year: d } }, '-T', { $toString: { $ceil: { $divide: [{ $month: d }, 3] } } }] };
    case 'year': return { $dateToString: { format: '%Y', date: d } };
  }
}
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(); const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7); return `${y}-S${String(w).padStart(2, '0')}`;
};
/** Même libellé que `bucketExpr`, calculé côté JS (comblement des périodes sans donnée). */
export function bucketLabel(d: Date, g: GroupBy): string {
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1; const p2 = (n: number) => String(n).padStart(2, '0');
  switch (g) { case 'day': return `${y}-${p2(m)}-${p2(d.getUTCDate())}`; case 'week': return isoWeek(d); case 'month': return `${y}-${p2(m)}`; case 'quarter': return `${y}-T${Math.ceil(m / 3)}`; case 'year': return String(y); }
}
/** Ajoute les périodes vides entre `from` et `to` (max 400) pour des graphiques sans trou ; sans bornes, seules les périodes avec données sont renvoyées. */
export function fillPeriods(rows: Row[], g: GroupBy, f: Pick<Filters, 'from' | 'to'>, zero: Row): Row[] {
  const sorted = [...rows].sort((a, b) => String(a['period']).localeCompare(String(b['period'])));
  if (!f.from || !f.to) return sorted;
  const by = new Map(sorted.map((r) => [String(r['period']), r])); const out: Row[] = []; const seen = new Set<string>();
  const cur = new Date(Date.UTC(f.from.getUTCFullYear(), f.from.getUTCMonth(), f.from.getUTCDate()));
  for (let i = 0; i < 4000 && cur <= f.to && out.length < 400; i++) {
    const label = bucketLabel(cur, g);
    if (!seen.has(label)) { seen.add(label); out.push(by.get(label) ?? { period: label, ...zero }); }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  for (const r of sorted) if (!seen.has(String(r['period']))) out.push(r);
  return out.sort((a, b) => String(a['period']).localeCompare(String(b['period'])));
}
export const barChart = (valueType: Chart['valueType'], label: string, rows: Row[], catKey: string, valKey: string, top?: number): Chart =>
  ({ type: 'bar', valueType, series: [{ label, points: (top ? rows.slice(0, top) : rows).map((r) => ({ label: String(r[catKey] ?? '—'), value: Number(r[valKey]) || 0 })) }] });
export const lineChart = (valueType: Chart['valueType'], series: { label: string; key: string }[], rows: Row[], catKey = 'period'): Chart =>
  ({ type: 'line', valueType, series: series.map((s) => ({ label: s.label, points: rows.map((r) => ({ label: String(r[catKey]), value: Number(r[s.key]) || 0 })) })) });
interface Named { _id: Types.ObjectId; [k: string]: unknown }
export const nameMap = async (model: { find: (q: object) => { select: (s: string) => { lean: () => Promise<unknown> } } }, ids: (Types.ObjectId | string | null | undefined)[], field = 'name') => {
  const uniq = [...new Set(ids.filter(Boolean).map(String))]; if (!uniq.length) return new Map<string, string>();
  const docs = (await model.find({ _id: { $in: uniq.map((i) => new Types.ObjectId(i)) } }).select(field).lean()) as Named[];
  return new Map(docs.map((d) => [String(d._id), String(d[field] ?? '')]));
};
export const ctxRange = (c: Ctx) => range(c.f);
