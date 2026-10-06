import bcrypt from 'bcryptjs';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { createApp } from '../src/app';
import { parseEnv, type Env } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { migrateLatest } from '../src/db/migrate';

export const PASSWORD = 'Correct-Horse-9';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  env: Env;
  client: () => Client;
  destroy: () => Promise<void>;
}

export async function buildTestApp(
  overrides: Record<string, string> = {},
  clock: () => Date = () => new Date(),
): Promise<TestApp> {
  const env = parseEnv({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    DB_FILENAME: ':memory:',
    JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    BCRYPT_COST: '4',
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
  const db = createDb(env);
  await migrateLatest(db);

  const hash = bcrypt.hashSync(PASSWORD, 4);
  const now = '2026-01-01 00:00:00';
  const users = [
    { name: 'Admin One', email: 'admin@clinic.test', role: 'admin' },
    { name: 'Admin Two', email: 'admin2@clinic.test', role: 'admin' },
    { name: 'Dr Doctor', email: 'doctor@clinic.test', role: 'doctor' },
    { name: 'Sam Staff', email: 'staff@clinic.test', role: 'staff' },
    { name: 'Pat Patient', email: 'patient@clinic.test', role: 'patient' },
  ];
  for (const u of users) await db('users').insert({ ...u, password: hash, created_at: now, updated_at: now });

  const app = createApp({ db, env, clock, logger: pino({ level: 'silent' }) });
  return { app, db, env, client: () => new Client(app), destroy: () => db.destroy() };
}

/** A cookie-keeping HTTP client that echoes the CSRF cookie in the header, like the SPA does. */
export class Client {
  agent;
  csrf = '';
  constructor(app: Parameters<typeof request.agent>[0]) {
    this.agent = request.agent(app);
  }

  private capture(res: Response) {
    for (const cookie of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const m = /^csrf_token=([^;]*)/.exec(cookie);
      if (m) this.csrf = m[1]!;
    }
    return res;
  }

  async send(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: object, withCsrf = true) {
    let req = this.agent[method](`/api/v1${url}`);
    if (withCsrf && this.csrf) req = req.set('x-csrf-token', this.csrf);
    if (body) req = req.send(body);
    return this.capture(await req);
  }
  get = (url: string) => this.send('get', url);
  post = (url: string, body?: object) => this.send('post', url, body ?? {});
  patch = (url: string, body: object) => this.send('patch', url, body);
  put = (url: string, body: object) => this.send('put', url, body);

  async login(email: string, password = PASSWORD, remember = false) {
    return this.post('/auth/login', { email, password, remember });
  }
}

export async function loggedIn(t: TestApp, email: string): Promise<Client> {
  const c = t.client();
  const res = await c.login(email);
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

export function cookieValue(res: Response, name: string): string | undefined {
  const list = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found?.split(';')[0]?.slice(name.length + 1);
}

/** 2026-10-05 is a Monday; 07:00Z is 10:00 in Beirut (UTC+3 until the end of October). */
export const NOW = new Date('2026-10-05T07:00:00Z');
export const TODAY = '2026-10-05';
export const TOMORROW = '2026-10-06'; // Tuesday

export interface Seed {
  clinicId: number;
  /** Dr Aya: an owner doctor assigned to the clinic, with her own dental unit. */
  doctorId: number;
  unitId: number;
  /** Dr Sara: another owner, with her own unit. */
  saraId: number;
  saraUnitId: number;
  /** An external doctor (30% commission) assigned to the clinic. */
  externalDoctorId: number;
  /** An external doctor NOT assigned to any clinic. */
  floatingDoctorId: number;
  patientId: number;
  otherPatientId: number;
  categoryIds: number[];
  toothIds: number[];
  patientUserId: number;
}

/** One clinic, two owner doctors with a unit each, two external doctors, two patients. */
export async function seedClinic(t: TestApp): Promise<Seed> {
  const now = '2026-01-01 00:00:00';
  const db = t.db;
  const stamp = { created_at: now, updated_at: now };
  const [clinicId] = await db('clinics').insert({ name: 'Test Clinic', ...stamp });

  const doctor = async (fname: string, lname: string, kind: 'owner' | 'external', extra: object = {}) =>
    (await db('doctors').insert({ fname, lname, kind, commission_percent: kind === 'external' ? 30 : null, ...extra, ...stamp }))[0]!;
  const doctorId = await doctor('Aya', 'Ghali', 'owner', { speciality: 'General', email: 'aya@clinic.test', phone: '111' });
  const saraId = await doctor('Sara', 'Doughan', 'owner');
  const externalDoctorId = await doctor('Rabih', 'Ghoul', 'external');
  const floatingDoctorId = await doctor('Float', 'Doc', 'external', { commission_percent: 40 });

  for (const id of [doctorId, saraId, externalDoctorId]) {
    await db('clinic_doctor').insert({ clinic_id: clinicId, doctor_id: id, dr_part: 100, ...stamp });
  }
  const unit = async (owner: number, name: string) =>
    (await db('dental_units').insert({ clinic_id: clinicId, owner_doctor_id: owner, name, ...stamp }))[0]!;
  const unitId = await unit(doctorId, "Dr Aya's unit");
  const saraUnitId = await unit(saraId, "Dr Sara's unit");

  // The doctor login is Dr Aya's. A doctor login with no linked profile sees nothing, by design.
  const doctorUser = await db('users').where({ email: 'doctor@clinic.test' }).first();
  if (doctorUser) await db('doctors').where({ id: doctorId }).update({ user_id: doctorUser.id });

  const patientUser = await db('users').where({ email: 'patient@clinic.test' }).first();
  const [patientId] = await db('patients').insert({ patient_identifier: '100001', fname: 'Pat', lname: 'Patient', phone: '70111111', user_id: patientUser.id, doctor_id: doctorId, description: 'secret note', ...stamp });
  const [otherPatientId] = await db('patients').insert({ patient_identifier: '100002', fname: 'Olga', lname: 'Other', phone: '70222222', ...stamp });

  const categoryIds: number[] = [];
  for (const name of ['Scaling', 'Crown']) categoryIds.push((await db('categories').insert({ name, price_min: 10, price_max: 20, ...stamp }))[0]!);
  const toothIds: number[] = [];
  const teeth: [string, string][] = [['18', 'Molar 18'], ['17', 'Molar 17']];
  for (const [index, name] of teeth) toothIds.push((await db('teeth').insert({ index, name, type: 'Molar', ...stamp }))[0]!);

  return {
    clinicId: clinicId!, doctorId, unitId, saraId, saraUnitId, externalDoctorId, floatingDoctorId,
    patientId: patientId!, otherPatientId: otherPatientId!, categoryIds, toothIds, patientUserId: patientUser.id,
  };
}
