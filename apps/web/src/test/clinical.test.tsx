import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { AppointmentFormDialog } from '../features/appointments/AppointmentFormDialog';
import { PatientFormDialog } from '../features/patients/PatientFormDialog';
import { CLINIC, CLINIC_DOCTOR, PATIENT, UNIT, appointment, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const signIn = (role: string) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, { slotMinutes: 30, workingDays: [1, 2, 3, 4, 5, 6], cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
  api.routes['GET /doctors'] = () => json(200, { data: [{ id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: 'General', gender: 'female', kind: 'owner' }] });
  api.routes['GET /units'] = () => json(200, { data: [] });
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
};

describe('navigation by role', () => {
  it.each([
    ['admin', ['Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'Doctors', 'Clinics', 'Summary', 'Income tax', 'By doctor', 'Payments', 'Expenses', 'Commission', 'Medications', 'Procedures', 'Labs', 'Suppliers', 'Deleted clinics’ data', 'Users', 'Roles', 'Trash', 'Activity log']],
    ['doctor', ['Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'Doctors', 'By doctor', 'Payments', 'Commission', 'Medications']],
    ['staff', ['Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'Payments', 'Expenses', 'Labs', 'Suppliers']],
    ['patient', ['My appointments', 'My treatment', 'My payments', 'My documents', 'My profile']],
  ])('%s sees the right menu', async (role, items) => {
    signIn(role);
    renderApp(<App />);
    await screen.findByRole('heading', { name: /Welcome/ });
    // jsdom has no media queries, so the drawer renders closed (hidden) but mounted.
    // (A hidden element has no computed accessible name, so find it by its aria-label.)
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
    const labels = within(nav).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(labels).toEqual(['Dashboard', ...items]);
  });

  it('keeps staff out of the doctors & clinics page', async () => {
    signIn('staff');
    renderApp(<App />, '/settings/doctors');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.queryByText('Clinics & hours')).not.toBeInTheDocument();
  });

  it('keeps patients out of the patient list', async () => {
    signIn('patient');
    renderApp(<App />, '/patients');
    api.routes['GET /portal/overview'] = () => json(200, { patient: { id: 7, fname: 'Pat', lname: 'Patient', patientIdentifier: '100001', username: 'pat.patient', doctor: null }, next: null, upcomingCount: 0, balance: { price: 0, paid: 0, remaining: 0, currency: '$' }, documentsCount: 0, cancelMinHours: 24 });
    expect(await screen.findByRole('heading', { name: 'Your next appointment' })).toBeInTheDocument(); // sent to their own home page
    expect(screen.queryByRole('heading', { name: 'Patients' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/patients')).toBe(false);
  });
});

describe('patients list', () => {
  const page = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 25, total: data.length } });

  it('shows patients and opens one when clicked', async () => {
    signIn('staff');
    api.routes['GET /patients'] = () => page([PATIENT]);
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/appointments'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients');

    expect(await screen.findByText('Hicham Cheaib')).toBeInTheDocument();
    expect(screen.getByText('03039198')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Hicham Cheaib'));
    expect(await screen.findByRole('heading', { name: 'Hicham Cheaib' })).toBeInTheDocument();
    expect(screen.getByText('Patient #100007')).toBeInTheDocument();
  });

  it('searches after a short pause, sending the text to the server', async () => {
    signIn('staff');
    api.routes['GET /patients'] = () => page([]);
    renderApp(<App />, '/patients');
    await userEvent.type(await screen.findByLabelText('Search patients'), 'hicham');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/patients' && c.query.get('q') === 'hicham')).toBe(true));
    // Typing six letters must not fire six requests.
    expect(api.calls.filter((c) => c.path === '/patients' && c.query.get('q')).length).toBeLessThanOrEqual(2);
    expect(await screen.findByText(/No patients match/)).toBeInTheDocument();
  });

  it('shows the server’s error instead of a blank page', async () => {
    signIn('staff');
    api.routes['GET /patients'] = () => json(500, errorBody('INTERNAL', 'Something went wrong'));
    renderApp(<App />, '/patients');
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });
});

describe('new patient form', () => {
  it('validates before sending anything', async () => {
    signIn('staff');
    renderApp(<PatientFormDialog open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText(/is required/)).not.toHaveLength(0);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a patient, sending empty optional fields as null', async () => {
    signIn('staff');
    api.routes['POST /patients'] = () => json(201, { patient: PATIENT });
    let saved: unknown;
    renderApp(<PatientFormDialog open onClose={() => {}} onSaved={(p) => (saved = p)} />);
    await userEvent.type(await screen.findByLabelText(/First name/), 'Hicham');
    await userEvent.type(screen.getByLabelText(/Last name/), 'Cheaib');
    await userEvent.type(screen.getByLabelText(/Phone/), '03039198');
    await userEvent.click(screen.getByLabelText(/Primary doctor/));
    await userEvent.click(await screen.findByRole('option', { name: 'Aya Al Ghali' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toEqual(PATIENT));
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ fname: 'Hicham', lname: 'Cheaib', phone: '03039198', email: null, dateOfBirth: null, gender: null, doctorId: 1 });
  });

  it('warns about duplicates and creates anyway only when asked', async () => {
    signIn('staff');
    api.routes['POST /patients'] = (c) =>
      c.query.get('allowDuplicate') === 'true' ? json(201, { patient: PATIENT }) : json(409, errorBody('DUPLICATE_PATIENT', 'A patient with the same name and phone already exists'));
    let saved = false;
    renderApp(<PatientFormDialog open onClose={() => {}} onSaved={() => (saved = true)} />);
    await userEvent.type(await screen.findByLabelText(/First name/), 'Hicham');
    await userEvent.type(screen.getByLabelText(/Last name/), 'Cheaib');
    await userEvent.type(screen.getByLabelText(/Phone/), '03039198');
    await userEvent.click(screen.getByLabelText(/Primary doctor/));
    await userEvent.click(await screen.findByRole('option', { name: 'Aya Al Ghali' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(saved).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(saved).toBe(true));
  });
});

describe('the primary doctor of a new patient', () => {
  it('has to be chosen before anything is sent', async () => {
    signIn('staff');
    renderApp(<PatientFormDialog open onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText(/First name/), 'Hicham');
    await userEvent.type(screen.getByLabelText(/Last name/), 'Cheaib');
    await userEvent.type(screen.getByLabelText(/Phone/), '03039198');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the primary doctor')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('offers no "None" for a new patient, but keeps it for an older patient who has no doctor', async () => {
    signIn('staff');
    const first = renderApp(<PatientFormDialog open onClose={() => {}} />);
    await userEvent.click(await screen.findByLabelText(/Primary doctor/));
    expect(screen.queryByRole('option', { name: 'None' })).not.toBeInTheDocument();
    first.unmount();
    renderApp(<PatientFormDialog open onClose={() => {}} patient={{ ...PATIENT, doctorId: null }} />);
    await userEvent.click(await screen.findByLabelText(/Primary doctor/));
    expect(await screen.findByRole('option', { name: 'None' })).toBeInTheDocument();
  });
});

describe('booking an appointment', () => {
  const busyDay = {
    date: '2026-10-06',
    doctorBusy: [{ appointmentId: 9, start: '09:30', end: '10:00', durationMinutes: 30, status: 'confirmed', patientName: 'Olga Other' }],
    unitBusy: [{ appointmentId: 9, start: '09:30', end: '10:00', durationMinutes: 30, status: 'confirmed', patientName: 'Olga Other' }],
  };

  const setup = (role = 'staff') => {
    signIn(role);
    api.routes['GET /clinics'] = () => json(200, { data: [CLINIC] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [CLINIC_DOCTOR] });
    api.routes['GET /units'] = () => json(200, { data: [UNIT] });
    api.routes['GET /categories'] = () => json(200, { data: [{ id: 3, name: 'Scaling', priceMin: 20, priceMax: 30 }] });
    api.routes['GET /patients'] = () => json(200, { data: [PATIENT], meta: { page: 1, pageSize: 10, total: 1 } });
    api.routes['GET /appointments/busy'] = () => json(200, busyDay);
  };

  async function fillPatientAndDate() {
    await userEvent.type(await screen.findByLabelText(/^Patient/), 'hic');
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    // The only clinic and its only doctor are chosen, and the owner's own dental unit with them.
    await waitFor(() => expect(screen.getByLabelText(/^Doctor/)).toHaveTextContent('Aya Al Ghali'));
    await waitFor(() => expect(screen.getByLabelText(/^Dental unit/)).toHaveTextContent("Dr Aya's unit"));
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-10-06' } });
  }

  const setTime = (value: string) => fireEvent.change(screen.getByLabelText(/^Start time/), { target: { value } });

  it('books any time with the default length, on the doctor’s own unit', async () => {
    setup();
    api.routes['POST /appointments'] = () => json(201, { appointment: appointment() });
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    setTime('10:15');
    expect(await screen.findByText('Ends at 10:45')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/appointments')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      patientId: 7, doctorId: 1, clinicId: 1, unitId: 1, date: '2026-10-06', time: '10:15', durationMinutes: 30, status: 'confirmed',
    });
  });

  it('lets the length be chosen in 15-minute steps', async () => {
    setup();
    api.routes['POST /appointments'] = () => json(201, { appointment: appointment() });
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    setTime('13:00');
    await userEvent.click(screen.getByLabelText(/^Length/));
    await userEvent.click(await screen.findByRole('option', { name: '1 h 30 min' }));
    expect(await screen.findByText('Ends at 14:30')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body.durationMinutes).toBe(90);
  });

  it('shows what is already booked that day for the doctor and the unit', async () => {
    setup();
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    expect(await screen.findAllByText('09:30–10:00 · Olga Other')).toHaveLength(2);
    const busyCall = api.calls.find((c) => c.path === '/appointments/busy')!;
    expect(busyCall.query.get('doctorId')).toBe('1');
    expect(busyCall.query.get('unitId')).toBe('1');
  });

  it('warns about an overlap and will not submit it', async () => {
    setup();
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    await screen.findAllByText('09:30–10:00 · Olga Other');
    setTime('09:45');
    expect(await screen.findByText(/The doctor is busy from 09:30 to 10:00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();

    setTime('10:00'); // touching is fine
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book' })).toBeEnabled());
  });

  it('warns about appointments that would run past midnight', async () => {
    setup();
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    setTime('23:45');
    expect(await screen.findByText(/must end before midnight/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
  });

  it('asks for a time before booking', async () => {
    setup();
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    expect(await screen.findByText('Choose a time')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the reason when someone else took the time meanwhile', async () => {
    setup();
    api.routes['POST /appointments'] = () => json(409, errorBody('UNIT_BUSY', 'The dental unit is already in use from 11:00 to 11:30'));
    renderApp(<AppointmentFormDialog open onClose={() => {}} />);
    await fillPatientAndDate();
    setTime('11:00');
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('dental unit is already in use');
  });

  it('sends only what changed when rescheduling', async () => {
    setup();
    api.routes['PATCH /appointments/5'] = () => json(200, { appointment: appointment({ time: '10:30' }) });
    renderApp(<AppointmentFormDialog open onClose={() => {}} appointment={appointment() as never} />);
    await screen.findByDisplayValue('2026-10-06');
    setTime('10:30');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ time: '10:30' });
  });

  it('lets a doctor extend an appointment but not staff', async () => {
    setup('doctor');
    api.routes['PATCH /appointments/5'] = () => json(200, { appointment: appointment({ durationMinutes: 60, endTime: '11:00' }) });
    const first = renderApp(<AppointmentFormDialog open onClose={() => {}} appointment={appointment() as never} />);
    await screen.findByDisplayValue('2026-10-06');
    // (The signed-in user loads asynchronously, which is what unlocks the field.)
    await waitFor(() => expect(screen.getByLabelText(/^Length/)).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(screen.getByLabelText(/^Length/));
    await userEvent.click(await screen.findByRole('option', { name: '1 h' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ durationMinutes: 60 });
    first.unmount();

    api.calls.length = 0;
    signIn('staff');
    renderApp(<AppointmentFormDialog open onClose={() => {}} appointment={appointment() as never} />);
    await screen.findByDisplayValue('2026-10-06');
    // Let the signed-in user (staff) finish loading, then check the field is still locked.
    await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/me')).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(screen.getByLabelText(/^Length/)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Only a doctor or an admin can change the length')).toBeInTheDocument();
  });
});

describe('appointment actions', () => {
  const open = async (role: string, status: string) => {
    signIn(role);
    api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment({ status }) });
    api.routes['GET /appointments'] = () => json(200, { data: [appointment({ status })], meta: { page: 1, pageSize: 25, total: 1 } });
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'List' }));
    await userEvent.click(await screen.findByText('Hicham Cheaib'));
    await screen.findByRole('dialog');
  };
  const buttons = () => within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent);

  it('offers staff the actions that fit a pending appointment', async () => {
    await open('staff', 'pending');
    expect(buttons()).toEqual(expect.arrayContaining(['Confirm', 'Edit / reschedule', 'Cancel appointment']));
    expect(buttons()).not.toContain('Complete visit');
  });

  it('lets only doctors and admins complete a visit', async () => {
    await open('staff', 'confirmed');
    expect(buttons()).not.toContain('Complete visit');
  });

  it('shows no actions on a finished appointment', async () => {
    await open('doctor', 'completed');
    expect(buttons()).toEqual(['Procedures & teeth', 'Delete', 'Close']);
  });

  it('asks before cancelling, and cancels once confirmed', async () => {
    await open('staff', 'confirmed');
    api.routes['POST /appointments/5/cancel'] = () => json(200, { appointment: appointment({ status: 'cancelled' }) });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }));

    // Nothing is sent until the second, confirming dialog is accepted.
    expect(api.calls.some((c) => c.path === '/appointments/5/cancel')).toBe(false);
    const dialogs = await screen.findAllByRole('dialog');
    // MUI hides the dialog underneath from assistive tech, so the confirmation is the one found.
    expect(dialogs.length).toBeGreaterThanOrEqual(1);
    await userEvent.click(within(dialogs.at(-1)!).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments/5/cancel' && c.method === 'POST')).toBe(true));
  });
});

describe('doctors & clinics', () => {
  const clinicSetup = (role: string) => {
    signIn(role);
    api.routes['GET /clinics'] = () => json(200, { data: [CLINIC] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [{ ...CLINIC_DOCTOR, drPart: 100 }] });
    api.routes['GET /units'] = () => json(200, { data: [UNIT] });
    api.routes['GET /doctors'] = () =>
      json(200, {
        data: [
          { id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: 'General', gender: 'female', kind: 'owner', commissionPercent: null },
          { id: 2, fname: 'Cidra', lname: 'Specialist', speciality: 'Surgery', gender: 'female', kind: 'external', commissionPercent: 30 },
          { id: 3, fname: 'Ahmad', lname: 'Visitor', speciality: null, gender: 'male', kind: 'external', commissionPercent: null },
        ],
      });
  };

  it('shows each clinic with its dental units and doctors, without any working hours', async () => {
    clinicSetup('admin');
    renderApp(<App />, '/settings/clinics');
    expect(await screen.findByText("Dr Aya's unit")).toBeInTheDocument();
    expect(screen.getByText(/Owner: Dr Aya Al Ghali/)).toBeInTheDocument();
    expect(screen.getByText(/Owner · General · share 100%/)).toBeInTheDocument();
    expect(screen.queryByText(/working hours/i)).not.toBeInTheDocument();
  });

  it('tells the admin an owner doctor gets a unit when assigned', async () => {
    clinicSetup('admin');
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [] });
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Assign doctor' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Dr Aya will get a dental unit/)).toBeInTheDocument();
  });

  it('assigns a doctor with only their share, no schedule', async () => {
    clinicSetup('admin');
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [] });
    api.routes['PUT /clinics/1/doctors/1'] = () => json(201, { link: { ...CLINIC_DOCTOR, drPart: 80 } });
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Assign doctor' }));
    const dialog = await screen.findByRole('dialog');
    const share = within(dialog).getByLabelText(/Doctor's share/);
    await userEvent.clear(share);
    await userEvent.type(share, '80');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ drPart: 80 });
  });

  it('shows the server’s explanation when a unit cannot be deleted', async () => {
    clinicSetup('admin');
    api.routes['DELETE /units/1'] = () => json(409, errorBody('UNIT_IN_USE', 'This dental unit has appointments and cannot be deleted'));
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: "Delete Dr Aya's unit" }));
    expect(await screen.findByText(/has appointments and cannot be deleted/)).toBeInTheDocument();
  });

  it('removes a doctor from a clinic', async () => {
    clinicSetup('admin');
    api.routes['DELETE /clinics/1/doctors/1'] = () => empty();
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: /Remove Aya Al Ghali/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  describe('the doctors list', () => {
    const openDoctors = async () => {
      renderApp(<App />, '/settings/doctors');
      await screen.findByText('Cidra Specialist');
    };

    it('lists owner doctors and external specialists in separate tables, flagging specialists without a percentage', async () => {
      clinicSetup('admin');
      await openDoctors();
      const owners = within(await screen.findByRole('table', { name: 'Owner doctors' }));
      const externals = within(screen.getByRole('table', { name: 'External specialists' }));
      expect(owners.getByText('Aya Al Ghali')).toBeInTheDocument();
      expect(owners.queryByText('Cidra Specialist')).not.toBeInTheDocument();
      expect(owners.queryByText('Commission')).not.toBeInTheDocument();
      const row = (name: string) => externals.getByText(new RegExp(name)).closest('tr')!.textContent;
      expect(row('Cidra')).toContain('30%');
      expect(row('Ahmad')).toContain('Not set');
      expect(externals.queryByText('Aya Al Ghali')).not.toBeInTheDocument();
    });

    it('lets an admin set the income tax family details on a doctor’s profile, sending only what changed', async () => {
      clinicSetup('admin');
      api.routes['GET /doctors'] = () => json(200, { data: [{ id: 2, fname: 'Cidra', lname: 'Specialist', speciality: 'Surgery', gender: 'female', kind: 'external', commissionPercent: 30, taxSpouse: false, taxChildren: 1 }] });
      api.routes['PATCH /doctors/2'] = () => json(200, { doctor: { id: 2, fname: 'Cidra', lname: 'Specialist', kind: 'external', commissionPercent: 30, taxSpouse: true, taxChildren: 1 } });
      await openDoctors();
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Cidra Specialist' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('Eligible children (income tax)')).toHaveValue(1);
      expect(within(dialog).getByLabelText('Spouse is eligible (income tax)')).not.toBeChecked();
      await userEvent.click(within(dialog).getByLabelText('Spouse is eligible (income tax)'));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH' && c.path === '/doctors/2')).toBe(true));
      const body = api.calls.find((c) => c.method === 'PATCH')!.body;
      expect(body.taxSpouse).toBe(true);
      expect(body.taxChildren).toBeUndefined(); // unchanged, so not sent
    });

    it('keeps the family details out of the form for anyone but an admin, and for a new doctor', async () => {
      clinicSetup('doctor');
      api.routes['GET /auth/me'] = () => json(200, { user: user('doctor', { doctor: { id: 1, kind: 'owner' } }) });
      await openDoctors();
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Cidra Specialist' }));
      expect(within(await screen.findByRole('dialog')).queryByLabelText('Spouse is eligible (income tax)')).not.toBeInTheDocument();
    });

    it('requires a commission percentage for an external doctor', async () => {
      clinicSetup('admin');
      await openDoctors();
      await userEvent.click(await screen.findByRole('button', { name: 'Add doctor' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(within(dialog).getByLabelText(/First name/), 'New');
      await userEvent.type(within(dialog).getByLabelText(/Last name/), 'Specialist');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByText(/commission percentage is required/i)).toBeInTheDocument();
      expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

      api.routes['POST /doctors'] = () => json(201, { doctor: { id: 9, fname: 'New', lname: 'Specialist', kind: 'external', commissionPercent: 25 } });
      await userEvent.type(within(dialog).getByLabelText(/Commission percentage/), '25');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
      expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ fname: 'New', kind: 'external', commissionPercent: 25 });
    });

    it('hides the percentage for an owner doctor', async () => {
      clinicSetup('admin');
      await openDoctors();
      await userEvent.click(await screen.findByRole('button', { name: 'Add doctor' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByLabelText(/^Kind/));
      await userEvent.click(await screen.findByRole('option', { name: 'Owner' }));
      expect(within(dialog).queryByLabelText(/Commission percentage/)).not.toBeInTheDocument();
    });

    it('lets an owner doctor manage only external doctors', async () => {
      clinicSetup('doctor');
      renderApp(<App />, '/settings/doctors');
      // An owner doctor has no Clinics page, only the doctors.
      expect(await screen.findByRole('button', { name: 'Add doctor' })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Edit Cidra Specialist' })).toBeInTheDocument(); // an external doctor
      
      expect(screen.queryByRole('button', { name: 'Edit Aya Al Ghali' })).not.toBeInTheDocument(); // owner: admin only
      expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument(); // delete: admin only

      await userEvent.click(screen.getByRole('button', { name: 'Add doctor' }));
      expect(within(await screen.findByRole('dialog')).getByLabelText(/^Kind/)).toHaveAttribute('aria-disabled', 'true');
    });
  });
});

describe('creating dental units', () => {
  const setup = (links: object[]) => {
    signIn('admin');
    api.routes['GET /clinics'] = () => json(200, { data: [CLINIC] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: links });
    api.routes['GET /units'] = () => json(200, { data: [UNIT] });
  };
  const owner = { ...CLINIC_DOCTOR, drPart: 100 };
  const external = { doctorId: 2, clinicId: 1, fname: 'Cidra', lname: 'Specialist', speciality: null, kind: 'external', drPart: 100 };

  it('adds a unit for an owner doctor who works at the clinic', async () => {
    setup([owner, external]);
    api.routes['POST /units'] = () => json(201, { unit: { ...UNIT, id: 2, name: 'Room 2' } });
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Add dental unit' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Room 2');

    // Only owners are offered; the external doctor cannot own a unit.
    await userEvent.click(within(dialog).getByLabelText(/^Owner doctor/));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Aya Al Ghali']);
    await userEvent.click(options[0]!);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/units')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ clinicId: 1, ownerDoctorId: 1, name: 'Room 2' });
  });

  it('needs a name', async () => {
    setup([owner]);
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Add dental unit' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    expect(await within(dialog).findByText('Name is required')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('explains a duplicate name', async () => {
    setup([owner]);
    api.routes['POST /units'] = () => json(409, errorBody('NAME_TAKEN', 'This clinic already has a dental unit with that name'));
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Add dental unit' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Dr Aya's unit");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already has a dental unit with that name');
  });

  it('is unavailable until an owner doctor works at the clinic', async () => {
    setup([external]);
    renderApp(<App />, '/settings/clinics');
    expect(await screen.findByRole('button', { name: 'Add dental unit' })).toBeDisabled();
  });
});

describe('appointments by dental unit', () => {
  const sara = { id: 2, clinicId: 1, name: "Dr Sara's unit", ownerDoctorId: 4, ownerName: 'Sara Doughan' };
  const setup = (appointments: object[]) => {
    signIn('staff');
    api.routes['GET /units'] = () => json(200, { data: [UNIT, sara] });
    api.routes['GET /appointments'] = () => json(200, { data: appointments, meta: { page: 1, pageSize: 500, total: appointments.length } });
    api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment() });
    api.routes['GET /clinics'] = () => json(200, { data: [CLINIC] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [CLINIC_DOCTOR] });
    api.routes['GET /categories'] = () => json(200, { data: [] });
  };
  const open = async () => {
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'By unit' }));
  };

  it('shows one column per dental unit with its owner, and where each appointment sits', async () => {
    setup([appointment(), appointment({ id: 6, unitId: 2, unit: { id: 2, name: "Dr Sara's unit", ownerDoctorId: 4 }, time: '14:00', endTime: '15:30', durationMinutes: 90 })]);
    await open();
    const aya = await screen.findByRole('group', { name: "Dr Aya's unit" });
    const saraCol = screen.getByRole('group', { name: "Dr Sara's unit" });
    expect(within(aya).getByText('Dr Aya Al Ghali')).toBeInTheDocument();
    expect(await within(aya).findByRole('button', { name: /10:00 to 10:30, Hicham Cheaib, Confirmed/ })).toBeInTheDocument();
    expect(within(saraCol).getByRole('button', { name: /14:00 to 15:30/ })).toBeInTheDocument();
    expect(within(aya).queryByRole('button', { name: /14:00/ })).not.toBeInTheDocument(); // on the other unit

    // Taller blocks for longer appointments (66 px per hour).
    const long = within(saraCol).getByRole('button', { name: /14:00 to 15:30/ });
    const short = within(aya).getByRole('button', { name: /10:00 to 10:30/ });
    expect(parseFloat(long.style.height || getComputedStyle(long).height)).toBeGreaterThan(parseFloat(short.style.height || getComputedStyle(short).height));
  });

  it('asks for today’s appointments, and moves day by day', async () => {
    setup([]);
    await open();
    await screen.findByRole('group', { name: "Dr Aya's unit" });
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && c.query.get('from') === '2026-10-05')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && c.query.get('from') === '2026-10-06' && c.query.get('to') === '2026-10-06')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && c.query.get('from') === '2026-10-04')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByLabelText('Day')).toHaveValue('2026-10-05'));
  });

  it('opens an appointment when its block is clicked', async () => {
    setup([appointment()]);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /10:00 to 10:30, Hicham Cheaib/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Hicham Cheaib');
  });

  it('starts a booking on the unit that was clicked, suggesting its owner as the doctor', async () => {
    setup([]);
    await open();
    const aya = await screen.findByRole('group', { name: "Dr Aya's unit" });
    fireEvent.click(aya.children[1]!, { clientY: 0 }); // the empty column body
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Book appointment')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText(/^Dental unit/)).toHaveTextContent("Dr Aya's unit"));
    await waitFor(() => expect(within(dialog).getByLabelText(/^Doctor/)).toHaveTextContent('Aya Al Ghali'));
    expect(within(dialog).getByLabelText(/^Date/)).toHaveValue('2026-10-05');
  });

  it('warns about appointments that have no unit instead of hiding them', async () => {
    setup([appointment({ id: 8, unitId: null, unit: null })]);
    await open();
    expect(await screen.findByText(/1 appointment has no dental unit/)).toBeInTheDocument();
  });

  it('explains when there are no units yet', async () => {
    setup([]);
    api.routes['GET /units'] = () => json(200, { data: [] });
    await open();
    expect(await screen.findByText(/no dental units yet/i)).toBeInTheDocument();
  });

  it('can also show cancelled appointments', async () => {
    setup([]);
    await open();
    await screen.findByRole('group', { name: "Dr Aya's unit" });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show cancelled' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && !c.query.get('status'))).toBe(true));
  });
});

describe('appointment list filters', () => {
  it('filters by dental unit', async () => {
    signIn('staff');
    api.routes['GET /units'] = () => json(200, { data: [UNIT] });
    api.routes['GET /appointments'] = () => json(200, { data: [appointment()], meta: { page: 1, pageSize: 25, total: 1 } });
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'List' }));
    await userEvent.click(await screen.findByLabelText('Dental unit'));
    await userEvent.click(await screen.findByRole('option', { name: "Dr Aya's unit" }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && c.query.get('unitId') === '1')).toBe(true));
  });
});
