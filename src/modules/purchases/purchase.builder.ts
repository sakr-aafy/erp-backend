import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { Product } from '../../models/product.model.js';
import { Supplier } from '../../models/supplier.model.js';
import { AppError } from '../../utils/errors.js';
import { objectId } from '../../utils/pagination.js';
import { minorInt } from '../parties/party.shared.js';
import { CalculationError, computeDocument, type CalcLine, type DocTotals, type VatRegime } from '../../services/calculation.service.js';
import { resolveVat } from '../../services/fiscal.service.js';

type Id = Types.ObjectId;
export const purchaseLineBody = z.object({
  productId: objectId.optional(), designation: z.string().trim().min(1).max(300).optional(), quantity: z.number().gt(0).max(1e9).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, '3 décimales maximum'),
  unitPriceMinor: minorInt.optional(), discountPct: z.number().min(0).max(100).default(0), vatCode: z.string().trim().min(1).max(30).optional(), orderLineId: objectId.optional(),
}).strict();
export type PurchaseLineInput = z.infer<typeof purchaseLineBody>;
export interface BuiltPurchaseLine { productId?: Id; reference?: string | undefined; designation: string; unit?: string | undefined; quantity: number; unitPriceMinor: number; discountPct: number; vat: { ruleId: Id; code: string; regime: VatRegime; ratePct: number };
  grossMinor: number; discountMinor: number; netHtMinor: number; globalShareMinor: number; receivedQty: number; receivedValueMinor: number; invoicedQty: number; orderLineId?: string | undefined }

/** Supplier valide ; les fournisseurs étrangers relèvent des dossiers d'importation. */
export async function loadSupplier(companyId: Id, id: string | Id, session?: ClientSession, allowForeign = false) {
  const s = await Supplier.findOne({ _id: id, companyId }).session(session ?? null).lean();
  if (!s) throw AppError.badRequest('Fournisseur invalide');
  if (s.isForeign && !allowForeign) throw AppError.badRequest('Fournisseur étranger : utilisez un dossier d’importation');
  return s;
}

/** Lignes d'achat : prix d'achat et TVA de l'article par défaut (TVA résolue par les règles fiscales validées), totaux via le service de calcul unique. */
export async function buildPurchaseLines(companyId: Id, lines: PurchaseLineInput[], date: Date, session?: ClientSession, opts: { checkStatus?: boolean } = {}) {
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean) as string[])];
  const products = ids.length ? await Product.find({ _id: { $in: ids }, companyId }).session(session ?? null).populate('unitId', 'code').lean() : [];
  const byId = new Map(products.map((p) => [p._id.toString(), p])); const cache = new Map<string, Awaited<ReturnType<typeof resolveVat>>>();
  const built: BuiltPurchaseLine[] = [];
  for (const [i, l] of lines.entries()) {
    const p = l.productId ? byId.get(l.productId) : undefined;
    if (l.productId && !p) throw AppError.badRequest(`Ligne ${i + 1} : article introuvable`);
    // Nouvelle commande : seul un article ACTIF peut être acheté (les factures d'achat d'opérations passées restent enregistrables)
    if (p && opts.checkStatus) { const st = p.status ?? (p.isActive === false ? 'inactive' : 'active'); if (st !== 'active') throw new AppError(409, `Ligne ${i + 1} : l'article « ${p.reference} » est ${({ inactive: 'inactif', blocked: 'bloqué', archived: 'archivé' } as Record<string, string>)[st] ?? st} : achat impossible`, `PRODUCT_${st.toUpperCase()}`); }
    const designation = l.designation ?? p?.name; const unitPriceMinor = l.unitPriceMinor ?? p?.purchasePriceMinor; const vatCode = (l.vatCode ?? p?.vatRateCode)?.toUpperCase();
    if (!designation) throw AppError.badRequest(`Ligne ${i + 1} : désignation requise`);
    if (unitPriceMinor === undefined) throw AppError.badRequest(`Ligne ${i + 1} : prix unitaire requis`);
    if (!vatCode) throw AppError.badRequest(`Ligne ${i + 1} : code de TVA requis (aucun taux par défaut)`);
    if (!cache.has(vatCode)) cache.set(vatCode, await resolveVat(companyId, vatCode, date, session));
    const v = cache.get(vatCode)!;
    built.push({ ...(p && { productId: p._id }), reference: p?.reference, designation, unit: (p?.unitId as { code?: string } | undefined)?.code, quantity: l.quantity, unitPriceMinor, discountPct: l.discountPct ?? 0,
      vat: { ruleId: v.ruleId, code: v.code, regime: v.regime, ratePct: v.ratePct }, grossMinor: 0, discountMinor: 0, netHtMinor: 0, globalShareMinor: 0, receivedQty: 0, receivedValueMinor: 0, invoicedQty: 0, orderLineId: l.orderLineId });
  }
  const calc: CalcLine[] = built.map((l) => ({ quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountPct: l.discountPct, vatCode: l.vat.code, vatRegime: l.vat.regime, vatRatePct: l.vat.ratePct }));
  let totals: DocTotals;
  try { const r = computeDocument({ lines: calc }); totals = r.totals; r.lines.forEach((x, i) => { built[i]!.grossMinor = x.grossMinor; built[i]!.discountMinor = x.discountMinor; built[i]!.netHtMinor = x.netHtMinor; }); }
  catch (e) { if (e instanceof CalculationError) throw new AppError(422, e.message, 'CALCULATION_ERROR'); throw e; }
  return { lines: built, totals };
}
