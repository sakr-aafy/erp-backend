import { commercialReports } from './reports.commercial.js';
import { financialReports } from './reports.financial.js';
import { purchaseReports } from './reports.purchases.js';
import { stockReports } from './reports.stock.js';
import { GROUPS, GROUP_LABELS, type ReportDef } from './report.types.js';

/** Registre unique des rapports : la même définition alimente le catalogue, l'exécution, la pagination et les exports. */
export const REPORTS: ReportDef[] = [...commercialReports, ...financialReports, ...stockReports, ...purchaseReports];
export const findReport = (key: string) => REPORTS.find((r) => r.key === key);
/** Un rapport n'est accessible que si l'utilisateur possède `reports:view` ET toutes les permissions de ses modules sources. */
export const canRun = (has: (p: string) => boolean, r: ReportDef) => has('reports:view') && r.perms.every(has);

export function catalog(has: (p: string) => boolean) {
  return GROUPS.map((g) => ({ group: g, label: GROUP_LABELS[g], reports: REPORTS.filter((r) => r.group === g && canRun(has, r)).map((r) => ({ key: r.key, title: r.title, description: r.description, filters: r.filters, statusOptions: r.statusOptions ?? null, columns: r.columns })) })).filter((g) => g.reports.length);
}
