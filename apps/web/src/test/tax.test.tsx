import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TAX_SETTINGS, calculateIncomeTax } from '@aya/shared';
import { App } from '../App';
import { formatLbp, formatMoney } from '../lib/money';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const DOCTORS = [{ id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: null, gender: null, kind: 'owner' }];

const tax = (extra: object = {}) => {
  const input = { paymentsUsd: 100_000, spouse: false, children: 0 };
  return {
    year: 2026, doctor: null, family: { spouse: false, children: 0 },
    payments: { clinic: { total: 80_000, count: 8 }, commission: { total: 20_000, count: 2 }, totalUsd: 100_000 }, excluded: [],
    input, settings: DEFAULT_TAX_SETTINGS, rulesFrom: null, usingDefaults: true, result: calculateIncomeTax(input, DEFAULT_TAX_SETTINGS),
    declaration: null, drift: null, declaredYears: [], ...extra,
  };
};

/** Waits for the Tax payable tile to show this amount. */
const payable = (amount: string) => waitFor(() => expect(within(screen.getByRole('region', { name: 'Tax payable' })).getByText(amount)).toBeInTheDocument());

let SETS: { effectiveYear: number; settings: typeof DEFAULT_TAX_SETTINGS; updatedAt: string | null }[] = [];

const signIn = (role = 'admin', body: object = tax()) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /doctors'] = () => json(200, { data: DOCTORS });
  api.routes['GET /finance/tax'] = () => json(200, body);
  api.routes['GET /settings/tax'] = () => json(200, { sets: SETS, defaults: DEFAULT_TAX_SETTINGS });
};

describe('income tax page', () => {
  beforeEach(() => { SETS = []; });

  it('is for admins only', async () => {
    signIn('doctor');
    renderApp(<App />, '/income-tax');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/finance/tax')).toBe(false);
  });

  it('shows the payments, the tax payable in LBP and the steps, as worked out by hand', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000)); // the tile
    const steps = screen.getByRole('list', { name: 'How it is worked out' });
    const text = within(steps).getAllByRole('listitem').map((li) => li.textContent);
    expect(text[0]).toContain(formatLbp(8_950_000_000));
    expect(text[1]).toContain(formatLbp(3_132_500_000));
    expect(text[2]).toContain(formatLbp(-450_000_000));
    expect(text[3]).toContain(formatLbp(2_682_500_000));
    expect(text[4]).toContain(formatLbp(233_700_000));
    expect(screen.getByText('Check them in Settings')).toHaveAttribute('href', '/settings');
    expect(api.calls.find((c) => c.path === '/finance/tax')!.query.get('year')).toBe('2026');
  });

  it('recalculates at once when the family details change, without asking the server again', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    const before = api.calls.filter((c) => c.path === '/finance/tax').length;
    await userEvent.click(screen.getByLabelText('Spouse is eligible'));
    fireEvent.change(screen.getByLabelText('Eligible children'), { target: { value: '2' } });
    await payable(formatLbp(200_700_000));
    expect(api.calls.filter((c) => c.path === '/finance/tax')).toHaveLength(before);
  });

  it('lets an amount be tried instead of the year’s payments', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    fireEvent.change(screen.getByLabelText('Try another amount (USD)'), { target: { value: '1000' } });
    await payable(formatLbp(0)); // the allowance covers it
    expect(screen.getByText('The amount you are trying.')).toBeInTheDocument();
  });

  it('asks again for another year or another taxpayer', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    await userEvent.click(screen.getByLabelText('Taxpayer'));
    await userEvent.click(await screen.findByRole('option', { name: 'Dr. Aya Al Ghali' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/finance/tax').at(-1)!.query.get('doctorId')).toBe('1'));
    await userEvent.click(screen.getByLabelText('Year'));
    await userEvent.click(await screen.findByRole('option', { name: '2025' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/finance/tax').at(-1)!.query.get('year')).toBe('2025'));
  });

  it('sorts the bracket table by any column', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    const firstCells = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2]!.textContent);
    expect(firstCells()).toEqual(['4%', '7%', '12%', '16%', '21%', '25%']);
    await userEvent.click(screen.getByRole('button', { name: 'Rate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rate' }));
    await waitFor(() => expect(firstCells()).toEqual(['25%', '21%', '16%', '12%', '7%', '4%']));
  });

  it('warns about payments in other currencies and says which rules apply', async () => {
    signIn('admin', tax({ usingDefaults: false, rulesFrom: 2025, excluded: [{ currency: 'EUR', total: 50, count: 1 }] }));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByText(/left out/)).toHaveTextContent('EUR 50 (1)');
    expect(screen.queryByText('Check them in Settings')).not.toBeInTheDocument();
    expect(screen.getByText(/Using the rules that apply from 2025/)).toBeInTheDocument();
  });

  it('starts from the doctor’s saved family details', async () => {
    const input = { paymentsUsd: 100_000, spouse: true, children: 2 };
    signIn('admin', tax({ doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali' }, family: { spouse: true, children: 2 }, input, result: calculateIncomeTax(input, DEFAULT_TAX_SETTINGS) }));
    renderApp(<App />, '/income-tax');
    await userEvent.click(await screen.findByLabelText('Taxpayer'));
    await userEvent.click(await screen.findByRole('option', { name: 'Dr. Aya Al Ghali' }));
    await waitFor(() => expect(screen.getByLabelText('Eligible children')).toHaveValue(2));
    expect(screen.getByLabelText('Spouse is eligible')).toBeChecked();
    await payable(formatLbp(200_700_000));
  });

  it('shows the error when the figures cannot be loaded', async () => {
    signIn();
    api.routes['GET /finance/tax'] = () => json(500, errorBody('INTERNAL', 'Something went wrong'));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('declaring a year', () => {
  const declaration = { id: 1, declaredAt: '2026-10-05 09:00:00', paidDate: '2026-10-04', note: 'Filed at the ministry', declaredBy: 'Admin One', canReopen: true };

  beforeEach(() => { SETS = []; });

  it('marks the year as declared and paid, asking first, and sends the day and the family details shown', async () => {
    signIn();
    api.routes['POST /finance/tax/declare'] = () => json(201, { declaration, declaredYears: [2026] });
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    await userEvent.click(await screen.findByLabelText('Spouse is eligible'));
    await userEvent.click(screen.getByRole('button', { name: 'Mark this year as declared and paid' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark 2026 as declared and paid?' });
    expect(within(dialog).getByText(/There is no way back/)).toBeInTheDocument();
    expect(within(dialog).getByText(formatLbp(206_700_000))).toBeInTheDocument(); // with the spouse allowance just ticked
    fireEvent.change(within(dialog).getByLabelText(/Day it was paid/), { target: { value: '2026-10-04' } });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Filed at the ministry' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Declared and paid' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/finance/tax/declare')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ year: 2026, doctorId: null, paidDate: '2026-10-04', note: 'Filed at the ministry', spouse: true, children: 0 });
    expect(await screen.findByText('Year marked as declared and paid')).toBeInTheDocument();
  });

  it('shows a declared year from the stored copy, with the controls locked and no way to declare again', async () => {
    const input = { paymentsUsd: 100_000, spouse: true, children: 2 };
    signIn('admin', tax({ input, result: calculateIncomeTax(input, DEFAULT_TAX_SETTINGS), declaration, declaredYears: [2026] }));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByText(/Declared and paid on/)).toHaveTextContent('Admin One');
    expect(screen.getByText(/no longer recalculated/)).toBeInTheDocument();
    await payable(formatLbp(200_700_000)); // the stored result
    expect(screen.getByLabelText('Spouse is eligible')).toBeDisabled();
    expect(screen.getByLabelText('Spouse is eligible')).toBeChecked(); // as it was filed
    expect(screen.getByLabelText('Eligible children')).toBeDisabled();
    expect(screen.getByLabelText('Eligible children')).toHaveValue(2);
    expect(screen.getByLabelText('Try another amount (USD)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Mark this year as declared and paid' })).not.toBeInTheDocument();
    expect(screen.getByText('Filed at the ministry', { exact: false })).toBeInTheDocument();
  });

  it('warns when the payments changed after the declaration, without changing the stored figures', async () => {
    signIn('admin', tax({ declaration, declaredYears: [2026], drift: { paymentsUsd: 105_000 } }));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByText(/have changed since it was declared/)).toHaveTextContent(formatMoney(105_000));
    await payable(formatLbp(233_700_000)); // still the stored one
  });

  it('marks the declared years in the year list', async () => {
    signIn('admin', tax({ declaredYears: [2025] }));
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    await userEvent.click(screen.getByLabelText('Year'));
    expect(await screen.findByRole('option', { name: '2025 · Declared and paid' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '2026' })).toBeInTheDocument();
  });

  it('cannot be declared while trying another amount, or with payments in an unknown currency', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    fireEvent.change(screen.getByLabelText('Try another amount (USD)'), { target: { value: '5' } });
    expect(await screen.findByRole('button', { name: 'Mark this year as declared and paid' })).toBeDisabled();
    expect(screen.getByText('Clear the amount you are trying first.')).toBeInTheDocument();
  });

  it('shows the server’s refusal, and keeps the dialog open', async () => {
    signIn();
    api.routes['POST /finance/tax/declare'] = () => json(409, errorBody('ALREADY_DECLARED', 'This year is already declared and paid'));
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    await userEvent.click(screen.getByRole('button', { name: 'Mark this year as declared and paid' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Declared and paid' }));
    expect(await within(dialog).findByText('This year is already declared and paid')).toBeInTheDocument();
  });
});

describe('the PDF worksheet and reopening a year', () => {
  const declaration = { id: 1, declaredAt: '2026-10-05 09:00:00', paidDate: '2026-10-04', note: null, declaredBy: 'Admin One', canReopen: true };
  beforeEach(() => { SETS = []; });

  it('links to the worksheet of the year and taxpayer shown, with the family details on the page', async () => {
    signIn();
    renderApp(<App />, '/income-tax');
    await payable(formatLbp(233_700_000));
    expect(screen.getByRole('link', { name: 'PDF worksheet' })).toHaveAttribute('href', '/api/v1/finance/tax/pdf?year=2026&spouse=0&children=0');
    await userEvent.click(screen.getByLabelText('Spouse is eligible'));
    fireEvent.change(screen.getByLabelText('Eligible children'), { target: { value: '2' } });
    expect(screen.getByRole('link', { name: 'PDF worksheet' })).toHaveAttribute('href', '/api/v1/finance/tax/pdf?year=2026&spouse=1&children=2');
  });

  it('asks for the stored copy of a declared year: no family details in the link', async () => {
    signIn('admin', tax({ declaration, declaredYears: [2026] }));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByRole('link', { name: 'PDF worksheet' })).toHaveAttribute('href', '/api/v1/finance/tax/pdf?year=2026');
  });

  it('reopens the current year after asking, and says what that does', async () => {
    signIn('admin', tax({ declaration, declaredYears: [2026] }));
    api.routes['POST /finance/tax/reopen'] = () => json(200, { declaredYears: [] });
    renderApp(<App />, '/income-tax');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen this year' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reopen 2026?' });
    expect(within(dialog).getByText(/kept in the records as reopened/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen this year' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/finance/tax/reopen')).toBe(true));
    expect(api.calls.find((c) => c.path === '/finance/tax/reopen')!.body).toEqual({ year: 2026, doctorId: null });
    expect(await screen.findByText('Year reopened')).toBeInTheDocument();
  });

  it('says a past year is locked and offers no way to reopen it', async () => {
    signIn('admin', tax({ year: 2025, declaration: { ...declaration, canReopen: false }, declaredYears: [2025] }));
    renderApp(<App />, '/income-tax');
    expect(await screen.findByText('This year is over, so its declaration is locked and cannot be reopened.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen this year' })).not.toBeInTheDocument();
  });

  it('shows the server’s refusal and keeps the dialog open', async () => {
    signIn('admin', tax({ declaration, declaredYears: [2026] }));
    api.routes['POST /finance/tax/reopen'] = () => json(409, errorBody('YEAR_LOCKED', 'A past year cannot be reopened after it was declared'));
    renderApp(<App />, '/income-tax');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen this year' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen this year' }));
    expect(await within(dialog).findByText('A past year cannot be reopened after it was declared')).toBeInTheDocument();
  });
});

describe('settings page', () => {
  const saved = (year: number, extra: object = {}) => ({ effectiveYear: year, settings: { ...DEFAULT_TAX_SETTINGS, ...extra }, updatedAt: '2026-10-01 10:00:00' });
  beforeEach(() => { SETS = []; });

  it('is for admins only', async () => {
    signIn('staff');
    renderApp(<App />, '/settings/taxes');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
  });

  it('shows the starting values, with nothing saved yet', async () => {
    signIn();
    renderApp(<App />, '/settings/taxes');
    expect(await screen.findByLabelText('LBP per 1 US dollar')).toHaveValue(89500);
    expect(screen.getByLabelText(/Tax percentage of the payments/)).toHaveValue(35);
    expect(screen.getByLabelText('Single')).toHaveValue(450_000_000);
    expect(screen.getByLabelText('Each eligible child (added)')).toHaveValue(25_000_000);
    expect(screen.getByLabelText('From of bracket 2')).toHaveValue('540000000'); // starts where bracket 1 ends
    expect(screen.getByLabelText('To of bracket 6')).toBeDisabled(); // the last has no limit
    expect(screen.getByText(/Nothing is saved yet/)).toBeInTheDocument();
  });

  it('saves the first set for a year', async () => {
    signIn();
    api.routes['PUT /settings/tax/2026'] = (c) => json(200, { sets: [{ effectiveYear: 2026, settings: c.body, updatedAt: null }], defaults: DEFAULT_TAX_SETTINGS });
    renderApp(<App />, '/settings/taxes');
    fireEvent.change(await screen.findByLabelText('LBP per 1 US dollar'), { target: { value: '90000' } });
    fireEvent.change(screen.getByLabelText(/Tax percentage of the payments/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('To of bracket 1'), { target: { value: '600000000' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/settings/tax/2026')).toBe(true));
    const body = api.calls.find((c) => c.method === 'PUT')!.body;
    expect(body).toMatchObject({ usdToLbp: 90000, taxPercentage: 30 });
    expect(body.brackets[0]).toEqual({ from: 0, to: 600_000_000, rate: 4 });
    expect(body.brackets[1].from).toBe(600_000_000); // the next bracket follows
    expect(body.brackets.at(-1).to).toBeNull();
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });

  it('lists the saved sets by year, shows the newest, and switches between them', async () => {
    SETS = [saved(2028, { usdToLbp: 200_000 }), saved(2024, { usdToLbp: 100_000 })];
    signIn();
    renderApp(<App />, '/settings/taxes');
    expect(await screen.findByLabelText('LBP per 1 US dollar')).toHaveValue(200_000);
    await userEvent.click(screen.getByLabelText('Rules that apply from'));
    expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['From 2028', 'From 2024', 'Add rules for a new year']);
    await userEvent.click(screen.getByRole('option', { name: 'From 2024' }));
    expect(screen.getByLabelText('LBP per 1 US dollar')).toHaveValue(100_000);
  });

  it('adds a set for a new year, starting as a copy of the newest', async () => {
    SETS = [saved(2024, { usdToLbp: 100_000 })];
    signIn();
    api.routes['PUT /settings/tax/2027'] = (c) => json(200, { sets: [{ effectiveYear: 2027, settings: c.body, updatedAt: null }, ...SETS], defaults: DEFAULT_TAX_SETTINGS });
    renderApp(<App />, '/settings/taxes');
    await screen.findByLabelText('LBP per 1 US dollar');
    await userEvent.click(screen.getByLabelText('Rules that apply from'));
    await userEvent.click(await screen.findByRole('option', { name: 'Add rules for a new year' }));
    expect(screen.getByLabelText('LBP per 1 US dollar')).toHaveValue(100_000); // copied
    fireEvent.change(screen.getByLabelText('Applies from year'), { target: { value: '2027' } });
    fireEvent.change(screen.getByLabelText('LBP per 1 US dollar'), { target: { value: '120000' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/settings/tax/2027')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body.usdToLbp).toBe(120000);
  });

  it('refuses a missing year and nonsense values before sending anything', async () => {
    signIn();
    renderApp(<App />, '/settings/taxes');
    fireEvent.change(await screen.findByLabelText('LBP per 1 US dollar'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Rate of bracket 1'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText(/Tax percentage of the payments/), { target: { value: '0' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('The exchange rate must be above zero')).toBeInTheDocument();
    expect(screen.getByText('The rate cannot be above 100')).toBeInTheDocument();
    expect(screen.getByText('The percentage must be above zero')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('deletes a set after asking', async () => {
    SETS = [saved(2026)];
    signIn();
    api.routes['DELETE /settings/tax/2026'] = () => { SETS = []; return json(200, { sets: [], defaults: DEFAULT_TAX_SETTINGS }); };
    renderApp(<App />, '/settings/taxes');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this set' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete this set' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/settings/tax/2026')).toBe(true));
    expect(await screen.findByText('Tax rules deleted')).toBeInTheDocument();
  });

  it('adds and removes brackets', async () => {
    signIn();
    renderApp(<App />, '/settings/taxes');
    await screen.findByLabelText('To of bracket 1');
    await userEvent.click(screen.getByRole('button', { name: 'Add bracket' }));
    expect(screen.getByLabelText('Rate of bracket 7')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove bracket 7' }));
    expect(screen.queryByLabelText('Rate of bracket 7')).not.toBeInTheDocument();
  });

  it('shows the server’s refusal', async () => {
    signIn();
    api.routes['PUT /settings/tax/2026'] = () => json(400, errorBody('VALIDATION', 'Each bracket must start where the one before it ends'));
    renderApp(<App />, '/settings/taxes');
    await screen.findByLabelText('LBP per 1 US dollar');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Each bracket must start where the one before it ends');
  });
});
