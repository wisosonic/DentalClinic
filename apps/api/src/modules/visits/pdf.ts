import PDFDocument from 'pdfkit';
import type { ReportDto } from '@aya/shared';

export interface VisitPdfData {
  clinic: { name: string; address: string | null; phone: string | null; email?: string | null };
  patient: { name: string; number: string };
  doctor: { name: string; speciality: string | null };
  date: string;
  start: string;
  end: string;
  procedures: string[];
  report: ReportDto;
}

const GREEN = '#0b7a75';
const GREY = '#555555';

const frequencyText = (n: number, unit: string) => `${n} ${n === 1 ? 'time' : 'times'} per ${unit}`;

/**
 * The visit summary and prescription a patient can take home. Always the patient-safe content
 * (summary and prescriptions), whoever downloads it: internal and per-tooth notes never go in.
 * English only (owner decision).
 */
export function renderVisitPdf(data: VisitPdfData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: opts.compress ?? true,
      info: { Title: `Visit summary ${data.date}`, Author: data.clinic.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const heading = (text: string) => {
      doc.moveDown(0.8).fillColor(GREEN).font('Helvetica-Bold').fontSize(12).text(text.toUpperCase()).moveDown(0.2);
      doc.fillColor('#000000').font('Helvetica').fontSize(11);
    };
    const row = (label: string, value: string) => {
      doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
    };

    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20).text(data.clinic.name);
    doc.fillColor(GREY).font('Helvetica').fontSize(10);
    if (data.clinic.address) doc.text(data.clinic.address);
    if (data.clinic.phone) doc.text(data.clinic.phone);
    if (data.clinic.email) doc.text(data.clinic.email);
    doc.moveDown(0.5).strokeColor(GREEN).lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();

    doc.moveDown(0.8).fillColor('#000000').font('Helvetica-Bold').fontSize(16).text('Visit summary');
    doc.font('Helvetica').fontSize(11).moveDown(0.4);
    row('Patient', `${data.patient.name} (No. ${data.patient.number})`);
    row('Date', `${data.date}, ${data.start} to ${data.end}`);
    row('Doctor', data.doctor.speciality ? `Dr ${data.doctor.name}, ${data.doctor.speciality}` : `Dr ${data.doctor.name}`);
    if (data.procedures.length) row('Procedures', data.procedures.join(', '));

    heading('What was done');
    doc.text(data.report.summary?.trim() || 'No summary was written for this visit.', { align: 'left' });

    heading('Prescription');
    if (data.report.medications.length === 0) {
      doc.text('No medication was prescribed.');
    } else {
      data.report.medications.forEach((m, i) => {
        doc.font('Helvetica-Bold').text(`${i + 1}. ${m.name}${m.type ? ` (${m.type})` : ''}`);
        doc.font('Helvetica').text(`${m.dose}, ${frequencyText(m.frequency, m.timeUnit)}`, { indent: 16 });
        if (m.notes) doc.fillColor(GREY).text(m.notes, { indent: 16 }).fillColor('#000000');
        doc.moveDown(0.3);
      });
    }

    doc.moveDown(1).fillColor(GREY).fontSize(9).text(
      'This document summarises your visit. Follow your doctor\'s instructions and contact the clinic if you have questions.',
    );
    doc.end();
  });
}
