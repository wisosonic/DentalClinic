import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { useAppointmentDialogs } from '../features/appointments/AppointmentDialogs';
import { appointment, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const SPECIALIST_ID = 9;
const signInAs = (doctor: { id: number; kind: 'owner' | 'external' } | null) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user('doctor', { doctor }) });
  api.routes['GET /config'] = () => json(200, { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
  api.routes['GET /doctors'] = () => json(200, { data: [] });
  api.routes['GET /units'] = () => json(200, { data: [] });
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
};

function Harness() {
  const { dialogs, openDetail } = useAppointmentDialogs();
  return (
    <>
      <button onClick={() => openDetail(5)}>open</button>
      {dialogs}
    </>
  );
}

async function openAppointment(extra: object) {
  api.routes['GET /appointments/5'] = () => json(200, { appointment: appointment({ status: 'pending', doctorId: SPECIALIST_ID, doctor: { id: SPECIALIST_ID, fname: 'Sami', lname: 'Khoury' }, ...extra }) });
  api.routes['GET /appointments/5/report'] = () => json(200, { report: null, canEdit: true });
  renderApp(<Harness />);
  await userEvent.click(screen.getByText('open'));
  return screen.findByRole('dialog');
}

describe('external specialist', () => {
  describe('an appointment of his own patient', () => {
    it('shows the patient and lets him manage the appointment', async () => {
      signInAs({ id: SPECIALIST_ID, kind: 'external' });
      const dialog = await openAppointment({ patientVisible: true });
      expect(await within(dialog).findByRole('link', { name: 'Hicham Cheaib' })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Edit / reschedule' })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
      expect(await within(dialog).findByRole('button', { name: 'Write report' })).toBeInTheDocument();
    });
  });

  describe("an appointment of the owner doctor's patient that he treats", () => {
    it('lets him see the visit and write the report, nothing more', async () => {
      signInAs({ id: SPECIALIST_ID, kind: 'external' });
      const dialog = await openAppointment({ patientVisible: false, patient: { id: 7, fname: 'Hicham', lname: 'Cheaib', phone: null } });
      expect(await within(dialog).findByText(/another doctor's patient/i)).toBeInTheDocument();
      expect(within(dialog).queryByRole('link', { name: 'Hicham Cheaib' })).not.toBeInTheDocument();
      expect(within(dialog).getByText('Hicham Cheaib')).toBeInTheDocument();
      for (const name of ['Confirm', 'Edit / reschedule', 'Cancel appointment', 'Procedures', 'Procedures & teeth']) {
        expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
      }
      expect(await within(dialog).findByRole('button', { name: 'Write report' })).toBeInTheDocument();
    });
  });

  it("doesn't offer the doctors and clinics page", async () => {
    signInAs({ id: SPECIALIST_ID, kind: 'external' });
    renderApp(<App />);
    await screen.findByRole('heading', { name: /Welcome/ });
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
    const labels = within(nav).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(labels).toEqual(['Dashboard', 'Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'By doctor', 'Payments', 'Commission', 'Medications']);
  });

  it('is sent back to the dashboard from the doctors and clinics page', async () => {
    signInAs({ id: SPECIALIST_ID, kind: 'external' });
    renderApp(<App />, '/settings/doctors');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add doctor' })).not.toBeInTheDocument();
  });
});

describe('owner doctor', () => {
  it('still sees the doctors and clinics page', async () => {
    signInAs({ id: 1, kind: 'owner' });
    renderApp(<App />, '/settings/doctors');
    expect(await screen.findByRole('button', { name: 'Add doctor' })).toBeInTheDocument();
  });
});

describe('doctor login that is not linked to a doctor profile', () => {
  it('is told why there is nothing to see', async () => {
    signInAs(null);
    renderApp(<App />);
    expect(await screen.findByText(/not linked to a doctor profile/i)).toBeInTheDocument();
  });
});

describe('clinics page', () => {
  it('is for admins only: an owner doctor is sent to the dashboard', async () => {
    signInAs({ id: 1, kind: 'owner' });
    renderApp(<App />, '/settings/clinics');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add clinic' })).not.toBeInTheDocument();
  });
});

describe('breadcrumbs', () => {
  it('shows the way back on a section page and is hidden on the dashboard', async () => {
    signInAs({ id: 1, kind: 'owner' });
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: /Welcome/ });
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });

  it('links Dashboard > Patients > the patient on a patient page', async () => {
    signInAs({ id: 1, kind: 'owner' });
    api.routes['GET /patients/7'] = () => json(200, { patient: { id: 7, patientIdentifier: '100007', fname: 'Hicham', lname: 'Cheaib', phone: '1', gender: null, doctorId: 1, hasAccount: false } });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients/7');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(within(trail).getByRole('link', { name: 'Patients' })).toHaveAttribute('href', '/patients');
    expect(await within(trail).findByText('Hicham Cheaib')).toHaveAttribute('aria-current', 'page');
  });

  it('names the current section without linking to itself', async () => {
    signInAs({ id: 1, kind: 'owner' });
    renderApp(<App />, '/settings/doctors');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByText('Doctors')).toHaveAttribute('aria-current', 'page');
    expect(within(trail).queryByRole('link', { name: 'Doctors' })).not.toBeInTheDocument();
  });
});
