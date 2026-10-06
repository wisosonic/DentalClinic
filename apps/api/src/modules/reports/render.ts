import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/** A report as a table: the same data is written to Excel or PDF, so the two never disagree. */
export interface ReportColumn {
  key: string;
  header: string;
  /** How the cell is written: money and counts are real numbers in Excel (so they can be summed), dates are dates. */
  type: 'text' | 'money' | 'int' | 'percent';
  /** Width in characters (Excel) and relative weight (PDF). */
  width: number;
}

export interface ReportTable {
  title: string;
  /** One line under the title: the period, the filters. */
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  /** A last row of totals, with real formulas in Excel. Keys are column keys to sum. */
  totals?: { label: string; sum: string[] };
}

const GREEN = '#0b7a75';
const GREY = '#555555';

const colLetter = (index: number): string => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** Excel: a header row that stays in view, typed cells, and totals as real formulas. */
export async function renderXlsx(table: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dental Clinic';
  wb.created = new Date();
  const ws = wb.addWorksheet(table.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.getCell('A1').value = table.title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = table.subtitle;
  ws.getCell('A2').font = { color: { argb: 'FF555555' } };
  const header = ws.getRow(3);
  table.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B7A75' } };
    cell.alignment = { horizontal: c.type === 'text' ? 'left' : 'right', vertical: 'middle' };
    ws.getColumn(i + 1).width = c.width;
  });
  for (const row of table.rows) {
    const r = ws.addRow(table.columns.map((c) => row[c.key] ?? null));
    table.columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      if (c.type === 'money') cell.numFmt = '"$"#,##0.00';
      else if (c.type === 'int') cell.numFmt = '#,##0';
      else if (c.type === 'percent') cell.numFmt = '0.0"%"';
      if (c.type !== 'text') cell.alignment = { horizontal: 'right' };
    });
  }
  if (table.totals && table.rows.length > 0) {
    const first = 4;
    const last = 3 + table.rows.length;
    const r = ws.addRow(table.columns.map((c, i) => (i === 0 ? table.totals!.label : table.totals!.sum.includes(c.key) ? { formula: `SUM(${colLetter(i)}${first}:${colLetter(i)}${last})` } : null)));
    r.font = { bold: true };
    r.border = { top: { style: 'thin' } };
    table.columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      if (c.type === 'money') cell.numFmt = '"$"#,##0.00';
      else if (c.type === 'int') cell.numFmt = '#,##0';
    });
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: table.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The same Excel file as `renderXlsx`, written row by row straight to disk, so a report of hundreds of thousands
 * of rows never has to sit in memory as a finished workbook.
 */
export async function renderXlsxToFile(table: ReportTable, filename: string): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: true, useSharedStrings: false });
  wb.creator = 'Dental Clinic';
  wb.created = new Date();
  const ws = wb.addWorksheet(table.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 3 }] });
  table.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  const a1 = ws.addRow([table.title]);
  a1.getCell(1).font = { bold: true, size: 14 };
  a1.commit();
  const a2 = ws.addRow([table.subtitle]);
  a2.getCell(1).font = { color: { argb: 'FF555555' } };
  a2.commit();
  const header = ws.addRow(table.columns.map((c) => c.header));
  table.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B7A75' } };
    cell.alignment = { horizontal: c.type === 'text' ? 'left' : 'right', vertical: 'middle' };
  });
  header.commit();
  const numFmt = (c: ReportColumn) => (c.type === 'money' ? '"$"#,##0.00' : c.type === 'int' ? '#,##0' : c.type === 'percent' ? '0.0"%"' : undefined);
  for (const row of table.rows) {
    const r = ws.addRow(table.columns.map((c) => row[c.key] ?? null));
    table.columns.forEach((c, i) => {
      const f = numFmt(c);
      if (f) r.getCell(i + 1).numFmt = f;
      if (c.type !== 'text') r.getCell(i + 1).alignment = { horizontal: 'right' };
    });
    r.commit();
  }
  if (table.totals && table.rows.length > 0) {
    const last = 3 + table.rows.length;
    const r = ws.addRow(table.columns.map((c, i) => (i === 0 ? table.totals!.label : table.totals!.sum.includes(c.key) ? { formula: `SUM(${colLetter(i)}4:${colLetter(i)}${last})` } : null)));
    r.font = { bold: true };
    r.border = { top: { style: 'thin' } };
    table.columns.forEach((c, i) => {
      const f = numFmt(c);
      if (f && c.type !== 'percent') r.getCell(i + 1).numFmt = f;
    });
    r.commit();
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: table.columns.length } };
  ws.commit();
  await wb.commit();
}

const fmt = (c: ReportColumn, v: string | number | null): string => {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return `$${Number(v).toFixed(2)}`;
  if (c.type === 'int') return Number(v).toLocaleString('en-US');
  if (c.type === 'percent') return `${Number(v).toFixed(1)}%`;
  return String(v);
};

export interface Letterhead {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/** PDF: the clinic's letterhead, the title and period, then the table, repeating its header on every page. */
export function renderPdf(table: ReportTable, clinic: Letterhead, opts: { compress?: boolean; landscape?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: opts.landscape ? 'landscape' : 'portrait', margin: 40, compress: opts.compress ?? true, info: { Title: table.title, Author: clinic.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text(clinic.name);
  doc.fillColor(GREY).font('Helvetica').fontSize(9);
  for (const line of [clinic.address, clinic.phone, clinic.email]) if (line) doc.text(line);
  doc.moveDown(0.4).strokeColor(GREEN).lineWidth(1).moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
  doc.moveDown(0.6).fillColor('#000000').font('Helvetica-Bold').fontSize(14).text(table.title);
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text(table.subtitle).moveDown(0.6);

  const usable = doc.page.width - 80;
  const weight = table.columns.reduce((s, c) => s + c.width, 0);
  const widths = table.columns.map((c) => (c.width / weight) * usable);
  const xs = widths.map((_, i) => 40 + widths.slice(0, i).reduce((s, w) => s + w, 0));

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(40, y - 2, usable, 16).fill(GREEN);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    table.columns.forEach((c, i) => doc.text(c.header, xs[i]! + 2, y + 2, { width: widths[i]! - 4, align: c.type === 'text' ? 'left' : 'right', lineBreak: false }));
    doc.y = y + 16;
    doc.fillColor('#000000').font('Helvetica').fontSize(8);
  };
  const line = (cells: string[], bold = false) => {
    const heights = cells.map((text, i) => doc.heightOfString(text, { width: widths[i]! - 4 }));
    const h = Math.max(12, ...heights) + 3;
    if (doc.y + h > doc.page.height - 50) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000000');
    cells.forEach((text, i) => doc.text(text, xs[i]! + 2, y + 1, { width: widths[i]! - 4, align: table.columns[i]!.type === 'text' ? 'left' : 'right' }));
    doc.strokeColor('#dddddd').lineWidth(0.5).moveTo(40, y + h - 1).lineTo(40 + usable, y + h - 1).stroke();
    doc.y = y + h;
  };

  drawHeader();
  if (table.rows.length === 0) doc.fillColor(GREY).text('Nothing to show for this selection.', 42, doc.y + 4);
  for (const row of table.rows) line(table.columns.map((c) => fmt(c, row[c.key] ?? null)));
  if (table.totals && table.rows.length > 0) {
    const sums = table.totals.sum.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: table.rows.reduce((s, r) => s + Number(r[k] ?? 0), 0) }), {});
    line(table.columns.map((c, i) => (i === 0 ? table.totals!.label : table.totals!.sum.includes(c.key) ? fmt(c, Math.round(sums[c.key]! * 100) / 100) : '')), true);
  }
  doc.end();
  return done;
}
