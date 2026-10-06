import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { appointment, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const DATA = {
  appointments: [
    { id: 5, date: '2026-09-20', time: '10:00', status: 'completed', patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali' }, unit: { id: 3, name: 'Unit A' }, hasReport: true },
    { id: 6, date: '2026-10-02', time: '09:30', status: 'confirmed', patient: { id: 8, fname: 'Nour', lname: 'Haddad' }, doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali' }, unit: null, hasReport: false },
  ],
  units: [{ id: 3, name: 'Unit A', ownerName: 'Aya Al Ghali', appointments: 1 }, { id: 4, name: 'Unit B', ownerName: 'Sara Doughan', appointments: 0 }],
};

const signIn = (role = 'admin', data: object = DATA) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /clinics/deleted-data'] = () => json(200, data);
};

describe('deleted clinics’ data page', () => {
  it('is for admins only', async () => {
    signIn('staff');
    renderApp(<App />, '/settings/deleted-clinics');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/clinics/deleted-data')).toBe(false);
  });

  it('lists the appointments and dental units that stay, and explains why', async () => {
    signIn();
    renderApp(<App />, '/settings/deleted-clinics');
    const appts = within(await screen.findByRole('table', { name: 'Appointments' }));
    const row = appts.getByText('Hicham Cheaib').closest('tr') as HTMLElement;
    expect(within(row).getByText('Unit A')).toBeInTheDocument();
    expect(within(row).getByText('Written')).toBeInTheDocument();
    expect(appts.getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
    const units = within(screen.getByRole('table', { name: 'Dental units' }));
    expect(units.getByText('Unit B')).toBeInTheDocument();
    expect(screen.getByText(/commission is worked out from it/)).toBeInTheDocument();
  });

  it('sorts both tables by any column', async () => {
    signIn();
    renderApp(<App />, '/settings/deleted-clinics');
    const appts = within(await screen.findByRole('table', { name: 'Appointments' }));
    const patients = () => appts.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(patients()).toEqual(['Nour Haddad', 'Hicham Cheaib']); // newest first
    await userEvent.click(appts.getByRole('button', { name: 'Patient' }));
    await waitFor(() => expect(patients()).toEqual(['Hicham Cheaib', 'Nour Haddad']));
    const units = within(screen.getByRole('table', { name: 'Dental units' }));
    const names = () => units.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    await userEvent.click(units.getByRole('button', { name: 'Appointments' }));
    await waitFor(() => expect(names()).toEqual(['Unit B', 'Unit A']));
  });

  it('deletes an appointment after asking, which sends it to the Trash', async () => {
    signIn();
    api.routes['DELETE /appointments/5'] = () => empty();
    renderApp(<App />, '/settings/deleted-clinics');
    await userEvent.click(await screen.findByRole('button', { name: /Delete the appointment of Hicham Cheaib/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this appointment?' });
    expect(within(dialog).getByText(/goes to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete appointment' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/appointments/5')).toBe(true));
    expect(await screen.findByText('Appointment moved to the Trash')).toBeInTheDocument();
  });

  it('deletes a dental unit with nothing on it, and will not offer to delete one that has appointments', async () => {
    signIn();
    api.routes['DELETE /units/4'] = () => empty();
    renderApp(<App />, '/settings/deleted-clinics');
    expect(await screen.findByRole('button', { name: 'Delete Unit A' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Unit B' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete dental unit' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/units/4')).toBe(true));
  });

  it('shows the server’s refusal', async () => {
    signIn();
    api.routes['DELETE /appointments/5'] = () => json(409, errorBody('NOT_FOUND', 'Appointment not found'));
    renderApp(<App />, '/settings/deleted-clinics');
    await userEvent.click(await screen.findByRole('button', { name: /Delete the appointment of Hicham Cheaib/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete appointment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Appointment not found');
  });

  it('says so when nothing was left behind', async () => {
    signIn('admin', { appointments: [], units: [] });
    renderApp(<App />, '/settings/deleted-clinics');
    expect(await screen.findByText('No clinic has been deleted, or nothing was left behind.')).toBeInTheDocument();
  });
});

describe('an appointment of a deleted clinic', () => {
  const open = async (clinicId: number | null) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /appointments'] = () => json(200, { data: [appointment({ date: '2026-10-05', status: 'confirmed', clinicId, clinic: clinicId ? { id: clinicId, name: 'Aya Ghali Clinic' } : null })], meta: { page: 1, pageSize: 50, total: 1 } });
    api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment({ date: '2026-10-05', status: 'confirmed', clinicId, clinic: clinicId ? { id: clinicId, name: 'Aya Ghali Clinic' } : null }) });
    api.routes['GET /appointments/5/report'] = () => json(200, { report: null, canEdit: true });
    renderApp(<App />, '/'); // today's appointments are on the dashboard
  };

  it('is shown as read-only: no confirm, edit, procedures, cancel or report buttons, but it can still be deleted', async () => {
    await open(null);
    await userEvent.click(await screen.findByText('Hicham Cheaib'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/belongs to a deleted clinic/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Deleted clinic/)).toBeInTheDocument();
    for (const name of ['Edit / reschedule', 'Cancel appointment', 'Procedures & teeth', 'Procedures', 'Write report', 'Complete visit', 'Confirm']) {
      expect(within(dialog).queryByRole('button', { name }), name).not.toBeInTheDocument();
    }
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps every button for an appointment whose clinic exists', async () => {
    await open(1);
    await userEvent.click(await screen.findByText('Hicham Cheaib'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: 'Edit / reschedule' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/belongs to a deleted clinic/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Aya Ghali Clinic/)).toBeInTheDocument();
  });
});

describe('deleting a clinic', () => {
  it('says what stays, instead of refusing', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /clinics'] = () => json(200, { data: [{ id: 1, name: 'Aya Ghali Clinic', phone: null, address: 'Karakol', type: null, latitude: null, longitude: null }] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [] });
    api.routes['GET /units'] = () => json(200, { data: [] });
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    api.routes['DELETE /clinics/1'] = () => empty();
    renderApp(<App />, '/settings/clinics');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Aya Ghali Clinic?' });
    expect(within(dialog).getByText(/Only the clinic is deleted. Its appointments and dental units stay/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Delete clinic|Delete/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/clinics/1')).toBe(true));
  });
});
