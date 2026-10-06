import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { sortRows } from '../components/SortHead';
import { PATIENT, appointment, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

describe('sortRows', () => {
  it('sorts text naturally, ignoring case, both ways', () => {
    const rows = ['b10', 'B2', 'a1'];
    expect(sortRows(rows, (r) => r, 'asc')).toEqual(['a1', 'B2', 'b10']);
    expect(sortRows(rows, (r) => r, 'desc')).toEqual(['b10', 'B2', 'a1']);
  });
  it('sorts numbers by value and keeps blanks last in both directions', () => {
    const rows = [{ v: 10 }, { v: null }, { v: 2 }];
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([2, 10, null]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([10, 2, null]);
  });
});

describe('sortable tables', () => {
  it('asks the server to sort the patient list, and flips on a second click', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff') });
    api.routes['GET /patients'] = () => json(200, { data: [PATIENT], meta: { page: 1, pageSize: 25, total: 1 } });
    renderApp(<App />, '/patients');
    await userEvent.click(await screen.findByRole('button', { name: 'Phone' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/patients' && c.query.get('sort') === 'phone' && c.query.get('order') === 'asc')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Phone' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/patients' && c.query.get('sort') === 'phone' && c.query.get('order') === 'desc')).toBe(true));
    expect(screen.getByRole('columnheader', { name: /Phone/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts the medications in the browser', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /medications'] = () => json(200, { data: [{ id: 1, name: 'Ibuprofen', type: 'tablet' }, { id: 2, name: 'Amoxicillin', type: 'capsule' }] });
    renderApp(<App />, '/medications');
    const firstRow = async () => (await screen.findAllByRole('row'))[1]!.textContent;
    await waitFor(async () => expect(await firstRow()).toContain('Amoxicillin')); // name ascending by default
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    await waitFor(async () => expect(await firstRow()).toContain('Ibuprofen'));
    await userEvent.click(screen.getByRole('button', { name: 'Form' }));
    await waitFor(async () => expect(await firstRow()).toContain('Amoxicillin')); // capsule before tablet
    expect(within(screen.getByRole('columnheader', { name: /Form/ })).getByRole('button')).toBeInTheDocument();
  });
});

describe('report column in the appointment list', () => {
  it('shows which appointments have a report and sorts by it on the server', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff') });
    api.routes['GET /config'] = () => json(200, { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    api.routes['GET /units'] = () => json(200, { data: [] });
    api.routes['GET /appointments'] = () => json(200, {
      data: [appointment({ id: 1, hasReport: true }), appointment({ id: 2, hasReport: false, patient: { id: 8, fname: 'Nour', lname: 'Haddad', phone: '1' } })],
      meta: { page: 1, pageSize: 25, total: 2 },
    });
    renderApp(<App />, '/appointments');
    await userEvent.click(await screen.findByRole('tab', { name: 'List' }));
    const header = await screen.findByRole('columnheader', { name: /Report/ });
    expect(header).toBeInTheDocument();
    const rows = await screen.findAllByRole('row');
    expect(within(rows[1]!).getByText('Written')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText('Written')).not.toBeInTheDocument();
    await userEvent.click(within(header).getByRole('button'));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/appointments' && c.query.get('sort') === 'report')).toBe(true));
  });
});
