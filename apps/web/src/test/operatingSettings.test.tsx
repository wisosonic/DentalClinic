import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { formatClockTime } from '../lib/useTime';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const DEFAULTS = {
  appointments: { defaultDuration: 30, cancelMinHours: 24, staffReminderMinutes: 120, patientReminderHours: 24 },
  security: { maxFailedLogins: 5, lockoutMinutes: 15, passwordMinLength: 10, rememberDays: 30 },
  portal: { enabled: true, showPayments: true, documentsVisibleByDefault: false },
  waiting: { chime: true, unitLetters: false, finishedCallSeconds: 0 },
  uploads: { maxDocumentMb: 25, maxDocumentsPerPatient: 200 },
  display: { weekStart: 'monday', timeFormat: '24h' },
  retention: { trashDays: 0, auditDays: 0 },
} as const;
const CONFIG = {
  defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-07',
  weekStart: 'monday', timeFormat: '24h', passwordMinLength: 10, documents: { maxMb: 25, maxPerPatient: 200, visibleByDefault: false }, portal: { enabled: true, showPayments: true },
};
const calls = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);

const admin = () => {
  api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
  api.routes['GET /config'] = () => json(200, CONFIG);
  for (const [group, values] of Object.entries(DEFAULTS)) {
    api.routes[`GET /settings/${group}`] = () => json(200, values);
    api.routes[`PUT /settings/${group}`] = (c) => json(200, c.body);
  }
  api.routes['GET /waiting-room/screen'] = () => json(200, { key: null, path: null });
};

describe('the settings pages for how the clinic runs', () => {
  it('appointments: shows the values, and saves them as numbers', async () => {
    admin();
    renderApp(<App />, '/settings/appointments');
    const length = await screen.findByLabelText('Default length of an appointment');
    expect(length).toHaveValue(30);
    expect(screen.getByLabelText('Notice to cancel online')).toHaveValue(24);
    expect(screen.getByLabelText('Reminder for the doctor and the staff')).toHaveValue(120);
    expect(screen.getByLabelText('Reminder for the patient')).toHaveValue(24);
    fireEvent.change(length, { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Notice to cancel online'), { target: { value: '12' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/appointments')).toHaveLength(1));
    expect(calls('PUT', '/settings/appointments')[0]!.body).toEqual({ defaultDuration: 45, cancelMinHours: 12, staffReminderMinutes: 120, patientReminderHours: 24 });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('refuses a value the server would refuse, naming it, and sends nothing', async () => {
    admin();
    renderApp(<App />, '/settings/appointments');
    fireEvent.change(await screen.findByLabelText('Default length of an appointment'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Reminder for the patient'), { target: { value: '500' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use steps of 15 minutes')).toBeInTheDocument();
    expect(screen.getByText('At most 168')).toBeInTheDocument();
    expect(calls('PUT', '/settings/appointments')).toHaveLength(0);
  });

  it('security: the failed sign-ins, the lock, the shortest password and "keep me signed in"', async () => {
    admin();
    renderApp(<App />, '/settings/security');
    expect(await screen.findByLabelText('Failed sign-ins before an account locks')).toHaveValue(5);
    expect(screen.getByLabelText('How long an account stays locked')).toHaveValue(15);
    expect(screen.getByLabelText('Shortest password')).toHaveValue(10);
    fireEvent.change(screen.getByLabelText('Shortest password'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('"Keep me signed in" lasts'), { target: { value: '60' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/security')).toHaveLength(1));
    expect(calls('PUT', '/settings/security')[0]!.body).toEqual({ maxFailedLogins: 5, lockoutMinutes: 15, passwordMinLength: 12, rememberDays: 60 });
  });

  it('security: will not go below eight characters', async () => {
    admin();
    renderApp(<App />, '/settings/security');
    fireEvent.change(await screen.findByLabelText('Shortest password'), { target: { value: '6' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('At least 8')).toBeInTheDocument();
    expect(calls('PUT', '/settings/security')).toHaveLength(0);
  });

  it('patient portal: three switches', async () => {
    admin();
    renderApp(<App />, '/settings/portal');
    const on = await screen.findByRole('checkbox', { name: 'The patient portal is on' });
    expect(on).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Show patients their payments, receipts and balance' })).toBeChecked();
    const share = screen.getByRole('checkbox', { name: 'Share new documents with the patient unless told otherwise' });
    expect(share).not.toBeChecked();
    await userEvent.click(share);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show patients their payments, receipts and balance' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/portal')).toHaveLength(1));
    expect(calls('PUT', '/settings/portal')[0]!.body).toEqual({ enabled: true, showPayments: false, documentsVisibleByDefault: true });
  });

  it('uploads: the size and the number of documents', async () => {
    admin();
    renderApp(<App />, '/settings/uploads');
    expect(await screen.findByLabelText('Biggest document')).toHaveValue(25);
    fireEvent.change(screen.getByLabelText('Biggest document'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Most documents for one patient'), { target: { value: '300' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/uploads')).toHaveLength(1));
    expect(calls('PUT', '/settings/uploads')[0]!.body).toEqual({ maxDocumentMb: 50, maxDocumentsPerPatient: 300 });
  });

  it('date and time: the first day of the week and 12 or 24-hour times', async () => {
    admin();
    renderApp(<App />, '/settings/display');
    expect(await screen.findByLabelText('The week starts on')).toHaveTextContent('Monday');
    expect(screen.getByLabelText('Times are shown as')).toHaveTextContent('24-hour (14:30)');
    await userEvent.click(screen.getByLabelText('The week starts on'));
    await userEvent.click(await screen.findByRole('option', { name: 'Sunday' }));
    await userEvent.click(screen.getByLabelText('Times are shown as'));
    await userEvent.click(await screen.findByRole('option', { name: '12-hour (2:30 PM)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/display')).toHaveLength(1));
    expect(calls('PUT', '/settings/display')[0]!.body).toEqual({ weekStart: 'sunday', timeFormat: '12h' });
  });

  it('waiting room: the chime, the unit letters and how long a finished call stays, above the screen’s address', async () => {
    admin();
    renderApp(<App />, '/settings/waiting-room');
    const chime = await screen.findByRole('checkbox', { name: 'Offer a chime on the screen' });
    expect(chime).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Write the dental unit’s letter before the number' })).not.toBeChecked();
    expect(screen.getByLabelText('A finished call stays on the screen for')).toHaveValue(0);
    expect(await screen.findByText('There is no address yet.')).toBeInTheDocument(); // the address block is still there
    await userEvent.click(screen.getByRole('checkbox', { name: 'Write the dental unit’s letter before the number' }));
    fireEvent.change(screen.getByLabelText('A finished call stays on the screen for'), { target: { value: '20' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/waiting')).toHaveLength(1));
    expect(calls('PUT', '/settings/waiting')[0]!.body).toEqual({ chime: true, unitLetters: true, finishedCallSeconds: 20 });
  });

  it('trash and activity log: how long deleted items and log entries are kept, 0 meaning never', async () => {
    admin();
    renderApp(<App />, '/settings/trash-and-log');
    const region = await screen.findByRole('region', { name: 'Trash and activity log' });
    expect(await within(region).findByLabelText('Erase items from the Trash after')).toHaveValue(0);
    fireEvent.change(within(region).getByLabelText('Erase items from the Trash after'), { target: { value: '90' } });
    fireEvent.change(within(region).getByLabelText('Remove activity-log entries after'), { target: { value: '365' } });
    await userEvent.click(within(region).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PUT', '/settings/retention')).toHaveLength(1));
    expect(calls('PUT', '/settings/retention')[0]!.body).toEqual({ trashDays: 90, auditDays: 365 });
    fireEvent.change(within(region).getByLabelText('Erase items from the Trash after'), { target: { value: '3' } });
    await userEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByText(/at least 7 days/i)).toBeInTheDocument();
    expect(calls('PUT', '/settings/retention')).toHaveLength(1);
    const nav = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    expect(nav.getByRole('link', { name: 'Trash and activity log' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Trash and activity log');
  });

  it('shows the server’s refusal in the page', async () => {
    admin();
    api.routes['PUT /settings/security'] = () => json(400, errorBody('VALIDATION_ERROR', 'Invalid input'));
    renderApp(<App />, '/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('what the settings change on the screens', () => {
  it('writes times in 12-hour form when the clinic chose it, and leaves 24-hour times alone', () => {
    expect(formatClockTime('14:30', '24h')).toBe('14:30');
    expect(formatClockTime('14:30', '12h')).toBe('2:30 PM');
    expect(formatClockTime('09:05', '12h')).toBe('9:05 AM');
    expect(formatClockTime('00:00', '12h')).toBe('12:00 AM');
    expect(formatClockTime('12:00', '12h')).toBe('12:00 PM');
    expect(formatClockTime('23:59', '12h')).toBe('11:59 PM');
    expect(formatClockTime('24:00', '12h')).toBe('12:00 AM');
    expect(formatClockTime('24:00', '24h')).toBe('24:00');
    expect(formatClockTime('not a time', '12h')).toBe('not a time');
  });

  it('shows the waiting room’s times the clinic’s way', async () => {
    admin();
    api.routes['GET /config'] = () => json(200, { ...CONFIG, timeFormat: '12h' });
    api.routes['GET /waiting-room'] = () => json(200, { date: '2026-10-07', data: [{
      id: 1, number: 1, label: '1', date: '2026-10-07', status: 'waiting', patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, doctor: { id: 1, fname: 'Aya', lname: 'Ghali' },
      unit: { id: 3, name: 'Unit A' }, appointment: { id: 5, time: '14:30', procedures: [] }, arrivedAt: '2026-10-07 07:00:00', calledAt: null, callCount: 0, finishedAt: null,
    }] });
    renderApp(<App />, '/waiting-room');
    expect(await screen.findByText(/Appointment at/)).toHaveTextContent('2:30 PM');
  });

  it('makes the change-password page ask for the clinic’s shortest password', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff', { mustChangePassword: true }) });
    api.routes['GET /config'] = () => json(200, { ...CONFIG, passwordMinLength: 14 });
    renderApp(<App />, '/change-password');
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'whatever-it-was' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Only-13-Chars' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Only-13-Chars' } });
    await userEvent.click(screen.getByRole('button', { name: /Change password|Save/ }));
    expect(await screen.findByText('Password must be at least 14 characters')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/auth/change-password')).toBe(false);
  });

  it('makes the reset page use the same length before anyone is signed in', async () => {
    api.routes['GET /public-settings'] = () => json(200, { language: 'en', mode: 'light', textSize: 'medium', passwordMinLength: 12 });
    renderApp(<App />, '/reset-password/' + 'x'.repeat(24));
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'Eleven-Char' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Eleven-Char' } });
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('Password must be at least 12 characters')).toBeInTheDocument();
  });
});

describe('the waiting-room screen follows the clinic’s settings', () => {
  const show = (body: unknown) => {
    api.routes['GET /waiting-display'] = () => json(200, body);
    renderApp(<App />, '/waiting-display?key=abc');
  };
  const fakeAudio = () => vi.stubGlobal('AudioContext', class { currentTime = 0; destination = {}; createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; } resume() { return Promise.resolve(); } });
  afterEach(() => vi.unstubAllGlobals());

  it('writes the number the clinic’s way (A12), large and in the list', async () => {
    show({ clinic: 'Hamra Clinic', waiting: 0, chime: true, calls: [{ number: 12, label: 'A12', unit: 'Unit A', calledAt: '2026-10-07 07:10:00', callCount: 1 }, { number: 9, label: 'B9', unit: 'Unit B', calledAt: '2026-10-07 07:05:00', callCount: 1 }] });
    expect(await screen.findByLabelText('Number A12')).toHaveTextContent('A12');
    expect(within(screen.getByRole('list')).getByText('B9')).toBeInTheDocument();
  });

  it('offers the sound button only when the clinic wants the chime', async () => {
    fakeAudio();
    show({ clinic: 'Hamra Clinic', waiting: 0, chime: true, calls: [] });
    expect(await screen.findByRole('button', { name: 'Turn the sound on' })).toBeInTheDocument();
  });

  it('has no sound button when the chime is off', async () => {
    fakeAudio();
    show({ clinic: 'Hamra Clinic', waiting: 0, chime: false, calls: [] });
    await screen.findByText('Please wait for your number to be called.');
    expect(screen.queryByRole('button', { name: /sound/i })).not.toBeInTheDocument();
  });
});

describe('the patient portal follows the clinic’s settings', () => {
  const patient = (config: object, overview: object | null = null) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('patient', { username: 'p' }) });
    api.routes['GET /config'] = () => json(200, { ...CONFIG, ...config });
    api.routes['GET /portal/overview'] = () => (overview ? json(200, overview) : json(403, errorBody('PORTAL_OFF', 'The patient portal is switched off. Please contact the clinic.')));
  };
  const overview = (extra: object = {}) => ({
    patient: { id: 7, fname: 'Hicham', lname: 'Cheaib', patientIdentifier: '100007', username: 'p', doctor: null }, next: null, upcomingCount: 0,
    balance: { price: 450, paid: 250, remaining: 200, currency: '$' }, showPayments: true, documentsCount: 0, cancelMinHours: 24, ...extra,
  });
  const openMenu = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    return within(screen.getByRole('navigation', { name: 'Main' }));
  };

  it('hides the money when the clinic does not show it: no balance, no payments tile, no payments in the menu', async () => {
    patient({ portal: { enabled: true, showPayments: false } }, overview({ balance: null, showPayments: false }));
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: 'Your next appointment' });
    expect(screen.queryByRole('region', { name: 'Your treatment balance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /My payments/ })).not.toBeInTheDocument();
    const menu = await openMenu();
    expect(menu.getByRole('link', { name: 'My treatment' })).toBeInTheDocument();
    expect(menu.queryByRole('link', { name: 'My payments' })).not.toBeInTheDocument();
  });

  it('shows the treatment without what is paid when the clinic hides money', async () => {
    patient({ portal: { enabled: true, showPayments: false } }, overview({ balance: null, showPayments: false }));
    api.routes['GET /portal/offers'] = () => json(200, { data: [{
      id: 9, title: 'Rehabilitation', description: null, price: 350, currency: '$', workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 }, doctor: null,
      items: [{ id: 1, sequence: 0, description: 'Crown', tooth: null, price: 300, status: 'pending', visit: null }], createdAt: '2026-10-01 09:00:00',
    }] });
    renderApp(<App />, '/my/treatment');
    const card = within(await screen.findByRole('article', { name: 'Rehabilitation' }));
    expect(card.getByText(/350\.00/)).toBeInTheDocument();
    expect(card.queryByText('Paid')).not.toBeInTheDocument();
    expect(card.queryByText('Still to pay')).not.toBeInTheDocument();
    expect(card.queryByText('Partly paid')).not.toBeInTheDocument();
  });

  it('says the portal is off, and takes “My care” out of the menu', async () => {
    patient({ portal: { enabled: false, showPayments: true } });
    renderApp(<App />, '/');
    expect(await screen.findByText('The patient portal is switched off. Please contact the clinic.')).toBeInTheDocument();
    const menu = await openMenu();
    expect(menu.queryByRole('link', { name: 'My appointments' })).not.toBeInTheDocument();
    expect(menu.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('uploads follow the clinic’s settings', () => {
  const open = async (documents: object) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff', { permissions: ['documents:read', 'documents:create', 'patients:read'] }) });
    api.routes['GET /config'] = () => json(200, { ...CONFIG, documents });
    api.routes['GET /patients/7'] = () => json(200, { patient: { id: 7, patientIdentifier: '100007', fname: 'Hicham', lname: 'Cheaib', phone: '1', dateOfBirth: null, gender: null, email: null, address: null, lastVisit: null, doctorId: 1, username: null, hasAccount: false, createdAt: null } });
    api.routes['GET /patients/7/documents'] = () => json(200, { data: [], meta: { page: 1, pageSize: 200, total: 0 } });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    renderApp(<App />, '/patients/7/documents');
    await userEvent.click(await screen.findByRole('button', { name: 'Add documents' }));
    return screen.findByRole('dialog', { name: 'Add documents' });
  };
  const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

  it('refuses a file bigger than the clinic’s limit, naming the limit', async () => {
    const dialog = await open({ maxMb: 1, maxPerPatient: 200, visibleByDefault: false });
    expect(within(dialog).getByText(/up to 1 MB each/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Document files'), { target: { files: [file('big.png', 'image/png', 2 * 1024 * 1024), file('ok.png', 'image/png', 500)] } });
    expect(await within(dialog).findByText('big.png: the file must be smaller than 1 MB')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title of file 1')).toHaveValue('ok'); // the small one is accepted
  });

  it('starts the “Visible to the patient” box as the clinic chose', async () => {
    const dialog = await open({ maxMb: 25, maxPerPatient: 200, visibleByDefault: true });
    fireEvent.change(within(dialog).getByLabelText('Document files'), { target: { files: [file('a.png', 'image/png', 50)] } });
    expect(await within(dialog).findByRole('checkbox', { name: 'Visible to the patient, file 1' })).toBeChecked();
  });
});
