import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import ar from '../i18n/ar';
import { IMPACT_LINES } from '../features/trash/TrashPage';
import { PATIENT, appointment, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const ITEMS = [
  { kind: 'patient', id: 7, label: 'Hicham Cheaib', detail: '#100007', confirmText: 'Hicham Cheaib', deletedAt: '2026-10-05 07:30:00', deletedBy: 'Sam Staff', blockedBy: null },
  { kind: 'appointment', id: 5, label: 'Nour Haddad', detail: '2026-10-06 10:00', confirmText: 'Nour Haddad', deletedAt: '2026-10-04 08:00:00', deletedBy: 'Dr Doctor', blockedBy: 'patient' },
  { kind: 'report', id: 3, label: 'Nour Haddad', detail: '2026-10-06 10:00', confirmText: 'Nour Haddad', deletedAt: '2026-10-03 08:00:00', deletedBy: null, blockedBy: null },
];
const COUNTS = { patients: 1, appointments: 2, reports: 1, reportToothNotes: 3, prescriptionLines: 1, offers: 1, payments: 2, labOrders: 0, logins: 1 };
const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const setup = (role = 'admin') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, { id: 1 }) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /trash'] = () => json(200, { data: ITEMS, meta: { page: 1, pageSize: 25, total: ITEMS.length } });
  api.routes['GET /trash/patient/7/impact'] = () => json(200, { counts: COUNTS });
};
const rowOf = async (text: string) => (await screen.findAllByText(text))[0]!.closest('tr') as HTMLElement;

describe('Trash page', () => {
  it('is for admins only', async () => {
    setup('staff');
    renderApp(<App />, '/settings/trash');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/trash')).toBe(false);
  });

  it('lists what was deleted, by whom, and what type', async () => {
    setup();
    renderApp(<App />, '/settings/trash');
    const patient = await rowOf('Hicham Cheaib');
    expect(within(patient).getByText('Patient')).toBeInTheDocument();
    expect(within(patient).getByText('Sam Staff')).toBeInTheDocument();
    expect(within(await rowOf('Dr Doctor')).getByText('Appointment')).toBeInTheDocument();
  });

  it('restores an item, and disables it while its patient is still in the Trash', async () => {
    setup();
    api.routes['POST /trash/patient/7/restore'] = () => new Response(null, { status: 204 });
    renderApp(<App />, '/settings/trash');
    const nour = await screen.findAllByRole('button', { name: 'Restore Nour Haddad' });
    expect(nour[0]).toBeDisabled(); // the appointment: its patient is in the Trash
    expect(nour[1]).toBeEnabled(); // the report: its appointment is not
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Hicham Cheaib' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/trash/patient/7/restore')).toBe(true));
  });

  it('shows what will be erased and needs the patient name typed before it erases', async () => {
    setup();
    api.routes['DELETE /trash/patient/7'] = () => new Response(null, { status: 204 });
    renderApp(<App />, '/settings/trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Erase Hicham Cheaib for good' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('2 appointments')).toBeInTheDocument();
    expect(within(dialog).getByText('3 tooth notes')).toBeInTheDocument();
    expect(within(dialog).getByText('1 sign-in account')).toBeInTheDocument();
    expect(within(dialog).queryByText(/lab orders?/)).not.toBeInTheDocument(); // zero is not listed

    const erase = within(dialog).getByRole('button', { name: 'Erase for good' });
    expect(erase).toBeDisabled();
    const field = within(dialog).getByLabelText('Patient’s name');
    await userEvent.type(field, 'Hicham Chea');
    expect(erase).toBeDisabled();
    await userEvent.type(field, 'ib');
    expect(erase).toBeEnabled();
    await userEvent.click(erase);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'DELETE' && c.path === '/trash/patient/7')?.body).toEqual({ confirm: 'Hicham Cheaib' }));
  });

  it('keeps the item and shows the reason when the server refuses', async () => {
    setup();
    api.routes['DELETE /trash/patient/7'] = () => json(400, { error: { code: 'CONFIRM_MISMATCH', message: 'The name you typed does not match' } });
    renderApp(<App />, '/settings/trash');
    await userEvent.click(await screen.findByRole('button', { name: 'Erase Hicham Cheaib for good' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('2 appointments');
    await userEvent.type(within(dialog).getByLabelText('Patient’s name'), 'hicham cheaib');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Erase for good' }));
    expect(await within(dialog).findByText('The name you typed does not match')).toBeInTheDocument();
  });

  it('asks the server to sort', async () => {
    setup();
    renderApp(<App />, '/settings/trash');
    await screen.findAllByText('Hicham Cheaib');
    await userEvent.click(screen.getByRole('button', { name: 'Item' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/trash').at(-1)!.query.get('sort')).toBe('label'));
  });

  it('says so when nothing was deleted', async () => {
    setup();
    api.routes['GET /trash'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    renderApp(<App />, '/settings/trash');
    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
  });
});

describe('deleting from the screens', () => {
  it('lets staff delete a patient (to the Trash) after a confirmation that says so', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff') });
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    api.routes['DELETE /patients/7'] = () => new Response(null, { status: 204 });
    api.routes['GET /patients'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    renderApp(<App />, '/patients/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/goes to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete patient' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/patients/7')).toBe(true));
  });

  it('lets a doctor delete an appointment after a confirmation', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('doctor', { doctor: { id: 1, kind: 'owner' } }) });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /appointments'] = () => json(200, { data: [appointment({ status: 'completed', patientVisible: true })], meta: { page: 1, pageSize: 50, total: 1 } });
    api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment({ status: 'completed', patientVisible: true }) });
    api.routes['GET /appointments/5/report'] = () => json(200, { report: null, canEdit: true });
    api.routes['DELETE /appointments/5'] = () => new Response(null, { status: 204 });
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    api.routes['GET /units'] = () => json(200, { data: [] });
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'List' }));
    await userEvent.click(await screen.findByText('Hicham Cheaib'));
    const detail = await screen.findByRole('dialog');
    await userEvent.click(await within(detail).findByRole('button', { name: 'Delete' }));
    const confirm = (await screen.findAllByRole('dialog')).at(-1)!;
    expect(within(confirm).getByText(/goes to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete appointment' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/appointments/5')).toBe(true));
  });
});

describe('trash wording', () => {
  it('has Arabic text for every line of the erase warning', () => {
    for (const [, one, many] of IMPACT_LINES) {
      expect(ar[one], one).toBeTruthy();
      expect(ar[many], many).toBeTruthy();
    }
  });
});
