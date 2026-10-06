import PDFDocument from 'pdfkit';
import type { PaymentMethod } from '@aya/shared';

const GREEN = '#0b7a75';
const GREY = '#555555';

const METHOD: Record<PaymentMethod, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };
const money = (n: number) => `$${n.toFixed(2)}`;

interface Clinic {
  name: string;
  address: string | null;
  phone: string | null;
  email?: string | null;
}

/** The clinic's letterhead, a title and a number: the same top for every document. */
function start(title: string, number: string, clinic: Clinic, compress: boolean | undefined): { doc: PDFKit.PDFDocument; done: Promise<Buffer>; row: (label: string, value: string) => void } {
  const doc = new PDFDocument({ size: 'A4', margin: 50, compress: compress ?? true, info: { Title: `${title} ${number}`, Author: clinic.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const row = (label: string, value: string) => {
    doc.font('Helvetica-Bold').fillColor('#000000').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
  };

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text(clinic.name);
  doc.fillColor(GREY).font('Helvetica').fontSize(10);
  if (clinic.address) doc.text(clinic.address);
  if (clinic.phone) doc.text(clinic.phone);
  if (clinic.email) doc.text(clinic.email);
  doc.moveDown(0.5).strokeColor(GREEN).lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.8).fillColor('#000000').font('Helvetica-Bold').fontSize(16).text(title);
  doc.fillColor(GREY).font('Helvetica').fontSize(10).text(`No. ${number}`);
  doc.fillColor('#000000').font('Helvetica').fontSize(11).moveDown(0.6);
  return { doc, done, row };
}

/** A box with the figures that matter, right-aligned. */
function totals(doc: PDFKit.PDFDocument, lines: { label: string; value: string; strong?: boolean }[]) {
  doc.moveDown(1);
  const x = 330;
  for (const l of lines) {
    const y = doc.y;
    doc.font(l.strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(l.strong ? 13 : 11).fillColor(l.strong ? GREEN : '#000000');
    doc.text(l.label, x, y, { width: 120 });
    doc.text(l.value, x + 120, y, { width: 75, align: 'right' });
    doc.moveDown(0.3);
  }
  doc.x = 50;
  doc.fillColor('#000000').font('Helvetica').fontSize(11);
}

export interface OfferPdfData {
  clinic: Clinic;
  number: number;
  date: string;
  status: string;
  patient: { name: string; number: string };
  doctor: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  items: { description: string; tooth: string | null; price: number }[];
  price: number;
  paid: number;
}

/**
 * The treatment offer a patient is given: what will be done, each item with its price, the total and what
 * has been paid. Never the clinic's own cost. English only (owner decision).
 */
export function renderOfferPdf(data: OfferPdfData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const { doc, done, row } = start('Treatment offer', `T-${data.number}`, data.clinic, opts.compress);
  row('Patient', `${data.patient.name} (No. ${data.patient.number})`);
  row('Date', data.date);
  if (data.doctor) row('Doctor', `Dr ${data.doctor}`);

  doc.moveDown(0.8).fillColor(GREEN).font('Helvetica-Bold').fontSize(12).text('TREATMENT').moveDown(0.2);
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12).text(data.title);
  doc.font('Helvetica').fontSize(11);
  if (data.description) doc.moveDown(0.3).text(data.description);

  if (data.items.length) {
    doc.moveDown(0.8);
    for (const [n, i] of data.items.entries()) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(11).fillColor('#000000').text(`${n + 1}. ${i.description}${i.tooth ? ` (tooth ${i.tooth})` : ''}`, 50, y, { width: 380 });
      doc.text(money(i.price), 440, y, { width: 105, align: 'right' });
      doc.moveDown(0.2);
    }
    doc.x = 50;
  }
  if (data.notes) doc.moveDown(0.6).fillColor(GREY).fontSize(10).text(data.notes).fillColor('#000000').fontSize(11);

  const lines: { label: string; value: string; strong?: boolean }[] = [{ label: 'Total', value: money(data.price), strong: true }];
  if (data.paid > 0) {
    lines.push({ label: 'Paid so far', value: money(data.paid) }, { label: 'Balance', value: money(Math.max(0, Math.round((data.price - data.paid) * 100) / 100)) });
  }
  totals(doc, lines);

  doc.moveDown(1.5).fillColor(GREY).fontSize(9).text(
    'This offer describes the treatment above and its price. Please contact the clinic if you have questions.',
  );
  doc.end();
  return done;
}

export interface ReceiptPdfData {
  clinic: Clinic;
  number: number;
  date: string;
  patient: { name: string; number: string };
  offerTitle: string;
  amount: number;
  method: PaymentMethod | null;
  remaining: number | null;
  receivedBy: string | null;
  note: string | null;
}

/** The receipt handed over when a payment is taken. English only (owner decision). */
export function renderReceiptPdf(data: ReceiptPdfData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const { doc, done, row } = start('Payment receipt', `R-${data.number}`, data.clinic, opts.compress);
  row('Received from', `${data.patient.name} (No. ${data.patient.number})`);
  row('Date', data.date);
  row('For', data.offerTitle);
  if (data.method) row('Paid by', METHOD[data.method]);
  if (data.receivedBy) row('Received by', `Dr ${data.receivedBy}`);
  if (data.note) row('Note', data.note);

  const lines: { label: string; value: string; strong?: boolean }[] = [{ label: 'Amount received', value: money(data.amount), strong: true }];
  if (data.remaining !== null) lines.push({ label: 'Balance after', value: money(Math.max(data.remaining, 0)) });
  totals(doc, lines);

  doc.moveDown(1.5).fillColor(GREY).fontSize(9).text('Thank you. Please keep this receipt for your records.');
  doc.end();
  return done;
}
