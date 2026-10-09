import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-09' };
const MEMBER = {
  linkId: 11, patientId: 8, patientIdentifier: '100008', fname: 'Omar', lname: 'Cheaib', phone: '70123456', dateOfBirth: '1960-03-02', gender: 'male',
  relation: 'father', lastVisit: '2026-09-01', nextAppointment: { id: 5, date: '2026-10-12', time: '10:30' },
};
const OTHER = { ...MEMBER, linkId: 12, patientId: 9, patientIdentifier: '100009', fname: 'Mona', lname: 'Cheaib', relation: 'sibling', nextAppointment: null, lastVisit: null, dateOfBirth: null };
const calls = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);

const open = async (members: object[] = [MEMBER, OTHER], path = '/patients/7/family', role = 'staff') => {
  let current = members;
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /patients/7'] = () => json(200, { patient: { ...PATIENT, loginState: 'none' } });
  api.routes['GET /patients/7/family'] = () => json(200, { data: current });
  api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [] });
  api.routes['GET /doctors'] = () => json(200, { data: [] });
  api.routes['GET /patients'] = () => json(200, { data: [{ ...PATIENT, id: 8, fname: 'Omar', lname: 'Cheaib', phone: '70123456' }], meta: { page: 1, pageSize: 10, total: 1 } });
  renderApp(<App />, path);
  return { set: (m: object[]) => { current = m; } };
};

describe('the patient page', () => {
  it('has a Family button for clinic staff, which opens the family page', async () => {
    await open([], '/patients/7');
    await userEvent.click(await screen.findByRole('link', { name: 'Family' }));
    expect(await screen.findByRole('heading', { name: 'Family' })).toBeInTheDocument();
  });
});

describe('the family page', () => {
  it('lists the relatives with how they are related, their details and their next visit, each linked to their own page', async () => {
    await open();
    const table = await screen.findByRole('table', { name: 'Family members' });
    const omar = within(table).getByRole('row', { name: /Omar Cheaib/ });
    expect(within(omar).getByRole('link', { name: 'Omar Cheaib' })).toHaveAttribute('href', '/patients/8');
    expect(within(omar).getByText('Father')).toBeInTheDocument();
    expect(within(omar).getByText('100008')).toBeInTheDocument();
    expect(within(omar).getByText('70123456')).toBeInTheDocument();
    expect(within(omar).getByText(/12 Oct 2026/)).toBeInTheDocument();
    const mona = within(table).getByRole('row', { name: /Mona Cheaib/ });
    expect(within(mona).getByText('Sibling')).toBeInTheDocument();
    expect(within(mona).getAllByText('—').length).toBeGreaterThan(0); // no visit yet
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Family');
  });

  it('sorts by any column', async () => {
    await open();
    const table = await screen.findByRole('table', { name: 'Family members' });
    const names = () => within(table).getAllByRole('link').map((a) => a.textContent);
    expect(names()).toEqual(['Omar Cheaib', 'Mona Cheaib']); // Father before Sibling
    await userEvent.click(within(table).getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Mona Cheaib', 'Omar Cheaib']);
  });

  it('says so when nobody is linked, and offers to link someone', async () => {
    await open([]);
    expect(await screen.findByText('No family members are linked to this patient yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Link a family member' }).length).toBeGreaterThan(0);
  });
});

describe('linking a family member', () => {
  it('picks the relative and the relationship, sends them, and shows the new link', async () => {
    const list = await open([]);
    api.routes['POST /patients/7/family'] = (c) => {
      list.set([MEMBER]);
      return json(201, { member: { ...MEMBER, relation: (c.body as { relation: string }).relation } });
    };
    await userEvent.click((await screen.findAllByRole('button', { name: 'Link a family member' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Link a family member' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Relative/ }), 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Cheaib/ }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: /They are Hicham Cheaib’s/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Father', 'Mother', 'Son', 'Daughter', 'Sibling', 'Spouse']);
    await userEvent.click(screen.getByRole('option', { name: 'Father' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(calls('POST', '/patients/7/family')).toHaveLength(1));
    expect(calls('POST', '/patients/7/family')[0]!.body).toEqual({ relativeId: 8, relation: 'father' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('link', { name: 'Omar Cheaib' })).toBeInTheDocument();
    expect(await screen.findByText('Family member linked')).toBeInTheDocument();
  });

  it('asks for both before it sends anything', async () => {
    await open([]);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Link a family member' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Link a family member' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(await within(dialog).findByText('Choose a patient')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose how they are related')).toBeInTheDocument();
    expect(calls('POST', '/patients/7/family')).toHaveLength(0);
  });

  it('shows the server’s refusal in the dialog and keeps it open', async () => {
    await open([]);
    api.routes['POST /patients/7/family'] = () => json(409, errorBody('ALREADY_LINKED', 'These two patients are already linked. Remove the link first to change it.'));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Link a family member' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Link a family member' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Relative/ }), 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Cheaib/ }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: /They are/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Sibling' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already linked');
    expect(screen.getByRole('dialog', { name: 'Link a family member' })).toBeInTheDocument();
  });
});

describe('a spouse', () => {
  it('is shown as husband or wife by the relative’s gender, and as spouse when it is not known', async () => {
    await open([
      { ...MEMBER, relation: 'husband' },
      { ...OTHER, relation: 'wife' },
      { ...OTHER, linkId: 13, patientId: 10, fname: 'Sam', relation: 'spouse' },
    ]);
    const table = await screen.findByRole('table', { name: 'Family members' });
    expect(within(within(table).getByRole('row', { name: /Omar Cheaib/ })).getByText('Husband')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /Mona Cheaib/ })).getByText('Wife')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /Sam Cheaib/ })).getByText('Spouse')).toBeInTheDocument();
  });

  it('can be chosen when linking, and is sent as spouse', async () => {
    await open([]);
    api.routes['POST /patients/7/family'] = () => json(201, { member: { ...MEMBER, relation: 'husband' } });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Link a family member' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Link a family member' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: /Relative/ }), 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Cheaib/ }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: /They are/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Spouse' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(calls('POST', '/patients/7/family')).toHaveLength(1));
    expect(calls('POST', '/patients/7/family')[0]!.body).toEqual({ relativeId: 8, relation: 'spouse' });
  });
});

describe('removing a link', () => {
  it('asks first, then removes only the link', async () => {
    const list = await open();
    api.routes['DELETE /patients/7/family/11'] = () => { list.set([OTHER]); return empty(); };
    await userEvent.click(await screen.findByRole('button', { name: 'Remove the link to Omar Cheaib' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this family link?' });
    expect(within(dialog).getByText(/Neither patient’s record is deleted/)).toBeInTheDocument();
    expect(calls('DELETE', '/patients/7/family/11')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove the link' }));
    await waitFor(() => expect(calls('DELETE', '/patients/7/family/11')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Omar Cheaib' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Mona Cheaib' })).toBeInTheDocument();
  });
});

describe('the counts on the patient page', () => {
  const COUNTS = { appointments: 4, family: 2, payments: 3, offers: 1, documents: 0 };
  const openPage = async (counts: object, role = 'admin') => {
    await open([], '/patients/7', role);
    api.routes['GET /patients/7/counts'] = () => json(200, counts);
  };

  it('shows how much each button’s page holds, including none', async () => {
    api.routes['GET /patients/7/counts'] = () => json(200, COUNTS);
    await open([], '/patients/7', 'admin');
    api.routes['GET /patients/7/counts'] = () => json(200, COUNTS);
    expect(await screen.findByRole('link', { name: 'Appointments and reports (4)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Family (2)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Payments (3)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Treatment offers (1)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Documents (0)' })).toBeInTheDocument();
  });

  it('leaves a button plain when the person has no such figure (staff and payments)', async () => {
    await openPage({ ...COUNTS, payments: null }, 'staff');
    expect(await screen.findByRole('link', { name: 'Family (2)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Payments/ })).not.toBeInTheDocument(); // staff have no Payments button at all
  });

  it('keeps the plain names while the counts are not there yet', async () => {
    await open([], '/patients/7');
    expect(await screen.findByRole('link', { name: 'Family' })).toBeInTheDocument();
  });
});
