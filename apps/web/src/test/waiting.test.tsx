import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-07' };
const ticket = (extra: object = {}) => ({
  id: 1, number: 1, date: '2026-10-07', status: 'waiting', patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, doctor: { id: 1, fname: 'Aya', lname: 'Ghali' },
  unit: { id: 3, name: 'Unit A' }, appointment: null, arrivedAt: '2026-10-07 07:00:00', calledAt: null, callCount: 0, finishedAt: null, ...extra,
});
const list = (data: unknown[]) => json(200, { date: '2026-10-07', data });
const STAFF_PERMS = ['waiting:read', 'waiting:create', 'waiting:update'];
const DOCTOR_PERMS = ['waiting:read', 'waiting:update'];
const calls = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);

const open = async (role = 'staff', tickets: unknown[] = [ticket(), ticket({ id: 2, number: 2, patient: { id: 8, fname: 'Nadia', lname: 'Khoury' } })], permissions = role === 'doctor' ? DOCTOR_PERMS : STAFF_PERMS) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, { permissions }) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /waiting-room'] = () => list(tickets);
  api.routes['GET /waiting-room/candidates'] = () => json(200, { data: [] });
  api.routes['GET /doctors'] = () => json(200, { data: [{ id: 1, fname: 'Aya', lname: 'Ghali', speciality: 'General', gender: 'female', kind: 'owner' }, { id: 2, fname: 'Sara', lname: 'Doughan', speciality: null, gender: 'female', kind: 'owner' }] });
  api.routes['GET /units'] = () => json(200, { data: [{ id: 3, clinicId: 1, name: 'Unit A', ownerDoctorId: 1, ownerName: 'Aya Ghali' }, { id: 4, clinicId: 1, name: 'Unit B', ownerDoctorId: 2, ownerName: 'Sara Doughan' }] });
  renderApp(<App />, '/waiting-room');
  await screen.findByRole('heading', { name: 'Waiting room' });
};

describe('the waiting room page', () => {
  it('lists today’s numbers with the patient, doctor, dental unit and status, and counts them', async () => {
    await open('staff', [ticket(), ticket({ id: 2, number: 2, status: 'called', callCount: 2, calledAt: '2026-10-07 07:10:00', patient: { id: 8, fname: 'Nadia', lname: 'Khoury' } }), ticket({ id: 3, number: 3, status: 'done' })]);
    const table = await screen.findByRole('table', { name: 'Waiting room' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2); // the finished one is under "Finished"
    expect(within(rows[0]!).getByText('1')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Hicham Cheaib')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Dr. Aya Ghali')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Unit A')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Waiting')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Called')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('called 2 times')).toBeInTheDocument();
    expect(screen.getByText('1 waiting')).toBeInTheDocument();
    expect(screen.getByText('1 being called')).toBeInTheDocument();
    expect(screen.getByText('1 finished')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finished' }));
    expect(within(screen.getByRole('table', { name: 'Waiting room' })).getAllByRole('row')).toHaveLength(2); // header and the one done
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(within(screen.getByRole('table', { name: 'Waiting room' })).getAllByRole('row')).toHaveLength(4);
  });

  it('says so when nobody has a number', async () => {
    await open('staff', []);
    expect(await screen.findByText('Nobody has been given a number today.')).toBeInTheDocument();
  });

  it('sorts by any column', async () => {
    await open('staff', [ticket(), ticket({ id: 2, number: 2, patient: { id: 8, fname: 'Adam', lname: 'Zed' } })]);
    const table = await screen.findByRole('table', { name: 'Waiting room' });
    const names = () => within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(names()).toEqual(['Hicham Cheaib', 'Adam Zed']);
    await userEvent.click(within(table).getByRole('button', { name: /Patient/ }));
    expect(names()).toEqual(['Adam Zed', 'Hicham Cheaib']);
    await userEvent.click(within(table).getByRole('button', { name: /Number/ }));
    await userEvent.click(within(table).getByRole('button', { name: /Number/ }));
    expect(names()).toEqual(['Adam Zed', 'Hicham Cheaib']); // number 2 first when descending
  });

  it('calls a patient by number, and says so', async () => {
    await open();
    api.routes['POST /waiting-room/1/call'] = () => json(200, { ticket: ticket({ status: 'called', callCount: 1 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Call number 1' }));
    await waitFor(() => expect(calls('POST', '/waiting-room/1/call')).toHaveLength(1));
    expect(await screen.findByText('Patient called')).toBeInTheDocument();
  });

  it('offers the right buttons for a called patient: call again, finish, back to waiting, did not come', async () => {
    await open('staff', [ticket({ status: 'called', callCount: 1 })]);
    for (const [name, action] of [['Call number 1 again', 'call'], ['Finish number 1', 'finish'], ['Put number 1 back to waiting', 'requeue'], ['Remove number 1', 'leave']] as const) {
      api.routes[`POST /waiting-room/1/${action}`] = () => json(200, { ticket: ticket() });
      await userEvent.click(await screen.findByRole('button', { name }));
      await waitFor(() => expect(calls('POST', `/waiting-room/1/${action}`)).toHaveLength(1));
    }
    expect(screen.getByRole('button', { name: 'Remove number 1' })).toHaveTextContent('Did not come');
  });

  it('shows the server’s refusal', async () => {
    await open();
    api.routes['POST /waiting-room/1/call'] = () => json(409, errorBody('TICKET_EXPIRED', 'This number was for an earlier day'));
    await userEvent.click(await screen.findByRole('button', { name: 'Call number 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This number was for an earlier day');
  });

  it('lets a doctor call the next patient in line, and has no way to give a number', async () => {
    await open('doctor', [ticket({ id: 2, number: 2 }), ticket({ id: 1, number: 1 }), ticket({ id: 3, number: 3, status: 'called' })]);
    expect(screen.queryByRole('button', { name: 'Give a number' })).not.toBeInTheDocument();
    api.routes['POST /waiting-room/1/call'] = () => json(200, { ticket: ticket({ status: 'called' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Call the next patient (number 1)' }));
    await waitFor(() => expect(calls('POST', '/waiting-room/1/call')).toHaveLength(1));
  });

  it('shows read-only people no buttons at all', async () => {
    await open('staff', [ticket()], ['waiting:read']);
    await screen.findByRole('table', { name: 'Waiting room' });
    expect(screen.queryByRole('button', { name: /Call number/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give a number' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });
});

describe('giving a number', () => {
  const candidates = [{ appointmentId: 5, time: '10:30', patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, unit: { id: 3, name: 'Unit A' } }];

  it('gives a number to someone expected today in one click, and shows it large', async () => {
    await open('staff', []);
    api.routes['GET /waiting-room/candidates'] = () => json(200, { data: candidates });
    api.routes['POST /waiting-room'] = () => json(201, { ticket: ticket({ number: 12 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Give a number' }));
    const dialog = await screen.findByRole('dialog', { name: 'Give a number' });
    expect(await within(dialog).findByText('Hicham Cheaib')).toBeInTheDocument();
    expect(within(dialog).getByText('10:30')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Give a number to Hicham Cheaib' }));
    await waitFor(() => expect(calls('POST', '/waiting-room')).toHaveLength(1));
    expect(calls('POST', '/waiting-room')[0]!.body).toEqual({ patientId: 7, appointmentId: 5 });
    expect(await within(dialog).findByLabelText('Number 12')).toHaveTextContent('12');
    expect(within(dialog).getByText(/Unit A/)).toBeInTheDocument();
    expect(await screen.findByText('Number given')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('gives a number to anyone: choosing the patient, the doctor (whose own unit is suggested) and the dental unit', async () => {
    await open('staff', []);
    api.routes['GET /patients'] = () => json(200, { data: [PATIENT], meta: { page: 1, pageSize: 10, total: 1 } });
    api.routes['POST /waiting-room'] = () => json(201, { ticket: ticket({ number: 4 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Give a number' }));
    const dialog = await screen.findByRole('dialog', { name: 'Give a number' });
    expect(await within(dialog).findByText('Nobody else is expected today without a number.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Give a number to this patient' }));
    expect(await within(dialog).findByText('Choose a patient')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/^Patient/), 'Hich');
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Give a number to this patient' }));
    expect(await within(dialog).findByText('Choose the doctor and the dental unit')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText('Doctor'));
    await userEvent.click(await screen.findByRole('option', { name: 'Dr. Sara Doughan' }));
    expect(within(dialog).getByLabelText('Dental unit')).toHaveTextContent('Unit B'); // Sara's own unit
    await userEvent.click(within(dialog).getByRole('button', { name: 'Give a number to this patient' }));
    await waitFor(() => expect(calls('POST', '/waiting-room')).toHaveLength(1));
    expect(calls('POST', '/waiting-room')[0]!.body).toEqual({ patientId: 7, doctorId: 2, unitId: 4 });
    expect(await within(dialog).findByLabelText('Number 4')).toBeInTheDocument();
  });

  it('says why when the patient already has a number', async () => {
    await open('staff', []);
    api.routes['GET /waiting-room/candidates'] = () => json(200, { data: candidates });
    api.routes['POST /waiting-room'] = () => json(409, errorBody('ALREADY_WAITING', 'This patient already has a number today'));
    await userEvent.click(await screen.findByRole('button', { name: 'Give a number' }));
    const dialog = await screen.findByRole('dialog', { name: 'Give a number' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Give a number to Hicham Cheaib' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This patient already has a number today');
  });
});

describe('the screen in the waiting room', () => {
  const show = (key: string | null, body: unknown) => {
    api.routes['GET /waiting-display'] = (c) => (c.query.get('key') === key ? json(200, body) : json(404, errorBody('NOT_FOUND', 'Not found')));
    renderApp(<App />, `/waiting-display${key ? `?key=${key}` : ''}`);
  };

  it('shows the number being called large with the dental unit, the others smaller, and how many wait: never a name', async () => {
    show('abc', { clinic: 'Hamra Clinic', waiting: 3, calls: [{ number: 12, unit: 'Unit A', calledAt: '2026-10-07 07:10:00', callCount: 1 }, { number: 9, unit: 'Unit B', calledAt: '2026-10-07 07:05:00', callCount: 1 }] });
    expect(await screen.findByText('Now calling')).toBeInTheDocument();
    expect(screen.getByLabelText('Number 12')).toHaveTextContent('12');
    expect(screen.getByText('Please go to Unit A')).toBeInTheDocument();
    const others = within(screen.getByRole('list'));
    expect(others.getByText('9')).toBeInTheDocument();
    expect(others.getByText('Unit B')).toBeInTheDocument();
    expect(screen.getByText('3 waiting')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hamra Clinic' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/auth/me')).toBe(false); // no sign-in involved
    expect(api.calls.find((c) => c.path === '/waiting-display')!.query.get('key')).toBe('abc');
  });

  it('asks the people in the room to wait when nobody is being called', async () => {
    show('abc', { clinic: 'Hamra Clinic', waiting: 0, calls: [] });
    expect(await screen.findByText('Please wait for your number to be called.')).toBeInTheDocument();
    expect(screen.getByText('Nobody is waiting.')).toBeInTheDocument();
  });

  it('says the address is not valid for a wrong key or no key, and asks for the right one', async () => {
    show('right', { clinic: 'X', waiting: 0, calls: [] });
    // a different key
    api.routes['GET /waiting-display'] = () => json(404, errorBody('NOT_FOUND', 'Not found'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/This screen’s address is not valid/);
    expect(screen.getByText(/Settings, under Waiting room/)).toBeInTheDocument();
  });

  it('is not valid without a key, and asks the server nothing', async () => {
    show(null, {});
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/);
    expect(api.calls.some((c) => c.path === '/waiting-display')).toBe(false);
  });
});

describe('Settings: the waiting room screen', () => {
  const settings = (screenBody: unknown) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /waiting-room/screen'] = () => json(200, screenBody);
  };

  it('makes the address when there is none yet', async () => {
    settings({ key: null, path: null });
    api.routes['POST /waiting-room/screen/reset'] = () => json(200, { key: 'k1', path: '/waiting-display?key=k1' });
    renderApp(<App />, '/settings/waiting-room');
    expect(await screen.findByText('There is no address yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Make the address' }));
    await waitFor(() => expect(calls('POST', '/waiting-room/screen/reset')).toHaveLength(1));
    expect(await screen.findByText('Screen address made')).toBeInTheDocument();
  });

  it('shows the address to open on the screen, and makes a new one after asking', async () => {
    settings({ key: 'k1', path: '/waiting-display?key=k1' });
    api.routes['POST /waiting-room/screen/reset'] = () => json(200, { key: 'k2', path: '/waiting-display?key=k2' });
    renderApp(<App />, '/settings/waiting-room');
    expect(await screen.findByLabelText('Screen address')).toHaveValue(`${window.location.origin}/waiting-display?key=k1`);
    expect(screen.getByRole('link', { name: 'Open the screen' })).toHaveAttribute('href', '/waiting-display?key=k1');
    expect(screen.getByRole('link', { name: 'Open the screen' })).toHaveAttribute('target', '_blank');
    await userEvent.click(screen.getByRole('button', { name: 'Make a new address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make a new address?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(calls('POST', '/waiting-room/screen/reset')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: 'Make a new address' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Make a new address?' })).getByRole('button', { name: 'Make a new address' }));
    await waitFor(() => expect(calls('POST', '/waiting-room/screen/reset')).toHaveLength(1));
  });
});
