import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-15' };
const ALL = ['daily-schedule', 'revenue', 'outstanding-balances', 'appointments', 'procedures', 'patients', 'lab-orders'];

const signIn = (role: string, reports: string[] = ALL) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /reports'] = () => json(200, { data: reports });
  api.routes['GET /doctors'] = () => json(200, { data: [{ id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: null, gender: null, kind: 'owner' }] });
};
const card = async (name: string) => within(await screen.findByRole('region', { name }));

describe('reports page', () => {
  it('shows an admin every report, with a Download button per format', async () => {
    signIn('admin');
    renderApp(<App />, '/reports');
    expect((await screen.findAllByRole('region')).map((r) => r.getAttribute('aria-label'))).toEqual([
      'Daily schedule', 'Revenue and expenses', 'Outstanding balances', 'Appointments', 'Procedures', 'New patients', 'Lab orders',
    ]);
    expect((await card('Revenue and expenses')).getByRole('link', { name: 'Download Revenue and expenses as PDF' })).toBeInTheDocument();
    expect((await card('Appointments')).queryByRole('link', { name: /as PDF/ })).not.toBeInTheDocument(); // Excel only
    expect((await card('Daily schedule')).queryByRole('link', { name: /as Excel/ })).not.toBeInTheDocument(); // PDF only
  });

  it('shows staff only what the server says they may run', async () => {
    signIn('staff', ['daily-schedule', 'lab-orders']);
    renderApp(<App />, '/reports');
    expect((await screen.findAllByRole('region')).map((r) => r.getAttribute('aria-label'))).toEqual(['Daily schedule', 'Lab orders']);
    expect(screen.queryByRole('region', { name: 'Revenue and expenses' })).not.toBeInTheDocument();
  });

  it('points each download at the report with the chosen day, period and grouping', async () => {
    signIn('admin');
    renderApp(<App />, '/reports');
    const schedule = await card('Daily schedule');
    expect(schedule.getByRole('link', { name: 'Download Daily schedule as PDF' })).toHaveAttribute('href', '/api/v1/reports/daily-schedule?date=2026-10-15');
    fireEvent.change(schedule.getByLabelText('Day'), { target: { value: '2026-10-20' } });
    expect(schedule.getByRole('link', { name: 'Download Daily schedule as PDF' })).toHaveAttribute('href', '/api/v1/reports/daily-schedule?date=2026-10-20');

    const revenue = await card('Revenue and expenses');
    expect(revenue.getByRole('link', { name: 'Download Revenue and expenses as Excel' })).toHaveAttribute('href', '/api/v1/reports/revenue?from=2026-10-01&to=2026-10-15&groupBy=month&format=xlsx');
    await userEvent.click(revenue.getByLabelText('Group by'));
    await userEvent.click(await screen.findByRole('option', { name: 'Type' }));
    fireEvent.change(revenue.getByLabelText('From'), { target: { value: '2026-09-01' } });
    expect(revenue.getByRole('link', { name: 'Download Revenue and expenses as PDF' })).toHaveAttribute('href', '/api/v1/reports/revenue?from=2026-09-01&to=2026-10-15&groupBy=type&format=pdf');
    expect((await card('Outstanding balances')).getByRole('link', { name: 'Download Outstanding balances as Excel' })).toHaveAttribute('href', '/api/v1/reports/outstanding-balances?format=xlsx');
  });

  it('lets an admin limit the daily schedule to one doctor, and a doctor see the grouping without “Doctor”', async () => {
    signIn('admin');
    renderApp(<App />, '/reports');
    const schedule = await card('Daily schedule');
    await userEvent.click(schedule.getByLabelText('Doctor'));
    await userEvent.click(await screen.findByRole('option', { name: 'Dr. Aya Al Ghali' }));
    expect(schedule.getByRole('link', { name: 'Download Daily schedule as PDF' })).toHaveAttribute('href', '/api/v1/reports/daily-schedule?date=2026-10-15&doctorId=1');
  });

  it('does not offer to group by doctor to a doctor', async () => {
    signIn('doctor', ['revenue', 'appointments']);
    api.routes['GET /auth/me'] = () => json(200, { user: user('doctor', { doctor: { id: 1, kind: 'owner' } }) });
    renderApp(<App />, '/reports');
    const revenue = await card('Revenue and expenses');
    await userEvent.click(revenue.getByLabelText('Group by'));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Month', 'Type']);
  });

  it('disables the downloads and says why when the start is after the end', async () => {
    signIn('admin');
    renderApp(<App />, '/reports');
    const appointments = await card('Appointments');
    fireEvent.change(appointments.getByLabelText('From'), { target: { value: '2026-11-01' } });
    expect(appointments.getByText('The start must not be after the end')).toBeInTheDocument();
    const disabled = appointments.getByRole('button', { name: 'Download Appointments as Excel' }); // no address, so it is not a link any more
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).not.toHaveAttribute('href');
  });

  it('says so when there is nothing to run', async () => {
    signIn('staff', []);
    renderApp(<App />, '/reports');
    expect(await screen.findByText('There are no reports you can run.')).toBeInTheDocument();
  });
});

describe('big reports', () => {
  const job = (extra: object = {}) => ({ id: 4, report: 'appointments', title: 'Appointments', status: 'done', rows: 61234, createdAt: '2026-10-05 08:00:00', finishedAt: '2026-10-05 08:03:00', expiresAt: '2026-10-12 08:03:00', downloadUrl: '/api/v1/reports/jobs/4/file', ...extra });

  it('says a report is being prepared when the server sent you here for one, and lists it', async () => {
    signIn('admin');
    api.routes['GET /reports/jobs'] = () => json(200, { data: [job({ status: 'queued', rows: null, finishedAt: null, expiresAt: null, downloadUrl: null })] });
    renderApp(<App />, '/reports?queued=4');
    expect(await screen.findByText(/it is being prepared in the background/)).toBeInTheDocument();
    const row = within(await screen.findByRole('table', { name: 'Big reports' })).getByText('Appointments').closest('tr') as HTMLElement;
    expect(within(row).getByText('Waiting')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument(); // nothing to download yet
  });

  it('offers a finished report for download, with its size and how long it is kept', async () => {
    signIn('admin');
    api.routes['GET /reports/jobs'] = () => json(200, { data: [job()] });
    renderApp(<App />, '/reports');
    const table = within(await screen.findByRole('table', { name: 'Big reports' }));
    expect(table.getByText('Ready')).toBeInTheDocument();
    expect(table.getByText('61,234')).toBeInTheDocument();
    expect(table.getByRole('link', { name: 'Download Appointments' })).toHaveAttribute('href', '/api/v1/reports/jobs/4/file');
    expect(screen.queryByText(/being prepared in the background/)).not.toBeInTheDocument();
  });

  it('sorts the list by any column', async () => {
    signIn('admin');
    api.routes['GET /reports/jobs'] = () => json(200, { data: [job({ id: 1, title: 'Zeta', rows: 10 }), job({ id: 2, title: 'Alpha', rows: 99 })] });
    renderApp(<App />, '/reports');
    const table = within(await screen.findByRole('table', { name: 'Big reports' }));
    const titles = () => table.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    await userEvent.click(table.getByRole('button', { name: 'Report' }));
    expect(titles()).toEqual(['Alpha', 'Zeta']);
    await userEvent.click(table.getByRole('button', { name: 'Rows' }));
    expect(titles()).toEqual(['Zeta', 'Alpha']);
  });

  it('shows nothing when there are none', async () => {
    signIn('admin');
    api.routes['GET /reports/jobs'] = () => json(200, { data: [] });
    renderApp(<App />, '/reports');
    await screen.findByRole('region', { name: 'Daily schedule' });
    expect(screen.queryByRole('region', { name: 'Big reports' })).not.toBeInTheDocument();
  });
});
