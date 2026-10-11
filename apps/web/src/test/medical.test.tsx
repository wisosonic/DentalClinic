import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-10' };
const profile = (extra: object = {}) => ({ bloodType: 'O-', pregnancy: null, smoking: 'former', notes: 'Anxious about needles', reviewedAt: '2026-09-01 10:00:00', reviewedBy: { id: 1, name: 'Dr Aya' }, updatedAt: '2026-09-01 10:00:00', updatedBy: { id: 1, name: 'Dr Aya' }, ...extra });
const item = (extra: object = {}) => ({ id: 1, kind: 'allergy', name: 'Penicillin', severity: 'severe', note: 'Rash and swelling', since: '2019', active: true, updatedBy: { id: 1, name: 'Dr Aya' }, updatedAt: '2026-09-01 10:00:00', ...extra });
const ITEMS = [
  item(),
  item({ id: 2, name: 'Latex', severity: 'mild', note: null, since: null }),
  item({ id: 3, kind: 'condition', name: 'Diabetes', severity: null, note: null, since: '2015-03' }),
  item({ id: 4, kind: 'condition', name: 'Asthma', severity: null, active: false }),
  item({ id: 5, kind: 'medication', name: 'Warfarin', severity: null }),
  item({ id: 6, kind: 'surgery', name: 'Heart surgery', severity: null, since: '2010' }),
];
const calls = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);

const setup = (role = 'staff', history: { profile?: object; items?: unknown[] } = {}) => {
  let current = { profile: profile(), items: ITEMS, ...history };
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
  api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [] });
  api.routes['GET /patients/7/medical'] = () => json(200, current);
  return { set: (h: { profile?: object; items?: unknown[] }) => { current = { ...current, ...h }; } };
};
const openPage = async (role = 'staff', history = {}) => {
  const state = setup(role, history);
  renderApp(<App />, '/patients/7/medical');
  await screen.findByRole('heading', { name: 'Medical history' });
  return state;
};
const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('the medical history page', () => {
  it('shows the profile, and when the history was last gone through with the patient', async () => {
    await openPage();
    const p = await section('Medical profile');
    expect(await p.findByText('O-')).toBeInTheDocument();
    expect(p.getByText('Former smoker')).toBeInTheDocument();
    expect(p.getByText('Anxious about needles')).toBeInTheDocument();
    expect(p.getByText(/Gone through with the patient on .* by Dr Aya\./)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Medical history');
    expect(screen.getByRole('link', { name: 'Back to the patient' })).toHaveAttribute('href', '/patients/7');
  });

  it('says when it has not been confirmed, and records that it was', async () => {
    const state = await openPage('staff', { profile: profile({ reviewedAt: null, reviewedBy: null }) });
    api.routes['POST /patients/7/medical/review'] = () => { state.set({ profile: profile({ reviewedAt: '2026-10-10 09:00:00', reviewedBy: { id: 2, name: 'Sam Staff' } }) }); return json(200, { profile: profile() }); };
    const p = await section('Medical profile');
    expect(await p.findByText('Not yet confirmed with the patient.')).toBeInTheDocument();
    await userEvent.click(p.getByRole('button', { name: 'I went through it with the patient' }));
    await waitFor(() => expect(calls('POST', '/patients/7/medical/review')).toHaveLength(1));
    expect(await screen.findByText('Marked as gone through with the patient')).toBeInTheDocument();
    expect(await p.findByText(/by Sam Staff\./)).toBeInTheDocument();
  });

  it('lists allergies, conditions, medications and surgeries, each in its own table, with the past ones marked', async () => {
    await openPage();
    const allergies = await section('Allergies');
    const rows = within(await allergies.findByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Penicillin', 'Latex']); // the severe one first
    expect(within(rows[0]!).getByText('severe')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Rash and swelling')).toBeInTheDocument();
    const conditions = await section('Medical conditions');
    expect(conditions.getByText('Diabetes')).toBeInTheDocument();
    expect(within(conditions.getByText('Asthma').closest('tr') as HTMLElement).getByText('Resolved')).toBeInTheDocument();
    expect((await section('Current medications')).getByText('Warfarin')).toBeInTheDocument();
    expect((await section('Past surgeries')).getByText('Heart surgery')).toBeInTheDocument();
  });

  it('sorts a table by any column', async () => {
    await openPage();
    const allergies = await section('Allergies');
    const names = () => within(allergies.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(names()).toEqual(['Penicillin', 'Latex']);
    await userEvent.click(allergies.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Latex', 'Penicillin']);
  });

  it('says so when a list is empty', async () => {
    await openPage('staff', { items: [] });
    expect((await (await section('Allergies')).findByText('Nothing recorded.'))).toBeInTheDocument();
  });
});

describe('adding and changing', () => {
  it('adds an allergy with its severity, since and note', async () => {
    await openPage();
    api.routes['POST /patients/7/medical/items'] = () => json(201, { item: item({ id: 9 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add an allergy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an allergy' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Name/ }), 'Latex');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Severity' }));
    await userEvent.click(screen.getByRole('option', { name: 'moderate' }));
    await userEvent.type(within(dialog).getByLabelText('Since'), '2021-05');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Itchy hands');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls('POST', '/patients/7/medical/items')).toHaveLength(1));
    expect(calls('POST', '/patients/7/medical/items')[0]!.body).toEqual({ kind: 'allergy', name: 'Latex', severity: 'moderate', since: '2021-05', note: 'Itchy hands', active: true });
    expect(await screen.findByText('Added to the medical history')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('suggests common names, and does not offer a severity for a condition', async () => {
    await openPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a condition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a condition' });
    expect(within(dialog).queryByRole('combobox', { name: 'Severity' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Name/ }));
    expect(await screen.findByRole('option', { name: 'Hypertension' })).toBeInTheDocument();
  });

  it('asks for a name and a sensible "since" before it sends anything', async () => {
    await openPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a condition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a condition' });
    await userEvent.type(within(dialog).getByLabelText('Since'), 'last year');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('Write what it is')).toBeInTheDocument();
    expect(within(dialog).getByText(/Use a year \(2019\)/)).toBeInTheDocument();
    expect(calls('POST', '/patients/7/medical/items')).toHaveLength(0);
  });

  it('shows the server’s refusal in the dialog and keeps it open', async () => {
    await openPage();
    api.routes['POST /patients/7/medical/items'] = () => json(400, errorBody('INVALID_SINCE', 'That date is in the future'));
    await userEvent.click(await screen.findByRole('button', { name: 'Add a condition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a condition' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Name/ }), 'Diabetes');
    await userEvent.type(within(dialog).getByLabelText('Since'), '2999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('That date is in the future')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a condition' })).toBeInTheDocument();
  });

  it('changes an entry and can mark it as resolved', async () => {
    await openPage();
    api.routes['PATCH /patients/7/medical/items/3'] = () => json(200, { item: item({ id: 3, kind: 'condition', name: 'Diabetes', active: false }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Diabetes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit the entry' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Current' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Resolved' })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PATCH', '/patients/7/medical/items/3')).toHaveLength(1));
    expect(calls('PATCH', '/patients/7/medical/items/3')[0]!.body).toMatchObject({ name: 'Diabetes', active: false, since: '2015-03' });
    expect(await screen.findByText('Medical history entry saved')).toBeInTheDocument();
  });

  it('asks before it removes an entry', async () => {
    await openPage();
    api.routes['DELETE /patients/7/medical/items/2'] = () => empty();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Latex' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this entry?' });
    expect(within(dialog).getByText(/switch it off instead/)).toBeInTheDocument();
    expect(calls('DELETE', '/patients/7/medical/items/2')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls('DELETE', '/patients/7/medical/items/2')).toHaveLength(1));
    expect(await screen.findByText('Removed from the medical history')).toBeInTheDocument();
  });

  it('edits the profile', async () => {
    await openPage();
    api.routes['PATCH /patients/7/medical/profile'] = () => json(200, { profile: profile({ bloodType: 'A+', pregnancy: 'yes' }) });
    await userEvent.click(await (await section('Medical profile')).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit the medical profile' });
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Blood type' }));
    await userEvent.click(screen.getByRole('option', { name: 'A+' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Pregnant' }));
    await userEvent.click(screen.getByRole('option', { name: 'Yes' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PATCH', '/patients/7/medical/profile')).toHaveLength(1));
    expect(calls('PATCH', '/patients/7/medical/profile')[0]!.body).toEqual({ bloodType: 'A+', pregnancy: 'yes', smoking: 'former', notes: 'Anxious about needles' });
    expect(await screen.findByText('Medical profile saved')).toBeInTheDocument();
  });
});

describe('the patient page', () => {
  const alerts = (extra: object = {}) => json(200, { recorded: true, allergies: [{ name: 'Penicillin', severity: 'severe' }, { name: 'Latex', severity: 'mild' }], conditions: ['Diabetes'], pregnant: true, ...extra });
  const openPatient = async (role = 'staff', reply: () => Response = () => alerts()) => {
    setup(role);
    api.routes['GET /patients/7/medical/alerts'] = reply;
    api.routes['GET /patients/7/counts'] = () => json(200, { appointments: 1, family: 0, payments: null, offers: 0, documents: 0, medical: 4 });
    renderApp(<App />, '/patients/7');
    await screen.findByRole('heading', { name: 'Hicham Cheaib' });
  };

  it('has a Medical history button with how many current entries there are', async () => {
    await openPatient();
    expect(await screen.findByRole('link', { name: 'Medical history (4)' })).toHaveAttribute('href', '/patients/7/medical');
  });

  it('warns about current allergies (severity shown), conditions and pregnancy', async () => {
    await openPatient();
    const banner = within(await screen.findByRole('region', { name: 'Medical alerts' }));
    expect(banner.getByText('Penicillin (severe)')).toBeInTheDocument();
    expect(banner.getByText('Latex (mild)')).toBeInTheDocument();
    expect(banner.getByText('Diabetes')).toBeInTheDocument();
    expect(banner.getByText('Pregnant')).toBeInTheDocument();
    expect(banner.getByRole('link', { name: 'Medical history' })).toHaveAttribute('href', '/patients/7/medical');
  });

  it('says when nothing has been recorded, and shows nothing when there is nothing to warn about', async () => {
    await openPatient('staff', () => json(200, { recorded: false, allergies: [], conditions: [], pregnant: false }));
    expect(await screen.findByText(/No medical history has been recorded/)).toBeInTheDocument();
  });

  it('shows no banner for someone who may not read the history', async () => {
    await openPatient('staff', () => json(403, errorBody('FORBIDDEN', 'You do not have permission')));
    await waitFor(() => expect(calls('GET', '/patients/7/medical/alerts')).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Medical alerts' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No medical history has been recorded/)).not.toBeInTheDocument();
  });
});
