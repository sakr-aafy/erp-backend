import PDFDocument from 'pdfkit';
import { Company } from '../models/company.model.js';
import { Setting } from '../models/setting.model.js';
import type { Types } from 'mongoose';

export interface PdfDoc {
  title: string;                 // « DEVIS », « FACTURE PROFORMA », « FACTURE », « FACTURE D'AVOIR », « BON DE LIVRAISON »
  mention?: string;              // ex. « PROFORMA » (mention obligatoire sur la facture proforma)
  number?: string | null | undefined; draft?: boolean;
  date: Date; secondaryDateLabel?: string; secondaryDate?: Date | null | undefined;
  customer: { name?: string | null | undefined; taxId?: string | null | undefined; address?: { street?: string | null | undefined; city?: string | null | undefined; postalCode?: string | null | undefined; country?: string | null | undefined } | null | undefined };
  lines: { reference?: string | null | undefined; designation: string; unit?: string | null | undefined; quantity: number; unitPriceMinor: number; discountPct?: number | null | undefined; netHtMinor?: number | null | undefined; vat: { code?: string | null | undefined; ratePct?: number | null | undefined; regime?: string | null | undefined } }[];
  totals: { grossMinor?: number | null | undefined; lineDiscountsMinor?: number | null | undefined; globalDiscountMinor?: number | null | undefined; totalHtMinor?: number | null | undefined;
    vatGroups?: { vatCode?: string | null | undefined; regime?: string | null | undefined; ratePct?: number | null | undefined; baseMinor?: number | null | undefined; vatMinor?: number | null | undefined }[] | null | undefined;
    totalVatMinor?: number | null | undefined; totalTtcMinor?: number | null | undefined; stampMinor?: number | null | undefined; withholdingMinor?: number | null | undefined; totalPayableMinor?: number | null | undefined };
  withholdingLabel?: string; showPrices?: boolean; schedule?: { dueDate: Date; amountMinor: number }[]; notes?: string | null | undefined; terms?: string | null | undefined;
  extra?: [string, string][];
}

const REGIME: Record<string, string> = { zero: 'TVA 0 %', exempt: 'Exonéré', suspended: 'Suspension de TVA' };

export async function renderDocumentPdf(companyId: Types.ObjectId, d: PdfDoc): Promise<Buffer> {
  const [company, settings] = await Promise.all([Company.findById(companyId).lean(), Setting.findOne({ companyId }).lean()]);
  const dec = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.decimals ?? 3;
  const cur = settings?.currencies.find((c) => c.code === settings.baseCurrency)?.symbol ?? settings?.baseCurrency ?? '';
  const m = (v: number | null | undefined) => ((v ?? 0) / 10 ** dec).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const dt = (x: Date) => new Date(x).toLocaleDateString('fr-FR', { timeZone: 'UTC' });

  const doc = new PDFDocument({ size: 'A4', margin: 40, compress: process.env.NODE_ENV !== 'test', info: { Title: `${d.title} ${d.number ?? ''}` } }); // flux non compressé en test : le contenu est vérifiable
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  const L = 40; const R = doc.page.width - 40; const W = R - L;

  // En-tête : société à gauche, type + numéro à droite
  doc.font('Helvetica-Bold').fontSize(14).text(company?.name ?? '', L, 40, { width: W / 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#444').text([company?.address, company?.phone, company?.email, company?.taxId ? `MF : ${company.taxId}` : ''].filter(Boolean).join('\n'), L, doc.y, { width: W / 2 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text(d.title, L + W / 2, 40, { width: W / 2, align: 'right' });
  doc.fontSize(11).text(d.draft ? 'BROUILLON' : (d.number ?? ''), L + W / 2, doc.y, { width: W / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`Date : ${dt(d.date)}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  if (d.secondaryDate) doc.text(`${d.secondaryDateLabel} : ${dt(d.secondaryDate)}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  for (const [k, v] of d.extra ?? []) doc.text(`${k} : ${v}`, L + W / 2, doc.y, { width: W / 2, align: 'right' });
  if (d.mention) { doc.font('Helvetica-Bold').fontSize(22).fillColor('#c0392b').text(d.mention, L + W / 2, doc.y + 4, { width: W / 2, align: 'right' }); doc.fillColor('#000'); }

  // Client
  doc.y = Math.max(doc.y, 130) + 6;
  const cy = doc.y; doc.rect(L + W / 2, cy, W / 2, 62).stroke('#bbb');
  const a = d.customer.address;
  doc.font('Helvetica-Bold').fontSize(10).text(d.customer.name ?? '', L + W / 2 + 8, cy + 6, { width: W / 2 - 16 });
  doc.font('Helvetica').fontSize(9).text([[a?.street].filter(Boolean).join(''), [a?.postalCode, a?.city].filter(Boolean).join(' '), d.customer.taxId ? `MF : ${d.customer.taxId}` : ''].filter(Boolean).join('\n'), L + W / 2 + 8, doc.y, { width: W / 2 - 16 });
  doc.y = cy + 74;

  // Tableau des lignes
  const showPrices = d.showPrices !== false;
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
    if (doc.y > doc.page.height - 200) { doc.addPage(); head(); }
    const y = doc.y; let x = L;
    const vals = showPrices
      ? [l.reference ?? '', l.designation, String(l.quantity), m(l.unitPriceMinor), l.discountPct ? String(l.discountPct) : '', l.vat.regime === 'taxable' ? `${l.vat.ratePct}%` : (REGIME[l.vat.regime ?? ''] ?? '—').replace('TVA ', ''), m(l.netHtMinor)]
      : [l.reference ?? '', l.designation, l.unit ?? '', String(l.quantity)];
    let h = 12;
    cols.forEach((c, i) => { const t = vals[i]!; const hh = doc.heightOfString(t, { width: c.w - 6 }); h = Math.max(h, hh); doc.text(t, x + 3, y, { width: c.w - 6, align: c.r ? 'right' : 'left' }); x += c.w; });
    doc.y = y + h + 4; doc.moveTo(L, doc.y - 2).lineTo(R, doc.y - 2).stroke('#e5e8ee');
  }

  // Totaux
  if (showPrices) {
    if (doc.y > doc.page.height - 190) doc.addPage();
    doc.moveDown(0.6); const ty = doc.y; const tx = L + W - 230;
    const row = (k: string, v: string, bold = false) => { const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).text(k, tx, y, { width: 130 }); doc.text(v, tx + 130, y, { width: 100, align: 'right' }); doc.y = y + (bold ? 15 : 13); };
    const t = d.totals;
    if ((t.lineDiscountsMinor ?? 0) + (t.globalDiscountMinor ?? 0) > 0) row('Remises', `- ${m((t.lineDiscountsMinor ?? 0) + (t.globalDiscountMinor ?? 0))}`);
    row('Total HT', m(t.totalHtMinor));
    for (const g of t.vatGroups ?? []) row(g.regime === 'taxable' ? `TVA ${g.ratePct} % (base ${m(g.baseMinor)})` : `${REGIME[g.regime ?? ''] ?? g.vatCode} (base ${m(g.baseMinor)})`, g.regime === 'taxable' ? m(g.vatMinor) : '—');
    row('Total TVA', m(t.totalVatMinor)); row('Total TTC', m(t.totalTtcMinor), true);
    if ((t.stampMinor ?? 0) > 0) row('Timbre fiscal', m(t.stampMinor));
    if ((t.withholdingMinor ?? 0) > 0) row(d.withholdingLabel ?? 'Retenue à la source', `- ${m(t.withholdingMinor)}`);
    if ((t.stampMinor ?? 0) > 0 || (t.withholdingMinor ?? 0) > 0) row(`Net à payer (${cur})`, m(t.totalPayableMinor), true);
    doc.y = Math.max(doc.y, ty);
    if (d.schedule?.length) { doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9).text('Échéancier', L); doc.font('Helvetica'); for (const s of d.schedule) doc.text(`${dt(s.dueDate)} — ${m(s.amountMinor)} ${cur}`, L); }
  }
  if (d.terms) doc.moveDown().font('Helvetica').fontSize(8.5).fillColor('#444').text(`Conditions : ${d.terms}`, L, doc.y, { width: W });
  if (d.notes) doc.moveDown(0.5).fillColor('#444').text(d.notes, L, doc.y, { width: W });
  doc.fillColor('#888').fontSize(7.5).text(`${company?.name ?? ''} — montants en ${cur}`, L, doc.page.height - 40, { width: W, align: 'center' });
  doc.end();
  return done;
}
