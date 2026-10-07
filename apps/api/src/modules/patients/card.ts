import PDFDocument from 'pdfkit';

const GREEN = '#0b7a75';
const GREY = '#555555';

export interface PatientCardData {
  clinic: { name: string; address: string | null; phone: string | null; email?: string | null };
  patient: { name: string; number: string; dateOfBirth: string | null; phone: string | null; doctor: string | null };
  username: string;
  /** The temporary first password, printed once: only its hash is stored. */
  password: string;
  signInUrl: string;
  issuedOn: string;
}

/**
 * The patient card: who the patient is (name, patient number, date of birth, phone, doctor), the username and the
 * first password to sign in with, and a note that the first password must be changed at the first sign-in.
 * English only, like every printout (owner decision). One A5 page.
 */
export function renderPatientCard(data: PatientCardData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 36, compress: opts.compress ?? true, info: { Title: `Patient card ${data.patient.number}`, Author: data.clinic.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const width = doc.page.width - 72;
  const line = (label: string, value: string) => {
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(label.toUpperCase(), { characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(value).moveDown(0.5);
  };

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(18).text(data.clinic.name);
  doc.fillColor(GREY).font('Helvetica').fontSize(9);
  if (data.clinic.address) doc.text(data.clinic.address);
  if (data.clinic.phone) doc.text(data.clinic.phone);
  if (data.clinic.email) doc.text(data.clinic.email);
  doc.moveDown(0.4).strokeColor(GREEN).lineWidth(1).moveTo(36, doc.y).lineTo(36 + width, doc.y).stroke();
  doc.moveDown(0.7).fillColor('#000000').font('Helvetica-Bold').fontSize(15).text('Patient card');
  doc.moveDown(0.6);

  line('Patient', data.patient.name);
  line('Patient No.', data.patient.number);
  if (data.patient.dateOfBirth) line('Date of birth', data.patient.dateOfBirth);
  if (data.patient.phone) line('Phone', data.patient.phone);
  if (data.patient.doctor) line('Doctor', `Dr ${data.patient.doctor}`);

  // The sign-in details, in a box that stands out.
  doc.moveDown(0.3);
  const top = doc.y;
  doc.roundedRect(36, top, width, 84, 6).lineWidth(1.2).strokeColor(GREEN).stroke();
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text('USERNAME', 48, top + 10, { characterSpacing: 0.5 });
  doc.fillColor('#000000').font('Courier-Bold').fontSize(14).text(data.username, 48, top + 22, { width: width - 24 });
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text('FIRST PASSWORD', 48, top + 46, { characterSpacing: 0.5 });
  doc.fillColor('#000000').font('Courier-Bold').fontSize(14).text(data.password, 48, top + 58, { width: width - 24 });
  doc.x = 36;
  doc.y = top + 98;

  doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`Sign in at: ${data.signInUrl}`, 36, doc.y, { width });
  doc.moveDown(0.8);
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('Important', 36, doc.y, { width });
  doc.font('Helvetica').fontSize(10).text(
    'The password on this card is a first, temporary password. You must change it the first time you sign in. Keep this card in a safe place and do not share it with anyone.',
    { width },
  );
  doc.moveDown(0.8).fillColor(GREY).fontSize(8).text(`Issued on ${data.issuedOn}`, { width });
  doc.end();
  return done;
}
