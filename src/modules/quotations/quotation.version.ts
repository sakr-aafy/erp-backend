import { Types, type ClientSession } from 'mongoose';
import { QuotationVersion, type VERSION_STATUSES } from '../../models/sales.model.js';
import { Setting } from '../../models/setting.model.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile, openFile, putFile, QUOTATION_BUCKET } from '../customers/customer.files.js';
import { pdfOf } from '../sales/document.pdf.js';
import type { Lean } from './quotation.service.js';

type Id = Types.ObjectId;
export const VERSION_STATUS_LABEL: Record<string, string> = { draft: 'Brouillon', sent: 'Envoyée', accepted: 'Acceptée', refused: 'Refusée', expired: 'Expirée', cancelled: 'Annulée', superseded: 'Remplacée', abandoned: 'Brouillon abandonné' };

/** Champs d'un devis qui composent le contenu d'une version : tout est copié, rien n'est relu dans les référentiels ensuite. */
export const CONTENT = ['customerId', 'customerSnapshot', 'issueDate', 'validUntil', 'lines', 'globalDiscountPct', 'syncDiscountPct', 'globalDiscountMinor', 'withholdingOperationType', 'withholding', 'stamp', 'totals',
  'notes', 'terms', 'paymentTerms', 'paymentTermsCustom', 'deliveryAddress', 'deliveryTime'] as const;

export async function snapshotOf(q: Lean, session?: ClientSession) {
  const s = await Setting.findOne({ companyId: q.companyId }).session(session ?? null).lean();
  const cur = s?.currencies.find((c) => c.code === s.baseCurrency);
  const content = Object.fromEntries(CONTENT.filter((k) => (q as unknown as Record<string, unknown>)[k] !== undefined).map((k) => [k, (q as unknown as Record<string, unknown>)[k]]));
  return { number: q.number, version: q.version ?? 1, ...content, currency: { code: cur?.code ?? s?.baseCurrency ?? 'TND', symbol: cur?.symbol ?? null, decimals: cur?.decimals ?? 3 } };
}

export interface SendMeta { sentAt?: Date | undefined; sentByName?: string | undefined; sentTo?: string | null | undefined; sentMethod?: string | undefined }
/** Enregistre la version courante (une seule fois par numéro de version), avec son PDF lorsqu'il vient d'être transmis. */
export async function freeze(q: Lean, status: (typeof VERSION_STATUSES)[number], opts: { session: ClientSession; meta?: SendMeta; pdfFileId?: Id | undefined; origin?: 'application' | 'migration'; authorName?: string | undefined }) {
  const version = q.version ?? 1;
  const found = await QuotationVersion.findOne({ companyId: q.companyId, quotationId: q._id, version }).session(opts.session).lean();
  if (found) return found;
  const [v] = await QuotationVersion.create([{ companyId: q.companyId, quotationId: q._id, version, status, snapshot: await snapshotOf(q, opts.session), versionCreatedAt: q.versionCreatedAt ?? q.createdAt,
    authorName: q.versionCreatedByName ?? opts.authorName, frozenAt: new Date(), ...opts.meta, origin: opts.origin ?? 'application', ...(opts.pdfFileId && { pdfFileId: opts.pdfFileId }) }] as never[], { session: opts.session });
  return v!.toObject();
}
export const setVersionStatus = (companyId: Id, quotationId: Id, version: number, status: (typeof VERSION_STATUSES)[number], session: ClientSession, meta: SendMeta = {}) =>
  QuotationVersion.updateOne({ companyId, quotationId, version }, { $set: { status, ...meta } }, { session });

export const storePdf = (companyId: Id, quotationId: Id, number: string, version: number, pdf: Buffer) => putFile(companyId, quotationId, `${number}-v${version}.pdf`, 'application/pdf', pdf, QUOTATION_BUCKET);
export const dropPdf = (fileId: Id) => deleteFile(fileId, QUOTATION_BUCKET);
const read = (fileId: Id) => new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; openFile(fileId, QUOTATION_BUCKET).on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks))); });

/** Données d'affichage et d'impression d'une version figée. */
export function viewOf(snapshot: Record<string, any>) {
  return { ...snapshot, customer: snapshot.customerSnapshot, customerId: String(snapshot.customerId),
    lines: (snapshot.lines ?? []).map((l: Record<string, any>, i: number) => ({ ...l, id: String(l._id), productId: l.productId ? String(l.productId) : undefined, position: l.position ?? (i + 1) * 10 })) };
}

/** Liste des versions, la plus récente d'abord ; le brouillon en cours (non figé) apparaît en tête. */
export async function listVersions(q: Lean, current: { status: string; totals: { totalHtMinor?: number | null; totalTtcMinor?: number | null } }) {
  const records = await QuotationVersion.find({ companyId: q.companyId, quotationId: q._id }).sort({ version: -1 }).select('-snapshot.lines').lean();
  const version = q.version ?? 1;
  const row = (r: (typeof records)[number]) => {
    const t = (r.snapshot as { totals?: { totalHtMinor?: number; totalTtcMinor?: number } }).totals;
    return { version: r.version, status: r.status as string, statusLabel: VERSION_STATUS_LABEL[r.status] ?? r.status, current: r.version === version, accepted: q.acceptedVersion === r.version, frozen: true,
      createdAt: r.versionCreatedAt ?? r.frozenAt, author: r.authorName ?? null, sentAt: r.sentAt ?? null, sentTo: r.sentTo ?? null, origin: r.origin ?? 'application', frozenAt: r.frozenAt,
      totalHtMinor: t?.totalHtMinor ?? 0, totalTtcMinor: t?.totalTtcMinor ?? 0 };
  };
  const items = records.map(row);
  if (!records.some((r) => r.version === version)) {
    items.unshift({ version, status: current.status === 'draft' ? 'draft' : current.status, statusLabel: VERSION_STATUS_LABEL[current.status] ?? current.status, current: true, accepted: q.acceptedVersion === version, frozen: false,
      createdAt: q.versionCreatedAt ?? q.createdAt!, author: q.versionCreatedByName ?? null, sentAt: q.sentAt ?? null, sentTo: q.sentTo ?? null, origin: 'application', frozenAt: null as never,
      totalHtMinor: current.totals.totalHtMinor ?? 0, totalTtcMinor: current.totals.totalTtcMinor ?? 0 });
  }
  return items.sort((a, b) => b.version - a.version);
}

export async function versionRecord(companyId: Id, quotationId: Id, version: number) {
  const r = await QuotationVersion.findOne({ companyId, quotationId, version }).lean();
  if (!r) throw AppError.notFound('Version introuvable');
  return r;
}
/** PDF d'une version figée : le fichier produit au moment du gel ; à défaut (version de référence), rendu depuis sa copie. */
export async function versionPdf(companyId: Id, r: { pdfFileId?: Id | null; snapshot: unknown }) {
  if (r.pdfFileId) return read(r.pdfFileId);
  return pdfOf(companyId, 'quotation', viewOf(r.snapshot as Record<string, any>));
}
