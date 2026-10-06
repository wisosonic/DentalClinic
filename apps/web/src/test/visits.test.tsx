import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReportDto, TimelineEntryDto } from '@aya/shared';
import { App } from '../App';
import { DentalPanorama } from '../components/DentalPanorama';
import { PlanDialog } from '../features/appointments/PlanDialog';
import { PatientChart } from '../features/visits/PatientChart';
import { ReportDialog } from '../features/visits/ReportDialog';
import { Timeline } from '../features/visits/Timeline';
import { PATIENT, appointment, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const UPPER = ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'];
const LOWER = ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'];
const TEETH = [...UPPER, ...LOWER].map((index, i) => ({ id: i + 1, index, name: `Tooth ${index}`, type: 'Molar' }));
const toothId = (index: string) => TEETH.find((t) => t.index === index)!.id;

const MEDS = [{ id: 1, name: 'Amoxicillin', type: 'capsule' }, { id: 2, name: 'Ibuprofen', type: 'tablet' }];

const signIn = (role: string) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
  api.routes['GET /teeth'] = () => json(200, { data: TEETH });
  api.routes['GET /medications'] = () => json(200, { data: MEDS });
  api.routes['GET /categories'] = () => json(200, { data: [] });
  api.routes['GET /doctors'] = () => json(200, { data: [] });
  api.routes['GET /units'] = () => json(200, { data: [] });
};

const report = (extra: Partial<ReportDto> = {}): ReportDto => ({
  id: 1, appointmentId: 5, summary: 'Scaling and polishing', createdAt: null, updatedAt: null,
  medications: [{ id: 1, medicationId: 1, name: 'Amoxicillin', type: 'capsule', dose: '500 mg', frequency: 3, timeUnit: 'day', notes: 'After meals' }],
  teeth: [{ toothId: toothId('18'), index: '18', name: 'Tooth 18', date: '2026-10-06', labial: null, buccal: null, lingual: null, mesial: null, distal: null, occlusal: 'Deep cavity' }],
  ...extra,
});

const APPT = { id: 5, date: '2026-10-06', patient: { fname: 'Hicham', lname: 'Cheaib' } };

describe('the dental chart', () => {
  it('draws all 32 teeth by their FDI number, upper jaw then lower', () => {
    renderApp(<DentalPanorama teeth={TEETH} />);
    const labels = screen.getAllByRole('img').map((g) => g.getAttribute('aria-label')!.split(',')[0]);
    expect(labels).toEqual([...UPPER, ...LOWER].map((i) => `Tooth ${i}`));
  });

  it('marks teeth with notes and chosen teeth, and reports clicks', async () => {
    const clicked: number[] = [];
    renderApp(<DentalPanorama teeth={TEETH} marked={new Set([toothId('18')])} selected={new Set([toothId('21')])} onToggle={(id) => clicked.push(id)} />);
    expect(screen.getByRole('button', { name: /^Tooth 18, Tooth 18, has notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tooth 21.*selected/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 11,/ }));
    expect(clicked).toEqual([toothId('11')]);
  });

  it('can be used from the keyboard', async () => {
    const clicked: number[] = [];
    renderApp(<DentalPanorama teeth={TEETH} onToggle={(id) => clicked.push(id)} />);
    const tooth = screen.getByRole('button', { name: /^Tooth 36,/ });
    tooth.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(clicked).toEqual([toothId('36'), toothId('36')]);
  });

  it('is read-only when nothing handles clicks', () => {
    renderApp(<DentalPanorama teeth={TEETH} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the visit report in an appointment', () => {
  const open = async (role: string, reply: () => Response, status = 'completed') => {
    signIn(role);
    api.routes['GET /appointments'] = () => json(200, { data: [appointment({ status })], meta: { page: 1, pageSize: 25, total: 1 } });
    api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment({ status }) });
    api.routes['GET /appointments/5/report'] = reply;
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'List' }));
    await userEvent.click(await screen.findByText('Hicham Cheaib'));
    return screen.findByRole('dialog');
  };

  it('shows the summary, the prescription and a PDF link, with an edit button for the treating doctor', async () => {
    const dialog = await open('doctor', () => json(200, { report: report(), canEdit: true }));
    expect(await within(dialog).findByText('Scaling and polishing')).toBeInTheDocument();
    expect(within(dialog).getByText('Amoxicillin')).toBeInTheDocument();
    expect(within(dialog).getByText(/500 mg, 3 times per day/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Tooth 18/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Visit summary \(PDF\)/ })).toHaveAttribute('href', '/api/v1/appointments/5/report/pdf');
    expect(within(dialog).getByRole('button', { name: 'Edit report' })).toBeInTheDocument();
  });

  it('shows staff the report but no way to edit it', async () => {
    const dialog = await open('staff', () => json(200, { report: report(), canEdit: false }));
    expect(await within(dialog).findByText('Scaling and polishing')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /edit report|write report/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete report' })).toBeInTheDocument(); // staff may delete (to the Trash), not edit
  });

  it('offers to write one when there is none, and says so otherwise', async () => {
    const dialog = await open('doctor', () => json(200, { report: null, canEdit: true }));
    expect(await within(dialog).findByRole('button', { name: 'Write report' })).toBeInTheDocument();
    expect(within(dialog).getByText('No report has been written for this visit.')).toBeInTheDocument();
  });

  it('tells a doctor who may not read it, instead of failing', async () => {
    const dialog = await open('doctor', () => json(404, errorBody('NOT_FOUND', 'Appointment not found')));
    expect(await within(dialog).findByText(/report isn't available to you/)).toBeInTheDocument();
  });

  it('offers no report for a cancelled appointment', async () => {
    const dialog = await open('doctor', () => json(200, { report: null, canEdit: true }), 'cancelled');
    expect(await within(dialog).findByText('There is no visit to report on.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Write report' })).not.toBeInTheDocument();
  });
});

describe('writing a report', () => {
  const setup = () => {
    signIn('doctor');
    const okay = () => json(200, { report: report(), canEdit: true });
    api.routes['PUT /appointments/5/report'] = okay;
    api.routes['PUT /appointments/5/report/teeth'] = okay;
    api.routes['PUT /appointments/5/report/medications'] = okay;
  };
  const puts = () => api.calls.filter((c) => c.method === 'PUT');

  async function addMedication(label = 1) {
    await userEvent.click(screen.getByRole('button', { name: 'Add medication' }));
    await userEvent.click(screen.getByLabelText(`Medication ${label}`));
    await userEvent.click(await screen.findByRole('option', { name: 'Amoxicillin' }));
    await userEvent.type(screen.getByLabelText(`Dose ${label}`), '500 mg');
  }

  it('saves the summary, the tooth notes and the prescription, each as its own replace', async () => {
    setup();
    let closed = false;
    renderApp(<ReportDialog open onClose={() => (closed = true)} appointment={APPT} report={null} />);

    await userEvent.type(await screen.findByLabelText('What was done'), 'Root canal on 18');
    await addMedication();
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 18,/ }));
    await userEvent.type(screen.getByLabelText('Occlusal'), 'Deep cavity');
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));

    await waitFor(() => expect(closed).toBe(true));
    expect(puts().map((c) => c.path)).toEqual(['/appointments/5/report', '/appointments/5/report/teeth', '/appointments/5/report/medications']);
    expect(puts()[0]!.body).toEqual({ summary: 'Root canal on 18' });
    expect(puts()[1]!.body.teeth).toEqual([{ toothId: toothId('18'), labial: null, buccal: null, lingual: null, mesial: null, distal: null, occlusal: 'Deep cavity' }]);
    expect(puts()[2]!.body.medications).toEqual([{ medicationId: 1, dose: '500 mg', frequency: 3, timeUnit: 'day', notes: null }]);
  });

  it('starts from the saved report, and highlights teeth that already have notes', async () => {
    setup();
    renderApp(<ReportDialog open onClose={() => {}} appointment={APPT} report={report()} />);
    expect(await screen.findByDisplayValue('Scaling and polishing')).toBeInTheDocument();
    expect(screen.getByDisplayValue('500 mg')).toBeInTheDocument();
    // The chart becomes clickable once the teeth have loaded.
    expect(await screen.findByRole('button', { name: /^Tooth 18,.*has notes/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 18,/ }));
    expect(await screen.findByDisplayValue('Deep cavity')).toBeInTheDocument();
  });

  it('removes a tooth note and a prescription line', async () => {
    setup();
    renderApp(<ReportDialog open onClose={() => {}} appointment={APPT} report={report()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove medication 1' }));
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 18,/ }));
    await userEvent.click(screen.getByRole('button', { name: /Clear this tooth's notes/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(puts()[1]!.body.teeth).toEqual([]);
    expect(puts()[2]!.body.medications).toEqual([]);
  });

  it('will not send anything while a prescription line is incomplete', async () => {
    setup();
    renderApp(<ReportDialog open onClose={() => {}} appointment={APPT} report={null} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add medication' })); // no medication chosen, no dose
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    expect(await screen.findByText('Some prescription lines are incomplete.')).toBeInTheDocument();
    expect(screen.getByText('Choose a medication')).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it('rejects an impossible number of times per day', async () => {
    setup();
    renderApp(<ReportDialog open onClose={() => {}} appointment={APPT} report={null} />);
    await addMedication();
    fireEvent.change(screen.getByLabelText('Times 1'), { target: { value: '30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    expect(await screen.findByText('Some prescription lines are incomplete.')).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it('keeps the dialog open and explains when the server refuses', async () => {
    setup();
    api.routes['PUT /appointments/5/report'] = () => json(403, errorBody('FORBIDDEN', 'Only the treating doctor or an admin can edit this report'));
    let closed = false;
    renderApp(<ReportDialog open onClose={() => (closed = true)} appointment={APPT} report={null} />);
    await userEvent.type(await screen.findByLabelText('What was done'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the treating doctor or an admin');
    expect(closed).toBe(false);
    expect(puts()).toHaveLength(1); // it stopped at the first failure
  });

  it('tells the doctor when the medication list is empty', async () => {
    setup();
    api.routes['GET /medications'] = () => json(200, { data: [] });
    renderApp(<ReportDialog open onClose={() => {}} appointment={APPT} report={null} />);
    expect(await screen.findByText(/medication list is empty/i)).toBeInTheDocument();
  });
});

describe('the timeline', () => {
  const entry = (id: number, date: string, extra: Partial<TimelineEntryDto> = {}): TimelineEntryDto => ({
    appointment: {
      id, date, time: '10:00', endTime: '10:30', durationMinutes: 30, status: 'completed',
      doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, clinic: { id: 1, name: 'Clinic' }, categories: ['Scaling'],
    },
    hasReport: false, report: null, ...extra,
  });

  it('lists appointments with a button to open each report', async () => {
    renderApp(<Timeline entries={[entry(2, '2026-10-20', { hasReport: true, report: report({ teeth: undefined }) }), entry(1, '2026-09-01')]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByText('Scaling', { selector: '.MuiChip-label' })).toHaveLength(2); // one chip per visit
    expect(screen.getAllByRole('button', { name: /report/i })).toHaveLength(1); // only the visit that has one
    expect(screen.queryByText('Scaling and polishing')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('Scaling and polishing')).toBeInTheDocument();
    expect(screen.getByText(/500 mg, 3 times per day/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide report' }));
    await waitFor(() => expect(screen.queryByText('Scaling and polishing')).not.toBeInTheDocument());
  });

  it('shows no tooth notes when the server sent none, as for a patient', async () => {
    renderApp(<Timeline entries={[entry(2, '2026-10-20', { hasReport: true, report: report({ teeth: undefined }) })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    await screen.findByText('Scaling and polishing');
    expect(screen.queryByText(/Tooth notes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Deep cavity/)).not.toBeInTheDocument();
  });

  it('shows tooth notes to clinic viewers', async () => {
    renderApp(<Timeline entries={[entry(2, '2026-10-20', { hasReport: true, report: report() })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText(/occlusal – Deep cavity/)).toBeInTheDocument();
  });

  it('says so when a report exists but cannot be opened', () => {
    renderApp(<Timeline entries={[entry(2, '2026-10-20', { hasReport: true, report: null })]} />);
    expect(screen.getByText(/A report exists, but you can't open it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show report/ })).not.toBeInTheDocument();
  });

  it('opens the appointment for staff, and handles an empty history', async () => {
    const opened: number[] = [];
    const { unmount } = renderApp(<Timeline entries={[entry(7, '2026-10-20')]} onOpenAppointment={(id) => opened.push(id)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open appointment' }));
    expect(opened).toEqual([7]);
    unmount();
    renderApp(<Timeline entries={[]} emptyText="Nothing yet" />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('is on a page of its own, reached from the patient page, which keeps the dental chart', async () => {
    signIn('doctor');
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/timeline'] = () =>
      json(200, { data: [entry(2, '2026-10-20', { hasReport: true, report: report() }), entry(1, '2026-09-01')], meta: { page: 1, pageSize: 50, total: 2 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients/7');
    expect(await screen.findByRole('heading', { name: 'Dental chart' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appointments and reports' })).not.toBeInTheDocument(); // no longer on this page
    expect(api.calls.some((c) => c.path === '/patients/7/timeline')).toBe(false);
    const button = screen.getByRole('link', { name: 'Appointments and reports' });
    expect(button).toHaveAttribute('href', '/patients/7/appointments');
    await userEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'Appointments and reports' })).toBeInTheDocument();
    // (the breadcrumb trail is a list too, so look only at the timeline)
    await waitFor(() => expect(screen.getAllByRole('listitem').filter((li) => !li.closest('nav'))).toHaveLength(2));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/patients/7/timeline' && c.query.get('pageSize') === '50')).toBe(true));
    expect(screen.getByRole('link', { name: 'Back to the patient' })).toHaveAttribute('href', '/patients/7');
  });

  it('offers older appointments when there are more than fit', async () => {
    signIn('admin');
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [entry(1, '2026-09-01')], meta: { page: 1, pageSize: 50, total: 120 } });
    renderApp(<App />, '/patients/7/appointments');
    await userEvent.click(await screen.findByRole('button', { name: 'Show older appointments' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/patients/7/timeline' && c.query.get('pageSize') === '100')).toBe(true));
  });
});

describe("a patient's chart", () => {
  const chart = [
    {
      toothId: toothId('18'), index: '18', name: 'Tooth 18',
      entries: [
        { appointmentId: 1, date: '2026-09-01', doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, labial: null, buccal: null, lingual: null, mesial: null, distal: null, occlusal: 'Cavity' },
        { appointmentId: 2, date: '2026-10-10', doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, labial: null, buccal: null, lingual: null, mesial: 'Filling placed', distal: null, occlusal: 'Cavity filled' },
      ],
    },
  ];

  it('highlights teeth with history and shows each visit’s notes when one is clicked', async () => {
    signIn('doctor');
    api.routes['GET /patients/7/chart'] = () => json(200, { data: chart });
    renderApp(<PatientChart patientId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Tooth 18,.*has notes/ }));
    expect(await screen.findByText(/Filling placed/)).toBeInTheDocument();
    expect(screen.getByText(/Cavity filled/)).toBeInTheDocument();
    expect(screen.getByText(/Cavity$/)).toBeInTheDocument();
    // Only teeth with history can be opened; the others are plain pictures.
    expect(screen.queryByRole('button', { name: /^Tooth 17,/ })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Tooth 17,/ })).toBeInTheDocument();
  });

  it('says when there is no history, and explains when the chart is not available', async () => {
    signIn('doctor');
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    const first = renderApp(<PatientChart patientId={7} />);
    expect(await screen.findByText('No tooth notes have been recorded yet.')).toBeInTheDocument();
    first.unmount();
    api.routes['GET /patients/7/chart'] = () => json(403, errorBody('FORBIDDEN', 'You do not have permission to do this'));
    renderApp(<PatientChart patientId={7} />);
    expect(await screen.findByText('You do not have permission to do this')).toBeInTheDocument();
  });
});

describe('medications', () => {
  const setup = (role: string) => {
    signIn(role);
    api.routes['GET /medications'] = () => json(200, { data: MEDS });
  };

  it('lists the catalog and filters it', async () => {
    setup('doctor');
    renderApp(<App />, '/medications');
    expect(await screen.findByText('Amoxicillin')).toBeInTheDocument();
    expect(screen.getByText('Ibuprofen')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search medications'), 'ibu');
    expect(screen.queryByText('Amoxicillin')).not.toBeInTheDocument();
    expect(screen.getByText('Ibuprofen')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search medications'));
    await userEvent.type(screen.getByLabelText('Search medications'), 'zzz');
    expect(await screen.findByText('No medication matches your search.')).toBeInTheDocument();
  });

  it('adds a medication', async () => {
    setup('doctor');
    api.routes['POST /medications'] = () => json(201, { medication: { id: 3, name: 'Paracetamol', type: 'tablet' } });
    renderApp(<App />, '/medications');
    await userEvent.click(await screen.findByRole('button', { name: 'Add medication' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Paracetamol');
    await userEvent.type(within(dialog).getByLabelText(/^Form/), 'tablet');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Paracetamol', type: 'tablet' });
  });

  it('needs a name, and explains a duplicate', async () => {
    setup('doctor');
    api.routes['POST /medications'] = () => json(409, errorBody('NAME_TAKEN', 'This medication is already in the list'));
    renderApp(<App />, '/medications');
    await userEvent.click(await screen.findByRole('button', { name: 'Add medication' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Name is required')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Amoxicillin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already in the list');
  });

  it('lets only an admin delete', async () => {
    setup('doctor');
    renderApp(<App />, '/medications');
    expect(await screen.findByRole('button', { name: 'Edit Amoxicillin' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('asks before deleting, and shows why a prescribed medication cannot go', async () => {
    setup('admin');
    api.routes['DELETE /medications/1'] = () => json(409, errorBody('MEDICATION_IN_USE', 'This medication appears in prescriptions and cannot be deleted'));
    renderApp(<App />, '/medications');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Amoxicillin' }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/appears in prescriptions and cannot be deleted/)).toBeInTheDocument();
  });

  it('is not available to staff or patients', async () => {
    setup('staff');
    renderApp(<App />, '/medications');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
  });
});

describe('procedures', () => {
  const CATS = [
    { id: 1, name: 'Scaling', priceMin: 20, priceMax: 30, features: [], featurePrices: [] },
    { id: 2, name: 'Composite', priceMin: 30, priceMax: 40, features: ['Large composite'], featurePrices: [20] },
  ];
  const setup = () => {
    signIn('admin');
    api.routes['GET /categories'] = () => json(200, { data: CATS });
  };

  it('lists procedures with their price range and extras', async () => {
    setup();
    renderApp(<App />, '/settings/procedures');
    expect(await screen.findByText('Scaling')).toBeInTheDocument();
    expect(screen.getByText('$20 – $30')).toBeInTheDocument();
    expect(screen.getByText('Large composite (+$20)')).toBeInTheDocument();
  });

  it('adds a procedure with extras', async () => {
    setup();
    api.routes['POST /categories'] = () => json(201, { category: { ...CATS[0], id: 3 } });
    renderApp(<App />, '/settings/procedures');
    await userEvent.click(await screen.findByRole('button', { name: 'Add procedure' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Bridge');
    await userEvent.type(within(dialog).getByLabelText(/^Lowest price/), '200');
    await userEvent.type(within(dialog).getByLabelText(/^Highest price/), '400');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add extra' }));
    await userEvent.type(within(dialog).getByLabelText('Extra 1'), 'Zirconia');
    await userEvent.type(within(dialog).getByLabelText('Price ($)'), '150');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Bridge', priceMin: 200, priceMax: 400, features: ['Zirconia'], featurePrices: [150] });
  });

  it('checks the price range before sending', async () => {
    setup();
    renderApp(<App />, '/settings/procedures');
    await userEvent.click(await screen.findByRole('button', { name: 'Add procedure' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Bridge');
    await userEvent.type(within(dialog).getByLabelText(/^Lowest price/), '500');
    await userEvent.type(within(dialog).getByLabelText(/^Highest price/), '100');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/at least the minimum/i)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('needs a price for every extra', async () => {
    setup();
    renderApp(<App />, '/settings/procedures');
    await userEvent.click(await screen.findByRole('button', { name: 'Add procedure' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Bridge');
    await userEvent.type(within(dialog).getByLabelText(/^Lowest price/), '1');
    await userEvent.type(within(dialog).getByLabelText(/^Highest price/), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add extra' }));
    await userEvent.type(within(dialog).getByLabelText('Extra 1'), 'Zirconia');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('explains when a procedure is in use', async () => {
    setup();
    api.routes['DELETE /categories/1'] = () => json(409, errorBody('CATEGORY_IN_USE', 'This procedure is used by appointments and cannot be deleted'));
    renderApp(<App />, '/settings/procedures');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Scaling' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/used by appointments and cannot be deleted/)).toBeInTheDocument();
  });

  it('is admin only', async () => {
    signIn('doctor');
    renderApp(<App />, '/settings/procedures');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
  });
});

describe('procedures and teeth on an appointment', () => {
  const full = appointment({ teeth: [{ toothId: toothId('18'), index: '18', name: 'Tooth 18', description: 'Cavity' }], categories: [] });

  it('lets a doctor choose procedures and teeth', async () => {
    signIn('doctor');
    api.routes['GET /categories'] = () => json(200, { data: [{ id: 3, name: 'Scaling', priceMin: 1, priceMax: 2, features: [], featurePrices: [] }] });
    api.routes['PUT /appointments/5/categories'] = () => json(200, { appointment: full });
    api.routes['PUT /appointments/5/teeth'] = () => json(200, { appointment: full });
    let closed = false;
    renderApp(<PlanDialog open onClose={() => (closed = true)} appointment={full as never} />);
    await screen.findByRole('button', { name: /^Tooth 18,.*selected/ }); // the planned tooth is pre-selected
    await userEvent.click(screen.getByRole('combobox', { name: 'Procedures' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Scaling' }));
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 17,/ }));
    await userEvent.type(await screen.findByLabelText('Tooth 17: note'), 'Check');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    const puts = api.calls.filter((c) => c.method === 'PUT');
    expect(puts[0]!.body).toEqual({ categoryIds: [3] });
    expect(puts[1]!.body.teeth).toEqual([{ toothId: toothId('18'), description: 'Cavity' }, { toothId: toothId('17'), description: 'Check' }]);
  });

  it('gives staff the procedures only, with no teeth', async () => {
    signIn('staff');
    api.routes['PUT /appointments/5/categories'] = () => json(200, { appointment: full });
    renderApp(<PlanDialog open onClose={() => {}} appointment={full as never} />);
    expect(await screen.findByRole('combobox', { name: 'Procedures' })).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/me')).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText('Teeth involved')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual(['/appointments/5/categories']);
  });
});

describe('linking a doctor to a login', () => {
  const doctors = [{ id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: null, gender: null, kind: 'owner', commissionPercent: null, userId: null }];
  const users = { data: [
    { id: 1, name: 'Aya Ghali', email: 'aya@clinic.test', role: 'admin' },
    { id: 2, name: 'Reception', email: 'desk@clinic.test', role: 'staff' },
    { id: 3, name: 'Dr Two', email: 'two@clinic.test', role: 'doctor' },
  ] };

  const openDoctor = async (role: string) => {
    signIn(role);
    api.routes['GET /doctors'] = () => json(200, { data: doctors });
    api.routes['GET /clinics'] = () => json(200, { data: [] });
    api.routes['GET /users'] = () => json(200, users);
    renderApp(<App />, '/settings/doctors');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Aya Al Ghali' }));
    return screen.findByRole('dialog');
  };

  it('lets an admin choose a login among admin and doctor accounts and sends it', async () => {
    api.routes['PATCH /doctors/1'] = () => json(200, { doctor: { ...doctors[0], userId: 1 } });
    const dialog = await openDoctor('admin');
    await userEvent.click(within(dialog).getByLabelText(/^Login account/));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['None', 'Aya Ghali (aya@clinic.test)', 'Dr Two (two@clinic.test)']); // no reception login
    await userEvent.click(screen.getByRole('option', { name: /Aya Ghali/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body.userId).toBe(1);
  });

  it('does not send the login when it was not changed', async () => {
    api.routes['PATCH /doctors/1'] = () => json(200, { doctor: doctors[0] });
    const dialog = await openDoctor('admin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).not.toHaveProperty('userId');
  });

  it('explains a login that is already linked', async () => {
    api.routes['PATCH /doctors/1'] = () => json(409, errorBody('USER_ALREADY_LINKED', 'That login is already linked to another doctor'));
    const dialog = await openDoctor('admin');
    await userEvent.click(within(dialog).getByLabelText(/^Login account/));
    await userEvent.click(await screen.findByRole('option', { name: /Dr Two/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already linked to another doctor');
  });
});

void empty;
