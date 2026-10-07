import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { PATIENT, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-07' };
const pdf = () => new Response('%PDF-1.4 a card', { status: 200, headers: { 'content-type': 'application/pdf' } });
const cardCalls = () => api.calls.filter((c) => c.method === 'POST' && c.path === '/patients/7/card');

const open = async (role = 'staff', patient: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /doctors'] = () => json(200, { data: [{ id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: 'General', gender: 'female', kind: 'owner' }] });
  api.routes['GET /patients/7'] = () => json(200, { patient: { ...PATIENT, loginState: 'none', ...patient } });
  api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [] });
  renderApp(<App />, '/patients/7');
  await screen.findByRole('heading', { name: 'Hicham Cheaib' });
};

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:card-1'), revokeObjectURL: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

describe('the username and the patient card on the patient page', () => {
  it('shows the username and whether the patient has a login', async () => {
    await open('staff', { username: 'hicham.cheaib' });
    expect(await screen.findByText('hicham.cheaib')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument(); // no login yet
  });

  it('says when the first password has not been changed yet', async () => {
    await open('staff', { hasAccount: true, loginState: 'waiting' });
    expect(await screen.findByText('First password not changed yet')).toBeInTheDocument();
  });

  it('creates the card the first time: sends nothing but the request, then offers the PDF without keeping the password', async () => {
    await open();
    api.routes['POST /patients/7/card'] = () => pdf();
    await userEvent.click(await screen.findByRole('button', { name: 'Patient card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Patient card' });
    expect(within(dialog).getByText(/creates the patient’s login/)).toBeInTheDocument();
    expect(within(dialog).getByText('hicham.cheaib')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create the card' }));
    const open_ = await within(dialog).findByRole('link', { name: 'Open the card' });
    expect(open_).toHaveAttribute('href', 'blob:card-1');
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'patient-card-100007.pdf');
    expect(within(dialog).getByText(/cannot be shown again/)).toBeInTheDocument();
    expect(cardCalls()).toHaveLength(1);
    expect(cardCalls()[0]!.body).toEqual({});
    // the patient page now reads again, so it can show that there is a login
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'GET' && c.path === '/patients/7').length).toBeGreaterThan(1));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card-1')); // the card's address is released
  });

  it('warns that a new card replaces the first password while it has not been changed', async () => {
    await open('staff', { hasAccount: true, loginState: 'waiting' });
    api.routes['POST /patients/7/card'] = () => pdf();
    await userEvent.click(await screen.findByRole('button', { name: 'Patient card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Patient card' });
    expect(within(dialog).getByText(/earlier card stops working/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make a new card' }));
    await within(dialog).findByRole('link', { name: 'Open the card' });
    expect(cardCalls()[0]!.body).toEqual({});
  });

  it('makes staff confirm before it replaces a password the patient chose, and then asks for a reset', async () => {
    await open('staff', { hasAccount: true, loginState: 'active' });
    api.routes['POST /patients/7/card'] = () => pdf();
    await userEvent.click(await screen.findByRole('button', { name: 'Patient card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Patient card' });
    expect(within(dialog).getByText(/already chosen their own password/)).toBeInTheDocument();
    const make = within(dialog).getByRole('button', { name: 'Make a new card' });
    expect(make).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I understand/ }));
    expect(make).toBeEnabled();
    await userEvent.click(make);
    await within(dialog).findByRole('link', { name: 'Open the card' });
    expect(cardCalls()[0]!.body).toEqual({ reset: true });
  });

  it('shows the server’s refusal, in the language of the screen, and makes no card', async () => {
    await open();
    api.routes['POST /patients/7/card'] = () => json(409, errorBody('ACCOUNT_DISABLED', 'The patient’s login is switched off: an administrator can switch it on under Users'));
    await userEvent.click(await screen.findByRole('button', { name: 'Patient card' }));
    const dialog = await screen.findByRole('dialog', { name: 'Patient card' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create the card' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('switched off');
    expect(within(dialog).queryByRole('link', { name: 'Open the card' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('registering a patient', () => {
  it('says that a username is made from the name', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    api.routes['GET /patients'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    renderApp(<App />, '/patients');
    await userEvent.click(await screen.findByRole('button', { name: /New patient/ }));
    expect(await screen.findByText('A unique username is made from the name when the patient is saved.')).toBeInTheDocument();
  });
});
