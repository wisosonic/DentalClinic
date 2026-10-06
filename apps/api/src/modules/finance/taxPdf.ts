import PDFDocument from 'pdfkit';
import type { IncomeTaxDto } from '@aya/shared';

const GREEN = '#0b7a75';
const GREY = '#555555';

const lbp = (n: number) => `${Math.round(n).toLocaleString('en-US')} LBP`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export interface TaxPdfClinic {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * The worksheet of an income tax estimate: who, which year, what was counted, each step and the bracket table,
 * with a plain notice that it is an estimate. A declared year is printed from its stored copy, so the sheet
 * always shows the numbers it was filed with. English only, like the other PDFs.
 */
export function renderTaxPdf(data: IncomeTaxDto, clinic: TaxPdfClinic, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, compress: opts.compress ?? true, info: { Title: `Income tax estimate ${data.year}`, Author: clinic.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text(clinic.name);
  doc.fillColor(GREY).font('Helvetica').fontSize(10);
  for (const line of [clinic.address, clinic.phone, clinic.email]) if (line) doc.text(line);
  doc.moveDown(0.5).strokeColor(GREEN).lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.8).fillColor('#000000').font('Helvetica-Bold').fontSize(16).text(`Income tax estimate ${data.year}`);
  doc.fillColor(GREY).font('Helvetica').fontSize(10).text(data.declaration
    ? `Declared and paid on ${data.declaration.paidDate}${data.declaration.declaredBy ? ` (${data.declaration.declaredBy})` : ''}. These figures are stored as they were on that day.`
    : 'Not declared yet. These figures are calculated from the payments recorded today.');
  doc.fillColor('#000000').fontSize(11).moveDown(0.8);

  const row = (label: string, value: string, strong = false) => {
    const y = doc.y;
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 12 : 11).fillColor(strong ? GREEN : '#000000');
    doc.text(label, 50, y, { width: 330 });
    doc.text(value, 380, y, { width: 165, align: 'right' });
    doc.moveDown(0.35);
  };
  const heading = (text: string) => {
    doc.moveDown(0.6).fillColor(GREEN).font('Helvetica-Bold').fontSize(12).text(text).moveDown(0.3);
  };

  heading('Taxpayer and year');
  row('Taxpayer', data.doctor ? `Dr ${data.doctor.fname} ${data.doctor.lname}` : 'The whole clinic');
  row('Tax year', String(data.year));
  row('Family allowances', `single${data.input.spouse ? ', spouse' : ''}${data.input.children ? `, ${data.input.children} child(ren)` : ''}`);

  heading('Payments counted');
  row('From patients', `${usd(data.payments.clinic.total)} (${data.payments.clinic.count})`);
  row('Commission received', `${usd(data.payments.commission.total)} (${data.payments.commission.count})`);
  row('Total in US dollars', usd(data.payments.totalUsd), true);
  if (data.excluded.length) row('Left out (no exchange rate)', data.excluded.map((x) => `${x.currency} ${x.total} (${x.count})`).join(', '));
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text('Expenses are not deducted.');

  const r = data.result;
  heading('Calculation');
  row(`Payments in LBP (at ${data.settings.usdToLbp.toLocaleString('en-US')} LBP per USD)`, lbp(r.paymentsLbp));
  row(`${data.settings.taxPercentage}% of the payments`, lbp(r.taxablePart));
  row('Family allowances', `- ${lbp(r.allowances.total)}`);
  row('Amount after the allowances (never below zero)', lbp(r.amountAfterAllowances));
  row('Tax payable after the brackets', lbp(r.taxPayable), true);
  row('Share of everything received', `${r.effectiveRate}%`);

  heading('Brackets');
  const xs = [50, 170, 290, 345, 450];
  const head = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY);
  ['From (LBP)', 'To (LBP)', 'Rate', 'Amount in bracket', 'Tax (LBP)'].forEach((h, i) => doc.text(h, xs[i]!, head, { width: i === 4 ? 95 : 115, align: i < 2 ? 'left' : 'right' }));
  doc.moveDown(0.4).font('Helvetica').fontSize(9).fillColor('#000000');
  for (const s of r.steps) {
    const y = doc.y;
    [s.from.toLocaleString('en-US'), s.to === null ? 'No limit' : s.to.toLocaleString('en-US'), `${s.rate}%`, s.amount.toLocaleString('en-US'), s.tax.toLocaleString('en-US')]
      .forEach((c, i) => doc.text(c, xs[i]!, y, { width: i === 4 ? 95 : 115, align: i < 2 ? 'left' : 'right', lineBreak: false }));
    doc.y = y + 13;
  }

  doc.moveDown(1.2).fillColor(GREY).font('Helvetica-Oblique').fontSize(9).text(
    `The rates, allowances and brackets are those of ${data.rulesFrom ? `the rules that apply from ${data.rulesFrom}` : 'the starting values'}. This is an estimate for the owners and their accountant, not a tax return.`,
    50, doc.y, { width: 495 },
  );
  doc.end();
  return done;
}
