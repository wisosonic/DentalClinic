import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const doc = (extra: object = {}) => ({
  id: 1, patientId: 7, category: 'xray', title: 'Upper right', takenOn: '2026-10-01', note: null, fileName: 'scan.png', mime: 'image/png', sizeBytes: 2_500_000, isImage: true,
  appointment: null, patientVisible: false, uploadedBy: { id: 4, name: 'Sam Staff' }, createdAt: '2026-10-01 09:00:00', canChange: true, ...extra,
});
const pdfDoc = (extra: object = {}) => doc({ id: 2, category: 'blood_test', title: 'Blood results', mime: 'application/pdf', isImage: false, sizeBytes: 90_000, takenOn: '2026-09-20', ...extra });
const list = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 200, total: data.length } });
const lastCall = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path).at(-1)!;

const open = async (role = 'staff', docs: unknown[] = [doc(), pdfDoc()]) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
  api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [] });
  api.routes['GET /patients/7/documents'] = () => list(docs);
  renderApp(<App />, '/patients/7/documents');
  await screen.findByRole('heading', { name: 'Documents' });
  return within(await screen.findByRole('region', { name: 'Documents' }));
};

describe('the patient’s documents page', () => {
  it('has the patient’s name under its title, a way back, and a trail through the patient', async () => {
    await open();
    expect(screen.getByText('Hicham Cheaib', { selector: 'p' })).toBeInTheDocument();
    const back = screen.getByRole('link', { name: 'Back to the patient' });
    expect(back).toHaveAttribute('href', '/patients/7');
    expect(back.parentElement).toContainElement(screen.getByRole('button', { name: 'Add documents' })); // beside it, in the header, like Payments
    expect(within(screen.getByRole('region', { name: 'Documents' })).queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
    expect(trail.getByText('Documents')).toHaveAttribute('aria-current', 'page');
  });

  it('lists them with their kind (in English), date, who added them and the size', async () => {
    const section = await open();
    const row = (await section.findByText('Upper right')).closest('tr') as HTMLElement;
    expect(within(row).getByText('X-ray')).toBeInTheDocument();
    expect(within(row).getByText('Sam Staff')).toBeInTheDocument();
    expect(within(row).getByText('2.4 MB')).toBeInTheDocument();
    const pdfRow = section.getByText('Blood results').closest('tr') as HTMLElement;
    expect(within(pdfRow).getByText('Blood test')).toBeInTheDocument();
    expect(within(pdfRow).getByText('88 KB')).toBeInTheDocument();
  });

  it('shows a small preview of each picture, an icon for a PDF, and an icon when the preview cannot be loaded', async () => {
    const section = await open('staff', [doc(), pdfDoc(), doc({ id: 3, title: 'Broken one' })]);
    const row = (await section.findByText('Upper right')).closest('tr') as HTMLElement;
    const img = row.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', '/api/v1/documents/1/thumbnail');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', ''); // the title beside it says what it is
    expect((section.getByText('Blood results').closest('tr') as HTMLElement).querySelector('img')).toBeNull();
    const broken = (section.getByText('Broken one').closest('tr') as HTMLElement).querySelector('img') as HTMLImageElement;
    fireEvent.error(broken); // the server had no preview for it
    await waitFor(() => expect((section.getByText('Broken one').closest('tr') as HTMLElement).querySelector('img')).toBeNull());
    expect(within(section.getByText('Broken one').closest('tr') as HTMLElement).getByRole('button', { name: 'Open Broken one' })).toBeInTheDocument(); // still opens
  });

  it('opens the viewer from the preview', async () => {
    const section = await open();
    const row = (await section.findByText('Upper right')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getAllByRole('button', { name: 'Open Upper right' })[0]!);
    expect(await screen.findByRole('dialog', { name: /Upper right/ })).toBeInTheDocument();
  });

  it('marks a document that is visible to the patient', async () => {
    const section = await open('staff', [doc({ patientVisible: true }), pdfDoc()]);
    const row = (await section.findByText('Upper right')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Visible to the patient')).toBeInTheDocument();
    expect(within(section.getByText('Blood results').closest('tr') as HTMLElement).queryByText('Visible to the patient')).not.toBeInTheDocument();
  });

  it('changes whether the patient may see a document', async () => {
    const section = await open();
    api.routes['PATCH /documents/1'] = () => json(200, { document: doc({ patientVisible: true }) });
    await userEvent.click(await section.findByRole('button', { name: 'Edit Upper right' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit document' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Visible to the patient' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(lastCall('PATCH', '/documents/1').body).toMatchObject({ patientVisible: true }));
  });

  it('says so when there are none, and when a filter finds none', async () => {
    const section = await open('staff', []);
    expect(await section.findByText('No documents yet.')).toBeInTheDocument();
  });

  it('asks the server to filter by kind and search', async () => {
    const section = await open();
    await section.findByText('Upper right');
    await userEvent.click(section.getByLabelText('Kind'));
    await userEvent.click(await screen.findByRole('option', { name: 'Blood test' }));
    await waitFor(() => expect(lastCall('GET', '/patients/7/documents').query.get('category')).toBe('blood_test'));
    await userEvent.type(section.getByLabelText('Search documents'), 'blood');
    await waitFor(() => expect(lastCall('GET', '/patients/7/documents').query.get('q')).toBe('blood'));
  });

  it('sorts by any column', async () => {
    const section = await open('admin', [doc({ id: 1, title: 'Zeta', takenOn: '2026-10-01' }), pdfDoc({ id: 2, title: 'Alpha', takenOn: '2026-09-20' })]);
    await section.findByText('Zeta');
    const titles = () => section.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(titles()).toEqual(['Zeta', 'Alpha']); // newest first
    await userEvent.click(section.getByRole('button', { name: 'Title' }));
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Zeta']));
    await userEvent.click(section.getByRole('button', { name: 'Size' }));
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Zeta']));
  });

  it('opens a picture in a viewer with the next one, and a PDF in a new tab', async () => {
    const section = await open('staff', [doc(), doc({ id: 3, title: 'Second picture' }), pdfDoc()]);
    await userEvent.click(await section.findByRole('button', { name: 'Upper right' }));
    const viewer = await screen.findByRole('dialog');
    expect(within(viewer).getByRole('img', { name: 'Upper right' })).toHaveAttribute('src', '/api/v1/documents/1/file');
    await userEvent.click(within(viewer).getByRole('button', { name: 'Next' }));
    expect(within(viewer).getByRole('img', { name: 'Second picture' })).toBeInTheDocument();
    expect(within(viewer).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute('target', '_blank');
    await userEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const pdf = section.getByRole('link', { name: 'Blood results' });
    expect(pdf).toHaveAttribute('href', '/api/v1/documents/2/file');
    expect(pdf).toHaveAttribute('target', '_blank');
  });

  it('offers to change and delete only what the person may', async () => {
    const section = await open('doctor', [doc(), pdfDoc({ canChange: false })]);
    await section.findByText('Upper right');
    expect(section.getByRole('button', { name: 'Edit Upper right' })).toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Edit Blood results' })).not.toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Delete Blood results' })).not.toBeInTheDocument();
  });

  it('changes the details of a document', async () => {
    const section = await open();
    api.routes['PATCH /documents/1'] = () => json(200, { document: doc({ title: 'Renamed' }) });
    await userEvent.click(await section.findByRole('button', { name: 'Edit Upper right' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit document' });
    await userEvent.clear(within(dialog).getByLabelText(/^Title/));
    await userEvent.type(within(dialog).getByLabelText(/^Title/), 'Renamed');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Left side');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(lastCall('PATCH', '/documents/1').body).toMatchObject({ title: 'Renamed', category: 'xray', note: 'Left side' }));
    expect(await screen.findByText('Document saved')).toBeInTheDocument();
  });

  it('deletes a document after saying it goes to the Trash', async () => {
    const section = await open();
    api.routes['DELETE /documents/1'] = () => new Response(null, { status: 204 });
    await userEvent.click(await section.findByRole('button', { name: 'Delete Upper right' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/goes to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/documents/1')).toBe(true));
    expect(await screen.findByText('Document moved to the Trash')).toBeInTheDocument();
  });
});

describe('adding documents', () => {
  const file = (name: string, type: string, size = 100) => new File([new Uint8Array(size)], name, { type });
  const choose = async (files: File[]) => {
    await open('staff', []);
    await userEvent.click(await screen.findByRole('button', { name: 'Add documents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add documents' });
    fireEvent.change(within(dialog).getByLabelText('Document files'), { target: { files } });
    return dialog;
  };

  it('sends each file with its kind, title and date, one after another, and says so', async () => {
    const dialog = await choose([file('right molar.png', 'image/png', 50), file('labs.pdf', 'application/pdf', 70)]);
    api.routes['POST /patients/7/documents'] = () => json(201, { document: doc() });
    expect(within(dialog).getByLabelText('Title of file 1')).toHaveValue('right molar');
    expect(within(dialog).getByLabelText('Kind of file 1')).toHaveTextContent('X-ray'); // pictures start as X-ray, PDFs as Other
    expect(within(dialog).getByLabelText('Kind of file 2')).toHaveTextContent('Other');
    expect(within(dialog).getByLabelText('Date of file 1')).toHaveValue('2026-10-05');
    await userEvent.click(within(dialog).getByLabelText('Kind of file 2'));
    await userEvent.click(await screen.findByRole('option', { name: 'Blood test' }));
    await userEvent.clear(within(dialog).getByLabelText('Title of file 2'));
    await userEvent.type(within(dialog).getByLabelText('Title of file 2'), 'Blood results');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add 2 documents' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/patients/7/documents')).toHaveLength(2));
    const [first, second] = api.calls.filter((c) => c.method === 'POST' && c.path === '/patients/7/documents');
    expect(first!.query.get('category')).toBe('xray');
    expect(first!.query.get('title')).toBe('right molar');
    expect(first!.query.get('takenOn')).toBe('2026-10-05');
    expect(first!.query.get('name')).toBe('right molar.png');
    expect(first!.headers.get('content-type')).toBe('image/png');
    expect(second!.query.get('category')).toBe('blood_test');
    expect(second!.headers.get('content-type')).toBe('application/pdf');
    expect(await screen.findByText('Document added')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByText('Added')).toHaveLength(2));
  });

  it('sends the choice to make a file visible to the patient, as yes or no', async () => {
    const dialog = await choose([file('a.png', 'image/png', 50), file('b.png', 'image/png', 60)]);
    api.routes['POST /patients/7/documents'] = () => json(201, { document: doc() });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Visible to the patient, file 2' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add 2 documents' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/patients/7/documents')).toHaveLength(2));
    const [first, second] = api.calls.filter((c) => c.method === 'POST' && c.path === '/patients/7/documents');
    expect(first!.query.get('patientVisible')).toBe('0');
    expect(second!.query.get('patientVisible')).toBe('1');
  });

  it('refuses a file of the wrong type or over 25 MB before sending anything', async () => {
    const big = file('huge.png', 'image/png', 10);
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    const dialog = await choose([file('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), big]);
    expect(within(dialog).getByText('notes.docx: only PNG, JPEG, WebP and PDF files can be added')).toBeInTheDocument();
    expect(within(dialog).getByText('huge.png: the file must be smaller than 25 MB')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add document' })).toBeDisabled();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('needs a title, and shows the server’s refusal for a file, which can be fixed or removed', async () => {
    const dialog = await choose([file('a.png', 'image/png')]);
    api.routes['POST /patients/7/documents'] = () => json(400, { error: { code: 'INVALID_FILE', message: 'Choose a PNG, JPEG or WebP picture, or a PDF' } });
    await userEvent.clear(within(dialog).getByLabelText('Title of file 1'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText('Give the document a title')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dialog).getByLabelText('Title of file 1'), 'Scan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText('Choose a PNG, JPEG or WebP picture, or a PDF')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove a.png' }));
    expect(within(dialog).queryByLabelText('Title of file 1')).not.toBeInTheDocument();
  });

  it('offers to add a file anyway when the patient already has exactly that file', async () => {
    const dialog = await choose([file('same.png', 'image/png')]);
    api.routes['POST /patients/7/documents'] = (call) => (call.query.get('allowDuplicate') ? json(201, { document: doc() }) : json(409, { error: { code: 'DUPLICATE_DOCUMENT', message: 'This patient already has exactly this file' } }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add document' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Add it anyway' }));
    await waitFor(() => expect(lastCall('POST', '/patients/7/documents').query.get('allowDuplicate')).toBe('1'));
    expect(await within(dialog).findByText('Added')).toBeInTheDocument();
  });
});

describe('the trail of the pages opened from a patient', () => {
  const trailOf = async (path: string) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    for (const p of ['/payments', '/treatment-offers', '/lab-orders']) api.routes[`GET ${p}`] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    renderApp(<App />, path);
    return within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
  };

  it('runs Patients > the patient > the page, for payments, treatment offers and lab orders opened from the patient', async () => {
    for (const [path, label] of [['/payments?patientId=7', 'Payments'], ['/treatment-offers?patientId=7', 'Treatment offers'], ['/lab-orders?patientId=7', 'Lab orders']]) {
      const trail = await trailOf(path!);
      await waitFor(() => expect(trail.getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7'));
      expect(trail.getByRole('link', { name: 'Patients' })).toHaveAttribute('href', '/patients');
      expect(trail.getByText(label!)).toHaveAttribute('aria-current', 'page');
      expect(await screen.findByRole('link', { name: 'Back to the patient' })).toHaveAttribute('href', '/patients/7'); // the same button as on the patient's own pages
      cleanup();
    }
  });

  it('is Patients > the patient on the patient page itself, and just the section on an unfiltered list', async () => {
    const onPatient = await trailOf('/patients/7');
    await waitFor(() => expect(onPatient.getByText('Hicham Cheaib')).toHaveAttribute('aria-current', 'page'));
    expect(onPatient.getByRole('link', { name: 'Patients' })).toBeInTheDocument();
    cleanup();
    const plain = await trailOf('/payments');
    expect(plain.getByText('Payments')).toHaveAttribute('aria-current', 'page');
    expect(plain.queryByRole('link', { name: 'Patients' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to the patient' })).not.toBeInTheDocument(); // nothing to go back to
  });
});
