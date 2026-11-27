import type { Types } from 'mongoose';
import { Customer } from '../../models/customer.model.js';
import { DeliveryNote, Invoice, Proforma, Quotation, QuotationActivity, QuotationVersion } from '../../models/sales.model.js';
import { GoodsReceipt, PurchaseOrder, StockLevel } from '../../models/logistics.model.js';
import { PaymentTerm } from '../../models/payment-term.model.js';
import { Product, Unit } from '../../models/product.model.js';
import { Setting } from '../../models/setting.model.js';
import { ensureContactKeys, findDuplicates } from '../customers/contact-keys.js';
import { DEFAULT_PAYMENT_TERMS, delayOf, ensurePaymentTerms } from '../payment-terms/payment-term.service.js';
import { ensureFixedUnits, FIXED_UNITS, hasPrecision, matchFixed, unitDecimals } from '../products/units.js';
import { migrateQuotations } from '../quotations/quotation.migration.js';
import { snapshotOf } from '../quotations/quotation.version.js';
import type { Lean } from '../quotations/quotation.service.js';

type Id = Types.ObjectId;
export interface Incompatible { source: string; document: string; line: string; quantity: number; unit: string; allowedDecimals: number }
export interface Mission1Report {
  dryRun: boolean; executedAt: string;
  positions: Awaited<ReturnType<typeof migrateQuotations>>;
  companies: {
    companyId: string;
    paymentTerms: { toCreate: string[] };
    units: { fixed: Awaited<ReturnType<typeof ensureFixedUnits>>; historical: { code: string; name: string; products: number; recognisedAs: string | null }[] };
    incompatibleQuantities: Incompatible[];
    contactDuplicates: Awaited<ReturnType<typeof findDuplicates>>;
    quotations: { renamedToDraft: number; versionInitialised: number; referenceSnapshots: number; proformasLinkedToVersion: number };
  }[];
}

/**
 * Migration NON destructive et idempotente de la mission 1 :
 *  - conditions de paiement : proposées + textes déjà portés par les clients (aucune fiche ni document modifié) ;
 *  - unités : les unités reconnues sont réutilisées comme unités fixes, les manquantes créées ; aucune supprimée ;
 *  - quantités non conformes : SIGNALÉES, jamais arrondies ;
 *  - doublons de coordonnées : SIGNALÉS, jamais fusionnés ; registre d'unicité constitué ;
 *  - devis : « En attente » → « Brouillon », version 1, copie de RÉFÉRENCE de l'état actuel pour les devis déjà transmis ou
 *    décidés (ce n'est pas un historique). Numéros, montants, remises et documents inchangés.
 */
export async function migrateMission1(opts: { dryRun?: boolean } = {}): Promise<Mission1Report> {
  const dryRun = !!opts.dryRun; const now = new Date();
  const positions = await migrateQuotations({ dryRun });
  const report: Mission1Report = { dryRun, executedAt: now.toISOString(), positions, companies: [] };
  for (const s of await Setting.find().select('companyId').lean()) {
    const companyId = s.companyId as Id;
    // Conditions de paiement
    const existing = new Set((await PaymentTerm.find({ companyId }).select('label').lean()).map((t) => t.label.toLocaleLowerCase('fr')));
    const initialised = !!(await Setting.findOne({ companyId }).select('paymentTermsInitialisedAt').lean())?.paymentTermsInitialisedAt;
    const used = ((await Customer.distinct('paymentTerms', { companyId })) as string[]).filter((t) => !!t?.trim());
    const wanted = [...(initialised ? [] : DEFAULT_PAYMENT_TERMS.map(([l]) => l)), ...used].filter((l, i, a) => a.findIndex((x) => x.toLocaleLowerCase('fr') === l.toLocaleLowerCase('fr')) === i && !existing.has(l.toLocaleLowerCase('fr')));
    if (!dryRun) {
      await ensurePaymentTerms(companyId);
      // Seuls les textes absents sont ajoutés (une condition existante n'est pas réécrite)
      for (const label of used) if (!(await PaymentTerm.exists({ companyId, label }).collation({ locale: 'fr', strength: 2 }))) await PaymentTerm.create({ companyId, label, delayDays: delayOf(label) });
    }
    // Unités
    const fixed = await ensureFixedUnits(companyId, undefined, dryRun);
    const units = await Unit.find({ companyId }).lean();
    const adopted = new Set(fixed.filter((f) => f.action !== 'existing').map((f) => f.code));
    const historical = [];
    for (const u of units.filter((x) => !x.fixedKey && !adopted.has(x.code))) historical.push({ code: u.code, name: u.name, products: await Product.countDocuments({ companyId, unitId: u._id }), recognisedAs: matchFixed(u.code, u.name)?.name ?? null });
    const incompatibleQuantities = await incompatible(companyId, units, fixed);
    // Coordonnées
    if (!dryRun) await ensureContactKeys(companyId);
    const contactDuplicates = await findDuplicates(companyId);
    report.companies.push({ companyId: companyId.toString(), paymentTerms: { toCreate: wanted }, units: { fixed, historical }, incompatibleQuantities, contactDuplicates, quotations: await migrateVersions(companyId, dryRun, now) });
  }
  return report;
}

async function incompatible(companyId: Id, units: { _id: Id; code: string; name: string; fixedKey?: string | null; decimals?: number | null }[], fixed: { key: string; code: string }[]): Promise<Incompatible[]> {
  // Précision qui s'appliquera après migration (y compris en simulation)
  const decimalsOfUnit = (u: (typeof units)[number] | undefined) => { if (!u) return 3; const f = fixed.find((x) => x.code === u.code); return f ? FIXED_UNITS.find((d) => d.key === f.key)!.decimals : unitDecimals(u); };
  const products = new Map((await Product.find({ companyId }).select('reference unitId hasSerial').lean()).map((p) => [p._id.toString(), p]));
  const byId = new Map(units.map((u) => [u._id.toString(), u]));
  const out: Incompatible[] = [];
  const check = (source: string, document: string, productId: unknown, line: string, quantity: number | null | undefined) => {
    const p = productId ? products.get(String(productId)) : undefined; if (!p || quantity === null || quantity === undefined) return;
    const u = byId.get(String(p.unitId)); const d = p.hasSerial ? 0 : decimalsOfUnit(u);
    if (!hasPrecision(quantity, d)) out.push({ source, document, line: `${p.reference} — ${line}`, quantity, unit: u?.code ?? '', allowedDecimals: d });
  };
  const scan = async (source: string, M: typeof Quotation) => {
    for await (const d of M.find({ companyId }).select('number status lines').lean().cursor()) for (const l of d.lines ?? []) check(source, d.number ?? `brouillon ${d._id}`, l.productId, l.designation, l.quantity);
  };
  await scan('Devis', Quotation); await scan('Proforma', Proforma as never); await scan('Facture', Invoice as never); await scan('Bon de livraison', DeliveryNote as never);
  await scan('Commande d’achat', PurchaseOrder as never); await scan('Réception', GoodsReceipt as never);
  for await (const l of StockLevel.find({ companyId }).select('productId qty warehouseId').lean().cursor()) check('Stock', 'niveau actuel', l.productId, 'quantité en stock', l.qty);
  return out;
}

async function migrateVersions(companyId: Id, dryRun: boolean, now: Date) {
  const r = { renamedToDraft: 0, versionInitialised: 0, referenceSnapshots: 0, proformasLinkedToVersion: 0 };
  const raw = Quotation.collection;
  for await (const q of raw.find({ companyId }, { sort: { _id: 1 } })) {
    const $set: Record<string, unknown> = {};
    // En simulation, la première étape n'a rien écrit : un devis « en attente » déjà envoyé est compté comme envoyé
    const status = q.status === 'pending' ? (q.sentAt ? 'sent' : 'draft') : (q.status as string);
    if (q.status === 'pending' && !q.sentAt) { $set.status = 'draft'; r.renamedToDraft++; }
    if (q.version === undefined) { $set.version = 1; $set.revision = 0; r.versionInitialised++; }
    const frozen = status !== 'draft';
    const version = (q.version as number | undefined) ?? 1;
    if (frozen && status === 'accepted' && !q.acceptedVersion) $set.acceptedVersion = version;
    if (!dryRun && Object.keys($set).length) await raw.updateOne({ _id: q._id, status: q.status }, { $set });
    if (frozen && !(await QuotationVersion.exists({ companyId, quotationId: q._id }))) {
      r.referenceSnapshots++;
      if (!dryRun) {
        const doc = (await Quotation.findById(q._id).lean()) as Lean;
        await QuotationVersion.create({ companyId, quotationId: q._id, version, status: status as never, snapshot: await snapshotOf(doc), versionCreatedAt: doc.createdAt, frozenAt: now, origin: 'migration',
          sentAt: doc.sentAt, sentByName: doc.sentByName, sentTo: doc.sentTo, sentMethod: doc.sentMethod });
        // L'historique est en ajout seul : création, la clé d'événement empêchant tout doublon
        if (!(await QuotationActivity.exists({ companyId, eventKey: `migrated:${q._id}` }))) {
          await QuotationActivity.create({ companyId, quotationId: q._id, kind: 'migrated', title: 'Version de référence créée à la migration', occurredAt: now, system: true, userName: 'Système',
            description: 'Copie de l’état du devis à la date de la migration ; les modifications antérieures ne sont pas reconstituées', eventKey: `migrated:${q._id}` });
        }
      }
    }
    if (q.proformaId) {
      const p = await Proforma.collection.findOne({ _id: q.proformaId, companyId, quotationVersion: { $exists: false } }, { projection: { _id: 1 } });
      if (p) { r.proformasLinkedToVersion++; if (!dryRun) await Proforma.collection.updateOne({ _id: p._id }, { $set: { quotationVersion: version } }); }
    }
  }
  return r;
}
