import PDFDocument from 'pdfkit';
import { Company } from '../models/company.model.js';
import { Setting } from '../models/setting.model.js';
import type { Types } from 'mongoose';
import { phoneDisplay } from '../utils/phone.js';

export interface PdfDoc {
  title: string;                 // « DEVIS », « FACTURE PROFORMA », « FACTURE », « FACTURE D'AVOIR », « BON DE LIVRAISON »
  mention?: string;              // ex. « PROFORMA » (mention obligatoire sur la facture proforma)
  number?: string | null | undefined; draft?: boolean;
  date: Date; secondaryDateLabel?: string; secondaryDate?: Date | null | undefined;
  customer: { name?: string | null | undefined; taxId?: string | null | undefined; address?: { street?: string | null | undefined; city?: string | null | undefined; postalCode?: string | null | undefined; country?: string | null | undefined } | null | undefined };
  /** « quotation » : colonnes du devis (Pos., Référence, …), remise affichée seulement si au moins une ligne en a, pages numérotées. */
  layout?: 'quotation';
  lines: { /** Traçabilité imprimée sous la désignation (BL d’origine, numéros de série). */ details?: string | undefined; position?: number | null | undefined; discountMinor?: number | null | undefined; reference?: string | null | undefined; designation: string; unit?: string | null | undefined; quantity: number; unitPriceMinor: number; discountPct?: number | null | undefined; netHtMinor?: number | null | undefined; vat: { code?: string | null | undefined; ratePct?: number | null | undefined; regime?: string | null | undefined } }[];
  totals: { grossMinor?: number | null | undefined; lineDiscountsMinor?: number | null | undefined; globalDiscountMinor?: number | null | undefined; totalHtMinor?: number | null | undefined;
    vatGroups?: { vatCode?: string | null | undefined; regime?: string | null | undefined; ratePct?: number | null | undefined; baseMinor?: number | null | undefined; vatMinor?: number | null | undefined }[] | null | undefined;
    totalVatMinor?: number | null | undefined; totalTtcMinor?: number | null | undefined; stampMinor?: number | null | undefined; withholdingMinor?: number | null | undefined; totalPayableMinor?: number | null | undefined };
  withholdingLabel?: string; showPrices?: boolean; schedule?: { dueDate: Date; amountMinor: number; percent?: number | null | undefined }[]; notes?: string | null | undefined; terms?: string | null | undefined;
  extra?: [string, string][];
  paymentTerms?: string | null | undefined;
  /** Texte libre (devis, proforma) : imprimé tel quel, jamais converti en date. */
  deliveryTime?: string | null | undefined;
  /** Devis : numéro de la version imprimée. */
  version?: number | undefined;
  /** Document antérieur : remise globale en % appliquée au total, nommée comme telle au récapitulatif. */
  legacyDiscountPct?: number | null | undefined;
  deliveryAddress?: { label?: string | null | undefined; street?: string | null | undefined; city?: string | null | undefined; postalCode?: string | null | undefined; country?: string | null | undefined;
    contactName?: string | null | undefined; contactPhone?: string | null | undefined; instructions?: string | null | undefined } | null | undefined;
}

const REGIME: Record<string, string> = { zero: 'TVA 0 %', exempt: 'Exonéré', suspended: 'Suspension de TVA' };

export async function renderDocumentPdf(companyId: Types.ObjectId, d: PdfDoc): Promise<Buffer> {
  const [company, settings] = await Promise.all([Company.findById(companyId).lean(), Setting.findOne({ companyId }).lean()]);
  const dec = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.decimals ?? 3;
  const cur = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.symbol ?? settings?.baseCurrency ?? '';
  // La police standard du PDF ignore l'espace fine insécable (U+202F) du format français : espace insécable classique
  const m = (v: number | null | undefined) => ((v ?? 0) / 10 ** dec).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).replace(/\u202f/g, '\u00a0');
  const dt = (x: Date) => new Date(x).toLocaleDateString('fr-FR', { timeZone: 'UTC' });

  const quote = d.layout === 'quotation';
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: quote, compress: process.env.NODE_ENV !== 'test', info: { Title: `${d.title} ${d.number ?? ''}` } }); // flux non compressé en test : le contenu est vérifiable
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  const L = 40; const R = doc.page.width - 40; const W = R - L;

  // En-tête : société à gauche, type + numéro à droite
  doc.font('Helvetica-Bold').fontSize(14).text(company?.name ?? '', L, 40, { width: W / 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#444').text([company?.address, company?.phone, company?.email, company?.taxId ? `MF : ${company.taxId}` : ''].filter(Boolean).join('\n'), L, doc.y, { width: W / 2 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text(d.title, L + W / 2, 40, { width: W / 2, align: 'right' });
  doc.fontSize(11).text(d.draft ? 'BROUILLON' : (d.number ?? ''), L + W / 2, doc.y, { width: W / 2, align: 'right' });
  if (d.version) doc.font('Helvetica').fontSize(9).text(`Version ${d.version}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`Date : ${dt(d.date)}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  if (d.secondaryDate) doc.text(`${d.secondaryDateLabel} : ${dt(d.secondaryDate)}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  for (const [k, v] of d.extra ?? []) doc.text(`${k} : ${v}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  if (d.mention) { doc.font('Helvetica-Bold').fontSize(22).fillColor('#c0392b').text(d.mention, L + W / 2, doc.y + 4, { width: W / 2, align: 'right' }); doc.fillColor('#000'); }

  // Client
  doc.y = Math.max(doc.y, 130) + 6;
  const cy = doc.y;
  const a = d.customer.address;
  doc.font('Helvetica-Bold').fontSize(10).text(d.customer.name ?? '', L + W / 2 + 8, cy + 6, { width: W / 2 - 16 });
  doc.font('Helvetica').fontSize(9).text([[a?.street].filter(Boolean).join(''), [a?.postalCode, a?.city].filter(Boolean).join(' '), d.customer.taxId ? `MF : ${d.customer.taxId}` : ''].filter(Boolean).join('\n'), L + W / 2 + 8, doc.y, { width: W / 2 - 16 });
  let boxBottom = Math.max(doc.y + 6, cy + 62);
  const s = d.deliveryAddress;
  if (s) { // adresse de livraison à gauche du bloc client
    doc.font('Helvetica').fontSize(8).fillColor('#666').text('LIVRAISON', L + 8, cy + 6, { width: W / 2 - 24 }).fillColor('#000');
    if (s.label) doc.font('Helvetica-Bold').fontSize(9).text(s.label, L + 8, doc.y, { width: W / 2 - 24 });
    doc.font('Helvetica').fontSize(9).text([s.street, [s.postalCode, s.city].filter(Boolean).join(' '), s.country,
      [s.contactName, phoneDisplay(s.contactPhone, s.country)].filter(Boolean).join(' — '), s.instructions].filter(Boolean).join('\n'), L + 8, doc.y, { width: W / 2 - 24 });
    boxBottom = Math.max(boxBottom, doc.y + 6);
    doc.rect(L, cy, W / 2 - 8, boxBottom - cy).stroke('#bbb');
  }
  doc.rect(L + W / 2, cy, W / 2, boxBottom - cy).stroke('#bbb');
  doc.y = boxBottom + 12;

  // Tableau des lignes
  const showPrices = d.showPrices !== false;
  if (quote) quotationTable(doc, d, { L, R, W, m, cur });
  else {
  const cols = showPrices
    ? [{ h: 'Réf.', w: 55 }, { h: 'Désignation', w: 175 }, { h: 'Qté', w: 40, r: true }, { h: 'P.U. HT', w: 60, r: true }, { h: 'Rem.%', w: 38, r: true }, { h: 'TVA', w: 40, r: true }, { h: 'Total HT', w: 107, r: true }]
    : [{ h: 'Réf.', w: 90 }, { h: 'Désignation', w: 320 }, { h: 'Unité', w: 50 }, { h: 'Quantité', w: 55, r: true }];
  const head = () => {
    const y = doc.y; doc.rect(L, y, W, 16).fill('#eef1f6'); doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
    let x = L; for (const c of cols) { doc.text(c.h, x + 3, y + 4, { width: c.w - 6, align: c.r ? 'right' : 'left' }); x += c.w; }
    doc.y = y + 20; doc.font('Helvetica').fontSize(8.5);
  };
  head();
  for (const l of d.lines) {
    const text = l.details ? `${l.designation}\n${l.details}` : l.designation;
    // Une ligne et sa traçabilité ne sont jamais coupées entre deux pages
    doc.font('Helvetica').fontSize(8.5); const need = doc.heightOfString(text, { width: cols[1]!.w - 6 });
    if (doc.y > doc.page.height - 200 || doc.y + need > doc.page.height - 80) { doc.addPage(); head(); }
    const y = doc.y; let x = L;
    const vals = showPrices
      ? [l.reference ?? '', text, fr(l.quantity, 3), m(l.unitPriceMinor), l.discountPct ? fr(l.discountPct, 2) : '', l.vat.regime === 'taxable' ? `${l.vat.ratePct}%` : (REGIME[l.vat.regime ?? ''] ?? '—').replace('TVA ', ''), m(l.netHtMinor)]
      : [l.reference ?? '', text, l.unit ?? '', fr(l.quantity, 3)];
    let h = 12;
    cols.forEach((c, i) => { const t = vals[i]!; const hh = doc.heightOfString(t, { width: c.w - 6 }); h = Math.max(h, hh); doc.text(t, x + 3, y, { width: c.w - 6, align: c.r ? 'right' : 'left' }); x += c.w; });
    doc.y = y + h + 4; doc.moveTo(L, doc.y - 2).lineTo(R, doc.y - 2).stroke('#e5e8ee');
  }
  }

  // Totaux
  if (showPrices) {
    // Le récapitulatif reste groupé : nouvelle page s'il ne tient pas entièrement
    const needed = quote ? 80 + (d.totals.vatGroups?.length ?? 0) * 13 : 150;
    if (doc.y > doc.page.height - 40 - needed) doc.addPage();
    doc.moveDown(0.6); const ty = doc.y; const tx = L + W - 230;
    const row = (k: string, v: string, bold = false) => { const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).text(k, tx, y, { width: 130 }); doc.text(v, tx + 130, y, { width: 100, align: 'right' }); doc.y = y + (bold ? 15 : 13); };
    const t = d.totals;
    // Les remises de ligne et la remise supplémentaire (répartie entre les factures partielles) sont présentées séparément
    if ((t.lineDiscountsMinor ?? 0) > 0) row('Remises sur les lignes', `- ${m(t.lineDiscountsMinor)}`);
    if ((t.globalDiscountMinor ?? 0) > 0) row((d.legacyDiscountPct ?? 0) > 0 ? `Remise globale (${fr(d.legacyDiscountPct!, 2)} %)` : 'Remise supplémentaire', `- ${m(t.globalDiscountMinor)}`);
    row('Total HT', m(t.totalHtMinor));
    for (const g of t.vatGroups ?? []) row(g.regime === 'taxable' ? `TVA ${g.ratePct} % (base ${m(g.baseMinor)})` : `${REGIME[g.regime ?? ''] ?? g.vatCode} (base ${m(g.baseMinor)})`, g.regime === 'taxable' ? m(g.vatMinor) : '—');
    row('Total TVA', m(t.totalVatMinor)); row('Total TTC', m(t.totalTtcMinor), true);
    if ((t.stampMinor ?? 0) > 0) row('Timbre fiscal', m(t.stampMinor));
    if ((t.withholdingMinor ?? 0) > 0) row(d.withholdingLabel ?? 'Retenue à la source', `- ${m(t.withholdingMinor)}`);
    if ((t.stampMinor ?? 0) > 0 || (t.withholdingMinor ?? 0) > 0) row(`Net à payer (${cur})`, m(t.totalPayableMinor), true);
    doc.y = Math.max(doc.y, ty);
    // En brouillon, les montants des échéances ne sont pas encore calculés : le pourcentage saisi est imprimé
    if (d.schedule?.length) { doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9).text('Échéancier', L); doc.font('Helvetica'); for (const s of d.schedule) doc.text(`${dt(s.dueDate)} — ${d.draft && !s.amountMinor ? `${s.percent ?? 0} %` : `${m(s.amountMinor)} ${cur}`}`, L); }
  }
  if (d.paymentTerms) doc.moveDown().font('Helvetica').fontSize(8.5).fillColor('#444').text(`Conditions de paiement : ${d.paymentTerms}`, L, doc.y, { width: W });
  if (d.deliveryTime) doc.moveDown(0.6).font('Helvetica').fontSize(8.5).fillColor('#444').text(`Délai de livraison : ${d.deliveryTime}`, L, doc.y, { width: W });
  if (d.terms) doc.moveDown().font('Helvetica').fontSize(8.5).fillColor('#444').text(`Conditions : ${d.terms}`, L, doc.y, { width: W });
  if (d.notes) doc.moveDown(0.5).fillColor('#444').text(d.notes, L, doc.y, { width: W });
  const pages = quote ? doc.bufferedPageRange().count : 1;
  for (let i = 0; i < pages; i++) {
    if (quote) doc.switchToPage(i);
    doc.page.margins.bottom = 0; // le pied de page est dans la marge basse : sans cela il serait rejeté sur une page vide
    doc.font('Helvetica').fillColor('#888').fontSize(7.5).text(`${company?.name ?? ''} — montants en ${cur}${quote && pages > 1 ? ` — page ${i + 1} / ${pages}` : ''}`, L, doc.page.height - 40, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

interface Layout { L: number; R: number; W: number; m: (v: number | null | undefined) => string; cur: string }
interface Col { h: string; w: number; r?: boolean; wrap?: boolean }
const fr = (v: number, max: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: max }).replace(/\u202f/g, '\u00a0');
const VAT_SHORT: Record<string, string> = { zero: '0 %', exempt: 'Exonéré', suspended: 'Suspendue' };

/**
 * Tableau du devis : Pos. | Référence | Désignation | Qté | P.U. HT | Rem.% | TVA | Total HT.
 * Remise : colonne absente si aucune ligne n'a de remise (sa largeur revient à la désignation) ; sinon « — » pour les lignes
 * sans remise. Une remise de ligne exprimée en montant reste un montant. La remise globale n'apparaît qu'au récapitulatif.
 */
function quotationTable(doc: PDFKit.PDFDocument, d: PdfDoc, { L, R, W, m, cur }: Layout) {
  const discounted = (l: PdfDoc['lines'][number]) => (l.discountPct ?? 0) > 0 || (l.discountMinor ?? 0) > 0;
  const showDiscount = d.lines.some(discounted);
  const cols: Col[] = [{ h: 'Pos.', w: 30 }, { h: 'Référence', w: 66, wrap: true }, { h: 'Désignation', w: 0, wrap: true }, { h: 'Qté', w: 34, r: true }, { h: 'P.U. HT', w: 68, r: true },
    ...(showDiscount ? [{ h: 'Rem.%', w: 40, r: true }] : []), { h: 'TVA', w: 44, r: true }, { h: 'Total HT', w: 76, r: true }];
  cols[2]!.w = W - cols.reduce((s, c) => s + c.w, 0);
  const bottom = () => doc.page.height - 62; // au-dessus du pied de page
  const SIZE = 8.5;
  const head = () => {
    const y = doc.y; doc.rect(L, y, W, 18).fill('#eef1f6'); doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
    let x = L; for (const c of cols) { doc.text(c.h, x + 3, y + 5, { width: c.w - 6, align: c.r ? 'right' : 'left', lineBreak: false }); x += c.w; }
    doc.y = y + 22; doc.font('Helvetica').fontSize(SIZE);
  };
  const continuation = () => { doc.addPage(); doc.font('Helvetica-Bold').fontSize(9).fillColor('#444').text(`${d.title} ${d.number ?? ''} (suite) — ${d.customer.name ?? ''}`, L, 40, { width: W }); doc.fillColor('#000'); doc.moveDown(0.5); head(); };
  if (doc.y > bottom() - 60) { doc.addPage(); doc.y = 40; }
  head();
  for (const [i, l] of d.lines.entries()) {
    const discount = (l.discountPct ?? 0) > 0 ? `${fr(l.discountPct!, 2)} %` : (l.discountMinor ?? 0) > 0 ? `- ${m(l.discountMinor)}` : '—';
    const vals = [String(l.position ?? (i + 1) * 10), l.reference ?? '', l.designation, fr(l.quantity, 3), m(l.unitPriceMinor), ...(showDiscount ? [discount] : []),
      l.vat.regime === 'taxable' || !l.vat.regime ? `${fr(l.vat.ratePct ?? 0, 2)} %` : VAT_SHORT[l.vat.regime] ?? '—', m(l.netHtMinor)];
    doc.font('Helvetica').fontSize(SIZE);
    const h = Math.max(12, ...cols.map((c, k) => (c.wrap ? doc.heightOfString(vals[k]!, { width: c.w - 6 }) : 0)));
    if (doc.y + h > bottom()) continuation(); // une ligne n'est jamais coupée entre deux pages
    const y = doc.y; let x = L;
    cols.forEach((c, k) => {
      const t = vals[k]!;
      // Montants sur une seule ligne : la taille se réduit si nécessaire pour ne jamais déborder
      let size = SIZE; doc.font(k === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      if (!c.wrap) while (size > 5 && doc.widthOfString(t) > c.w - 6) doc.fontSize(--size);
      doc.text(t, x + 3, y, { width: c.w - 6, align: c.r ? 'right' : 'left', ...(!c.wrap && { lineBreak: false }) }); x += c.w;
    });
    doc.y = y + h + 5; doc.moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).stroke('#e5e8ee');
  }
  doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(`Montants en ${cur}`, L, doc.y, { width: W, align: 'right' }); doc.fillColor('#000');
}
