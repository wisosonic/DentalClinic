import type { ReactElement } from 'react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { makeStore } from '../app/store';

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: any;  
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const empty = (status = 204) => new Response(null, { status });

export const user = (role: string, extra: object = {}) => ({
  id: 1, name: 'Aya Ghali', email: 'aya@clinic.test', role, mustChangePassword: false, isActive: true, lastLoginAt: null, ...extra,
});

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** Installs a fake `fetch`. Register handlers per test with `routes['GET /patients'] = ...`. */
export function useFakeApi() {
  const state = { calls: [] as Call[], routes: {} as Record<string, (call: Call) => Response> };
  beforeEach(() => {
    state.calls = [];
    state.routes = {};
    vi.stubGlobal('fetch', async (input: Request) => {
      const url = new URL(input.url);
      const text = await input.clone().text();
      const call: Call = {
        method: input.method, path: url.pathname.replace('/api/v1', ''), query: url.searchParams,
        headers: input.headers, body: !text ? undefined : /^(image\/|application\/pdf)/.test(input.headers.get('content-type') ?? '') ? text : JSON.parse(text),
      };
      state.calls.push(call);
      const handler = state.routes[`${call.method} ${call.path}`];
      return handler ? handler(call) : json(404, errorBody('NOT_FOUND', `no mock for ${call.method} ${call.path}`));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  return state;
}

export function renderApp(ui: ReactElement, path = '/') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </Provider>,
  );
}

export const PATIENT = {
  id: 7, patientIdentifier: '100007', fname: 'Hicham', lname: 'Cheaib', phone: '03039198', dateOfBirth: null, gender: 'male',
  email: null, address: null, lastVisit: '2025-11-02 12:56:20', description: null, doctorId: 1, hasAccount: false, createdAt: null,
};

export const CLINIC = { id: 1, name: 'Aya Ghali Clinic', phone: null, address: 'Karakol', type: null, latitude: null, longitude: null };
export const CLINIC_DOCTOR = { doctorId: 1, clinicId: 1, fname: 'Aya', lname: 'Al Ghali', speciality: 'General', kind: 'owner' };
export const UNIT = { id: 1, clinicId: 1, name: "Dr Aya's unit", ownerDoctorId: 1, ownerName: 'Aya Al Ghali' };

export function appointment(extra: object = {}) {
  return {
    id: 5, date: '2026-10-06', time: '10:00', durationMinutes: 30, endTime: '10:30', status: 'confirmed', intended: null, patientId: 7, doctorId: 1, clinicId: 1, unitId: 1, quoteId: null,
    patient: { id: 7, fname: 'Hicham', lname: 'Cheaib', phone: '03039198' }, doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali' },
    clinic: { id: 1, name: 'Aya Ghali Clinic' }, unit: { id: 1, name: "Dr Aya's unit", ownerDoctorId: 1 }, categories: [], ...extra,
  };
}
