/** Catalogue des permissions : `<module>:<action>`. Les 16 modules du cahier + modules d'administration. */
export const ERP_MODULES = [
  'customers', 'products', 'suppliers', 'quotations', 'proformas', 'invoices', 'deliveryNotes',
  'purchases', 'inventory', 'imports', 'costCalculation', 'expenses', 'accounting', 'treasury',
  'reports', 'users',
] as const;
export const ADMIN_MODULES = ['roles', 'settings', 'audit'] as const;
export const ALL_MODULES = [...ERP_MODULES, ...ADMIN_MODULES] as const;
export const ACTIONS = ['view', 'create', 'update', 'validate', 'delete'] as const;

export type ModuleKey = (typeof ALL_MODULES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${ModuleKey}:${Action}`;

export const ALL_PERMISSIONS: Permission[] = ALL_MODULES.flatMap((m) => ACTIONS.map((a) => `${m}:${a}` as Permission));
export const isValidPermission = (p: string): p is Permission => (ALL_PERMISSIONS as string[]).includes(p);
