import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ACTION_LABEL } from '../features/audit/AuditPage';
import ar from '../i18n/ar';
import { PATIENT, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const ENTRIES = [
  { id: 3, userId: 2, userName: 'Sami Khoury', action: 'patient.view', entity: 'patient', entityId: '7', entityLabel: 'Hicham Cheaib', diff: null, ip: '1.1.1.1', createdAt: '2026-10-05 07:30:00' },
  { id: 2, userId: 1, userName: 'Aya Ghali', action: 'patient.update', entity: 'patient', entityId: '7', entityLabel: 'Hicham Cheaib', diff: { fields: ['phone'] }, ip: null, createdAt: '2026-10-05 07:00:00' },
  { id: 1, userId: null, userName: null, action: 'something.new', entity: null, entityId: null, entityLabel: null, diff: null, ip: null, createdAt: '2026-10-04 12:00:00' },
];

const setup = (role = 'admin') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, { id: 1 }) });
  api.routes['GET /config'] = () => json(200, { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
  api.routes['GET /users'] = () => json(200, { data: [user('admin', { id: 1, name: 'Aya Ghali' }), user('doctor', { id: 2, name: 'Sami Khoury' })], meta: { page: 1, pageSize: 100, total: 2 } });
  api.routes['GET /audit-log'] = () => json(200, { data: ENTRIES, meta: { page: 1, pageSize: 50, total: ENTRIES.length } });
};
const lastAuditCall = () => api.calls.filter((c) => c.path === '/audit-log').at(-1)!;

describe('activity log page', () => {
  it('is for admins only', async () => {
    setup('doctor');
    renderApp(<App />, '/settings/audit');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/audit-log')).toBe(false);
  });

  it('shows who did what to which patient, in plain words, with times in the clinic’s timezone', async () => {
    setup();
    renderApp(<App />, '/settings/audit');
    const row = (await screen.findByText('Sami Khoury')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Opened the patient')).toBeInTheDocument();
    expect(within(row).getByText('Viewed')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
    expect(row.textContent).toMatch(/10:30/); // 07:30 UTC is 10:30 in Beirut
    const change = (await screen.findByText('Changed a patient')).closest('tr') as HTMLElement;
    expect(within(change).queryByText('Viewed')).not.toBeInTheDocument();
    expect(screen.getByText('something.new')).toBeInTheDocument(); // an action nobody has described yet shows as it is
  });

  it('asks the server to filter and sort', async () => {
    setup();
    renderApp(<App />, '/settings/audit');
    await screen.findByText('Sami Khoury');
    await userEvent.click(screen.getByLabelText('Show'));
    await userEvent.click(await screen.findByRole('option', { name: 'Who opened records' }));
    await waitFor(() => expect(lastAuditCall().query.get('kind')).toBe('views'));
    await userEvent.click(screen.getByRole('button', { name: 'Person' }));
    await waitFor(() => expect(lastAuditCall().query.get('sort')).toBe('user'));
    expect(lastAuditCall().query.get('order')).toBe('asc');
  });

  it('can be limited to one patient from a link, and the limit can be removed', async () => {
    setup();
    renderApp(<App />, '/settings/audit?entity=patient&entityId=7');
    const chip = await screen.findByText('Only this record: Hicham Cheaib');
    expect(lastAuditCall().query.get('entityId')).toBe('7');
    expect(lastAuditCall().query.get('entity')).toBe('patient');
    await userEvent.click(chip.parentElement!.querySelector('svg')!);
    await waitFor(() => expect(lastAuditCall().query.get('entityId')).toBeNull());
  });
});

describe('who viewed this record button', () => {
  const open = async (role: string) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients/7');
    await screen.findByRole('heading', { name: 'Hicham Cheaib' });
  };

  it('is shown to admins and links to that patient’s log', async () => {
    await open('admin');
    const link = screen.getByRole('link', { name: 'Who viewed this record' });
    expect(link).toHaveAttribute('href', '/settings/audit?entity=patient&entityId=7');
    expect(link).not.toHaveTextContent('Who viewed this record'); // the icon only; the words are its label
  });

  it('is not shown to anyone else', async () => {
    await open('doctor');
    expect(screen.queryByRole('link', { name: 'Who viewed this record' })).not.toBeInTheDocument();
  });
});

describe('the patient page’s Payments button', () => {
  const open = async (role: string) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients/7');
    await screen.findByRole('heading', { name: 'Hicham Cheaib' });
  };

  it('opens all of the patient’s payments for admins and doctors', async () => {
    for (const role of ['admin', 'doctor']) {
      await open(role);
      expect(screen.getByRole('link', { name: 'Payments' })).toHaveAttribute('href', '/payments?patientId=7');
      cleanup();
    }
  });

  it('is not shown to staff, who cannot browse payments', async () => {
    await open('staff');
    expect(screen.queryByRole('link', { name: 'Payments' })).not.toBeInTheDocument();
  });
});

describe('activity log wording', () => {
  it('has Arabic text for every action it describes', () => {
    expect(Object.values(ACTION_LABEL).filter((label) => !ar[label])).toEqual([]);
  });
});

describe('clearing the log', () => {
  it('asks first, then clears and refreshes', async () => {
    setup();
    api.routes['DELETE /audit-log'] = () => json(200, { removed: 3 });
    renderApp(<App />, '/settings/audit');
    await screen.findByText('Sami Khoury');
    await userEvent.click(screen.getByRole('button', { name: 'Clear the log' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 entries/)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false); // nothing happens until confirmed
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear the log' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/audit-log')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('can be cancelled', async () => {
    setup();
    renderApp(<App />, '/settings/audit');
    await screen.findByText('Sami Khoury');
    await userEvent.click(screen.getByRole('button', { name: 'Clear the log' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it' }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('deleting one log entry', () => {
  it('has an X on every row that deletes that entry', async () => {
    setup();
    api.routes['DELETE /audit-log/2'] = () => new Response(null, { status: 204 });
    renderApp(<App />, '/settings/audit');
    const row = (await screen.findByText('Changed a patient')).closest('tr') as HTMLElement;
    expect(screen.getAllByRole('button', { name: 'Delete this entry' })).toHaveLength(ENTRIES.length);
    await userEvent.click(within(row).getByRole('button', { name: 'Delete this entry' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/audit-log/2')).toBe(true));
  });
});
