import type { Types } from 'mongoose';

export type Id = Types.ObjectId;
export type Row = Record<string, unknown>;
export const GROUPS = ['commercial', 'financial', 'stock', 'purchases', 'imports'] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABELS: Record<Group, string> = { commercial: 'Commercial', financial: 'Financier', stock: 'Stock', purchases: 'Achats', imports: 'Importations' };
export const GROUP_BY = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type GroupBy = (typeof GROUP_BY)[number];
/** Filtres connus : chaque rapport déclare ceux qu'il utilise ; le front n'affiche que ceux-là. */
export const FILTER_KEYS = ['period', 'groupBy', 'customerId', 'supplierId', 'productId', 'categoryId', 'warehouseId', 'status', 'currency', 'userId', 'reason', 'accountId', 'asOf'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export interface Filters {
  from?: Date | undefined; to?: Date | undefined; groupBy: GroupBy; asOf?: Date | undefined;
  customerId?: string | undefined; supplierId?: string | undefined; productId?: string | undefined; categoryId?: string | undefined; warehouseId?: string | undefined;
  status?: string | undefined; currency?: string | undefined; userId?: string | undefined; reason?: string | undefined; accountId?: string | undefined;
}
export interface Ctx { companyId: Id; f: Filters }
export type ColType = 'text' | 'money' | 'qty' | 'int' | 'date' | 'pct';
export interface Col { key: string; label: string; type?: ColType }
export interface Kpi { label: string; value: number | string; type?: ColType }
export interface ChartSeries { label: string; points: { label: string; value: number }[] }
export interface Chart { type: 'bar' | 'line'; valueType: 'money' | 'qty' | 'int' | 'pct'; series: ChartSeries[] }
export interface Result { rows: Row[]; totals?: Row; kpis?: Kpi[]; chart?: Chart; note?: string; truncated?: boolean }
export interface ReportDef {
  key: string; group: Group; title: string; description: string;
  /** TOUTES ces permissions sont exigées (en plus de `reports:view`). */
  perms: string[]; filters: FilterKey[]; statusOptions?: { value: string; label: string }[]; columns: Col[];
  run: (c: Ctx) => Promise<Result>;
}
export const MAX_ROWS = 20000;
