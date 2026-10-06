import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { makeStore } from '../app/store';
import { ACTION_MESSAGES, TOAST_MESSAGES, toastAdded } from '../features/toast/toast';
import ar from '../i18n/ar';
import { setLanguage } from '../i18n';
import { PATIENT, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const AUDIT = [{ id: 2, userId: 1, userName: 'Aya Ghali', action: 'patient.update', entity: null, entityId: null, entityLabel: null, diff: null, ip: null, createdAt: '2026-10-05 07:00:00' }];
const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const adminAuditSetup = () => {
  api.routes['GET /auth/me'] = () => json(200, { user: user('admin', { id: 1 }) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /users'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
  api.routes['GET /audit-log'] = () => json(200, { data: AUDIT, meta: { page: 1, pageSize: 50, total: 1 } });
  api.routes['DELETE /audit-log/2'] = () => new Response(null, { status: 204 });
};

describe('confirmations after a change', () => {
  it('says so after a successful delete', async () => {
    adminAuditSetup();
    renderApp(<App />, '/settings/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this entry' }));
    expect(await screen.findByText('Entry deleted')).toBeInTheDocument();
  });

  it('says so after saving a patient, and not after a read', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('staff') });
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
    api.routes['GET /teeth'] = () => json(200, { data: [] });
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    api.routes['PATCH /patients/7'] = () => json(200, { patient: { ...PATIENT, address: 'Beirut' } });
    renderApp(<App />, '/patients/7');
    await screen.findByRole('heading', { name: 'Hicham Cheaib' });
    expect(screen.queryByRole('status', { name: '' })).not.toBeInTheDocument(); // nothing yet: loading is not a change
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Patient saved')).toBeInTheDocument();
  });

  it('does not say anything when the change fails', async () => {
    adminAuditSetup();
    api.routes['DELETE /audit-log/2'] = () => json(500, { error: { code: 'INTERNAL', message: 'Something went wrong' } });
    renderApp(<App />, '/settings/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this entry' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument(); // the error is shown where it happened
    expect(screen.queryByText('Entry deleted')).not.toBeInTheDocument();
  });

  it('speaks Arabic when the language is Arabic', async () => {
    await setLanguage('ar');
    adminAuditSetup();
    renderApp(<App />, '/settings/audit');
    await userEvent.click(await screen.findByRole('button', { name: ar['Delete this entry'] }));
    expect(await screen.findByText(ar['Entry deleted'])).toBeInTheDocument();
  });

  it('shows the same message once, even when a save is made of several requests', () => {
    const store = makeStore();
    store.dispatch(toastAdded({ id: '1', message: 'Report saved' }));
    store.dispatch(toastAdded({ id: '2', message: 'Report saved' }));
    store.dispatch(toastAdded({ id: '3', message: 'Patient saved' }));
    expect(store.getState().toast.map((t) => t.message)).toEqual(['Report saved', 'Patient saved']);
  });

  it('goes away on its own', async () => {
    adminAuditSetup();
    renderApp(<App />, '/settings/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this entry' }));
    await screen.findByText('Entry deleted');
    await waitFor(() => expect(screen.queryByText('Entry deleted')).not.toBeInTheDocument(), { timeout: 8000 });
  }, 15000);
});

describe('confirmation wording', () => {
  it('has Arabic text for every message', () => {
    for (const message of [...Object.values(TOAST_MESSAGES), ...Object.values(ACTION_MESSAGES)]) expect(ar[message], message).toBeTruthy();
  });
});
