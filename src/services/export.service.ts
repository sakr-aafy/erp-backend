import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export type Cell = string | number | boolean | Date | null | undefined;
export interface Column<T> { header: string; key: string; width?: number; value: (row: T) => Cell; align?: 'left' | 'right' }
export type ExportFormat = 'xlsx' | 'csv' | 'pdf';

export const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

/** Neutralise l'injection de formules (CSV/Excel) : texte commençant par = + - @ tab CR est préfixé par une apostrophe. */
export const safeText = (v: Cell): string | number | boolean => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
};

export async function toXlsx<T>(sheet: string, cols: Column<T>[], rows: T[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.slice(0, 31));
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(Object.fromEntries(cols.map((c) => [c.key, safeText(c.value(r))])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV UTF-8 avec BOM, séparateur « ; » (ouverture directe dans Excel en locale française). */
export function toCsv<T>(cols: Column<T>[], rows: T[]): Buffer {
  const esc = (v: unknown) => { const s = String(safeText(v as Cell)); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map((c) => esc(c.header)).join(';'), ...rows.map((r) => cols.map((c) => esc(c.value(r))).join(';'))];
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.end();
  });
}

export function toPdfTable<T>(title: string, subtitle: string, cols: Column<T>[], rows: T[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: title } });
  const w = doc.page.width - 60;
  const total = cols.reduce((s, c) => s + (c.width ?? 18), 0);
  const widths = cols.map((c) => ((c.width ?? 18) / total) * w);
  const header = () => {
    let x = 30; const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8);
    cols.forEach((c, i) => { doc.text(c.header, x + 2, y, { width: widths[i]! - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true }); x += widths[i]!; });
    doc.moveTo(30, y + 12).lineTo(30 + w, y + 12).stroke('#999'); doc.y = y + 16; doc.font('Helvetica').fontSize(8);
  };
  doc.font('Helvetica-Bold').fontSize(16).text(title); doc.font('Helvetica').fontSize(9).fillColor('#555').text(subtitle).fillColor('#000'); doc.moveDown(0.8);
  header();
  for (const r of rows) {
    if (doc.y > doc.page.height - 50) { doc.addPage(); header(); }
    let x = 30; const y = doc.y;
    cols.forEach((c, i) => { doc.text(String(safeText(c.value(r))), x + 2, y, { width: widths[i]! - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true }); x += widths[i]!; });
    doc.y = y + 13;
  }
  if (!rows.length) doc.text('Aucune donnée.');
  return collect(doc);
}

export interface FicheSection { title: string; rows: [string, string][] }
/** Fiche imprimable (client / fournisseur). */
export function toPdfFiche(title: string, sections: FicheSection[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title } });
  doc.font('Helvetica-Bold').fontSize(20).text(title); doc.moveDown();
  for (const s of sections) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#015581').text(s.title).fillColor('#000'); doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc'); doc.moveDown(0.4);
    for (const [k, v] of s.rows) {
      const y = doc.y; doc.font('Helvetica').fontSize(10).fillColor('#666').text(k, 50, y, { width: 150 });
      doc.fillColor('#000').text(v || '—', 210, y, { width: 335 }); doc.y = Math.max(doc.y, y + 14);
    }
    doc.moveDown();
  }
  doc.fontSize(8).fillColor('#888').text(`Édité le ${new Date().toLocaleDateString('fr-FR')}`, 50, doc.page.height - 60);
  return collect(doc);
}

export async function renderTable<T>(format: ExportFormat, name: string, title: string, subtitle: string, cols: Column<T>[], rows: T[]) {
  const body = format === 'xlsx' ? await toXlsx(name, cols, rows) : format === 'csv' ? toCsv(cols, rows) : await toPdfTable(title, subtitle, cols, rows);
  return { body, contentType: MIME[format], filename: `${name}-${new Date().toISOString().slice(0, 10)}.${format}` };
}
