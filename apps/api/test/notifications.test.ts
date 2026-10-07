import http from 'node:http';
import { pino } from 'pino';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runOverdueLabs, runReminders } from '../src/jobs/notifications';
import { notificationBus } from '../src/modules/notifications/service';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * In-app notifications (owner rules, 2026-10-05): a reminder two hours before a confirmed appointment to the
 * treating doctor and the staff; events for bookings and cancellations, offers and payments, overdue lab
 * orders; nobody is told about their own action; both kinds can be switched off.
 * NOW is 2026-10-05 07:00 UTC = 10:00 in Beirut.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client;
let ayaUser: number, adminUser: number, staffUser: number, extUser: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
  const id = async (email: string) => (await t.db('users').where({ email }).first('id')).id as number;
  [ayaUser, adminUser, staffUser, extUser] = await Promise.all([id('doctor@clinic.test'), id('admin@clinic.test'), id('staff@clinic.test'), id('ext@clinic.test')]);
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['notifications', 'payments', 'offer_items', 'treatment_offers', 'lab_orders', 'appointment_category', 'appointment_tooth', 'appointments', 'app_settings']) await t.db(table).del();
});

const ctx = () => ({ db: t.db, env: t.env, logger: pino({ level: 'silent' }), clock: () => NOW });
const types = async (userId: number) => (await t.db('notifications').where({ user_id: userId }).orderBy('id')).map((n) => n.type);
const book = (c: Client, extra: object = {}) => c.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', durationMinutes: 30, ...extra });
const visit = async (time: string, status = 'confirmed', date = TODAY, doctor = s.doctorId) =>
  (await t.db('appointments').insert({ date, time, status, patient_id: s.patientId, doctor_id: doctor, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }))[0]!;

describe('reminders, two hours before', () => {
  it('go to the treating doctor and the staff, for a confirmed appointment starting within two hours', async () => {
    const a = await visit('11:30'); // 90 minutes from now
    expect(await runReminders(ctx())).toBe(3); // the doctor, the staff and (a day ahead is the patient's own reminder) the patient
    expect(await types(ayaUser)).toEqual(['appointment.reminder']);
    expect(await types(staffUser)).toEqual(['appointment.reminder']);
    expect(await types(adminUser)).toEqual([]);
    expect(await types(extUser)).toEqual([]); // another doctor's appointment
    expect(await types(s.patientUserId)).toEqual(['appointment.reminder']);
    const n = await t.db('notifications').where({ user_id: staffUser }).first();
    expect(n).toMatchObject({ link: '/appointments', appointment_id: a, status: 'unread' });
    expect(n.content).toContain('Pat Patient');
    expect(n.content).toContain('11:30');
  });

  it('are not sent too early, too late, or for an appointment that is not confirmed or was deleted', async () => {
    await visit('12:30'); // 150 minutes away: not yet
    await visit('09:30'); // already started
    await visit('11:00', 'pending');
    await visit('11:15', 'cancelled');
    const gone = await visit('11:45');
    await t.db('appointments').where({ id: gone }).update({ deleted_at: '2026-10-05 05:00:00' });
    expect(await runReminders(ctx())).toBe(1); // only the patient's day-ahead reminder for the 12:30 one: nobody at the clinic yet
    expect(await types(ayaUser)).toEqual([]);
    expect(await types(staffUser)).toEqual([]);
  });

  it('are sent once however often the job runs, and again if the appointment is moved', async () => {
    const a = await visit('11:30');
    await runReminders(ctx());
    expect(await runReminders(ctx())).toBe(0);
    expect(await t.db('notifications').count({ n: '*' }).first()).toMatchObject({ n: 3 });
    await t.db('appointments').where({ id: a }).update({ time: '11:45' }); // rescheduled
    expect(await runReminders(ctx())).toBe(3);
  });

  it('include an appointment just after midnight when it is late in the evening', async () => {
    const late = { ...ctx(), clock: () => new Date('2026-10-05T20:30:00Z') }; // 23:30 in Beirut
    await visit('00:45', 'confirmed', TOMORROW);
    expect(await runReminders(late)).toBe(3);
  });

  it('stop when an admin switches reminders off', async () => {
    await visit('11:30');
    await admin.put('/settings/general', { language: 'en', timezone: 'Asia/Beirut', clinic: {}, notifications: { reminders: false, events: true } });
    expect(await runReminders(ctx())).toBe(0);
    await admin.put('/settings/general', { language: 'en', timezone: 'Asia/Beirut', clinic: {}, notifications: { reminders: true, events: true } });
    expect(await runReminders(ctx())).toBe(3);
  });
});

describe('the patient’s own reminder, a day ahead', () => {
  it('goes to the patient a day before a confirmed appointment, once, in words they can read, with a way to cancel', async () => {
    const a = await visit('09:00', 'confirmed', TOMORROW); // 23 hours from now
    expect(await runReminders(ctx())).toBe(1);
    expect(await types(s.patientUserId)).toEqual(['appointment.reminder']);
    expect(await types(ayaUser)).toEqual([]); // the doctor's own reminder is two hours ahead
    const n = await t.db('notifications').where({ user_id: s.patientUserId }).first();
    expect(n).toMatchObject({ link: '/my/appointments', appointment_id: a });
    expect(n.content).toBe('You have an appointment with Dr Aya Ghali tomorrow at 09:00. To cancel it online, do it at least 24 hours ahead.');
    expect(await runReminders(ctx())).toBe(0); // once
    await t.db('appointments').where({ id: a }).update({ time: '09:15' });
    expect(await runReminders(ctx())).toBe(1); // moved: told again
  });

  it('waits until it is within a day, and skips what is not confirmed, was deleted, or belongs to someone without a login', async () => {
    await visit('11:00', 'confirmed', TOMORROW); // 25 hours away
    await visit('09:00', 'pending', TOMORROW);
    await visit('09:30', 'cancelled', TOMORROW);
    const gone = await visit('10:30', 'confirmed', TOMORROW);
    await t.db('appointments').where({ id: gone }).update({ deleted_at: '2026-10-05 05:00:00' });
    await t.db('appointments').insert({ date: TOMORROW, time: '09:45', status: 'confirmed', patient_id: s.otherPatientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp });
    expect(await runReminders(ctx())).toBe(0);
    await t.db('users').where({ id: s.patientUserId }).update({ is_active: false });
    await visit('09:50', 'confirmed', TOMORROW);
    expect(await runReminders(ctx())).toBe(0); // a login that is switched off is not told
    await t.db('users').where({ id: s.patientUserId }).update({ is_active: true });
  });

  it('follows the reminders switch', async () => {
    await visit('09:00', 'confirmed', TOMORROW);
    await admin.put('/settings/general', { language: 'en', timezone: 'Asia/Beirut', clinic: {}, notifications: { reminders: false, events: true } });
    expect(await runReminders(ctx())).toBe(0);
    await admin.put('/settings/general', { language: 'en', timezone: 'Asia/Beirut', clinic: {}, notifications: { reminders: true, events: true } });
    expect(await runReminders(ctx())).toBe(1);
  });
});

describe('events', () => {
  it('tell staff and the doctor about a booking, but not the person who booked', async () => {
    expect((await book(staff)).status).toBe(201);
    expect(await types(ayaUser)).toEqual(['appointment.booked']);
    expect(await types(staffUser)).toEqual([]); // the actor
    expect((await book(aya, { time: '11:00' })).status).toBe(201);
    expect(await types(staffUser)).toEqual(['appointment.booked']);
    expect(await types(ayaUser)).toEqual(['appointment.booked']); // she booked this one herself
    expect(await types(adminUser)).toEqual([]);
  });

  it('tell staff and the doctor about a cancellation', async () => {
    const id = (await book(staff)).body.appointment.id;
    await t.db('notifications').del();
    expect((await aya.post(`/appointments/${id}/cancel`)).status).toBe(200);
    expect(await types(staffUser)).toEqual(['appointment.cancelled']);
    expect(await types(ayaUser)).toEqual([]);
  });

  it('tell admins and the staff (who book its visits) about a new offer, and admins and the doctor about a payment received', async () => {
    const q = (await aya.post('/treatment-offers', { patientId: s.patientId, title: 'Crown', items: [{ description: 'Crown', price: 300 }] })).body.offer.id as number;
    expect(await types(adminUser)).toEqual(['offer.accepted']);
    expect(await types(staffUser)).toEqual(['offer.accepted']);
    expect(await types(ayaUser)).toEqual([]); // she did it herself
    await staff.post('/payments', { offerId: q, amount: 100, method: 'cash', date: TODAY });
    expect(await types(adminUser)).toEqual(['offer.accepted', 'payment.received']);
    expect(await types(ayaUser)).toEqual(['payment.received']);
    expect(await types(staffUser)).toEqual(['offer.accepted']); // the actor is not told about his own payment
    const made = await t.db('notifications').where({ type: 'offer.accepted', user_id: staffUser }).first();
    expect(made.content).toContain('agreed to');
    expect(made.link).toBe(`/treatment-offers/${q}`);
    const n = await t.db('notifications').where({ type: 'payment.received', user_id: adminUser }).first();
    expect(n.content).toContain('$100.00');
    expect(n.content).toContain('Pat Patient');
  });

  it('tell the doctor and the staff when a draft offer is confirmed (not while it is a draft), and the doctor when its visit is booked', async () => {
    const plan = (await aya.post('/treatment-offers', { patientId: s.patientId, title: 'Rehab', asDraft: true, items: [{ description: 'Crown', price: 100 }] })).body.offer;
    expect(await types(staffUser)).toEqual([]);
    await admin.post(`/treatment-offers/${plan.id}/accept`);
    expect(await types(ayaUser)).toEqual(['offer.accepted']);
    expect(await types(staffUser)).toEqual(['offer.accepted']);
    await t.db('notifications').del();
    await staff.post(`/treatment-offers/${plan.id}/items/${plan.items[0].id}/schedule`, { doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', durationMinutes: 30 });
    expect(await types(ayaUser)).toEqual(['appointment.booked']);
  });

  it('tell staff and admins about an overdue lab order once', async () => {
    const [lab] = await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp });
    await t.db('lab_orders').insert({ lab_id: lab, patient_id: s.patientId, item: 'Zirconia crown', cost: 10, currency: '$', due_at: '2026-10-01', status: 'sent', ...stamp });
    await t.db('lab_orders').insert({ lab_id: lab, patient_id: s.patientId, item: 'Not late', cost: 10, currency: '$', due_at: TODAY, status: 'sent', ...stamp });
    await t.db('lab_orders').insert({ lab_id: lab, patient_id: s.patientId, item: 'Back already', cost: 10, currency: '$', due_at: '2026-09-01', status: 'received', ...stamp });
    expect(await runOverdueLabs(ctx())).toBe(3); // one staff and two admins
    expect(await types(staffUser)).toEqual(['lab.overdue']);
    expect(await types(adminUser)).toEqual(['lab.overdue']);
    expect(await types(ayaUser)).toEqual([]);
    expect(await runOverdueLabs(ctx())).toBe(0); // once per order and due date
    const n = await t.db('notifications').where({ user_id: staffUser }).first();
    expect(n.link).toBe('/lab-orders?overdue=1');
    expect(n.content).toContain('Zirconia crown');
    await t.db('lab_orders').del();
    await t.db('labs').where({ id: lab }).del();
  });

  it('stop when an admin switches event notifications off, and a failure never fails the request', async () => {
    await admin.put('/settings/general', { language: 'en', timezone: 'Asia/Beirut', clinic: {}, notifications: { reminders: true, events: false } });
    expect((await book(staff)).status).toBe(201);
    expect(await t.db('notifications').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });
});

describe('the list', () => {
  const seed = async (userId: number, n: number, extra: object = {}) => {
    for (let i = 0; i < n; i++) await t.db('notifications').insert({ title: `T${i}`, content: `C${i}`, status: 'unread', type: 'appointment.booked', user_id: userId, created_at: `2026-10-05 08:0${i}:00`, updated_at: stamp.updated_at, ...extra });
  };

  it('shows a person only their own, newest first, with the unread count', async () => {
    await seed(staffUser, 3);
    await seed(adminUser, 2);
    const r = (await staff.get('/notifications')).body;
    expect(r.data.map((n: { title: string }) => n.title)).toEqual(['T2', 'T1', 'T0']);
    expect(r.unread).toBe(3);
    expect(r.meta.total).toBe(3);
    expect(r.data[0]).toMatchObject({ status: 'unread', type: 'appointment.booked', link: null, readAt: null });
    expect((await admin.get('/notifications')).body.meta.total).toBe(2);
  });

  it('filters by status and pages', async () => {
    await seed(staffUser, 3);
    const first = await t.db('notifications').where({ user_id: staffUser }).orderBy('id').first('id');
    await staff.patch(`/notifications/${first.id}/read`, {});
    expect((await staff.get('/notifications?status=unread')).body.data).toHaveLength(2);
    expect((await staff.get('/notifications?status=read')).body.data).toHaveLength(1);
    expect((await staff.get('/notifications?pageSize=2&page=2')).body.data).toHaveLength(1);
  });

  it('marks one as read, or all, and never touches someone else’s', async () => {
    await seed(staffUser, 2);
    await seed(adminUser, 1);
    const mine = await t.db('notifications').where({ user_id: staffUser }).orderBy('id');
    const res = await staff.patch(`/notifications/${mine[0]!.id}/read`, {});
    expect(res.body.notification).toMatchObject({ status: 'read' });
    expect(res.body.notification.readAt).not.toBeNull();
    const theirs = await t.db('notifications').where({ user_id: adminUser }).first('id');
    expect((await staff.patch(`/notifications/${theirs.id}/read`, {})).status).toBe(404);
    expect((await t.db('notifications').where({ id: theirs.id }).first()).status).toBe('unread');
    expect((await staff.post('/notifications/read-all', {})).status).toBe(204);
    expect((await staff.get('/notifications')).body.unread).toBe(0);
    expect((await admin.get('/notifications')).body.unread).toBe(1);
  });

  it('is closed to visitors', async () => {
    expect((await t.client().get('/notifications')).status).toBe(401);
    expect((await t.client().get('/notifications/stream')).status).toBe(401);
    expect((await patient.get('/notifications')).status).toBe(200); // patients have a list too (empty for now)
  });
});

describe('the live stream', () => {
  /** Opens the stream as this person, over a real socket, and collects what arrives until `done` says enough. */
  async function listen(email: string, headers: Record<string, string> = {}, done: (text: string) => boolean = (x) => x.includes('event: notification')) {
    const server = t.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return new Promise<string>((resolve, reject) => {
      let text = '';
      const finish = () => { req.destroy(); server.close(); resolve(text); };
      const req = http.get({ port, path: '/api/v1/notifications/stream', headers: { cookie, ...headers } }, (res) => {
        if (res.statusCode !== 200) { req.destroy(); server.close(); return reject(new Error(`status ${res.statusCode}`)); }
        res.on('data', (d: Buffer) => {
          text += d.toString();
          if (done(text)) finish();
        });
      });
      req.on('error', () => undefined);
      setTimeout(finish, 4000);
    });
  }

  it('sends a new notification to the person it is for, as it is created', async () => {
    const pending = listen('staff@clinic.test');
    await new Promise((r) => setTimeout(r, 300));
    await book(aya); // staff are told
    const text = await pending;
    expect(text).toContain(': connected');
    expect(text).toContain('event: notification');
    expect(text).toContain('"type":"appointment.booked"');
    await new Promise((r) => setTimeout(r, 300)); // the server notices the page has gone
    expect(notificationBus.listenerCount(`user:${staffUser}`)).toBe(0); // and stops sending to it
  });

  it('sends what was missed first when a page reconnects with Last-Event-ID', async () => {
    await t.db('notifications').insert([1, 2, 3].map((i) => ({ title: `Missed ${i}`, content: 'c', status: 'unread', type: 'appointment.booked', user_id: staffUser, ...stamp })));
    const rows = await t.db('notifications').where({ user_id: staffUser }).orderBy('id');
    const text = await listen('staff@clinic.test', { 'last-event-id': String(rows[0]!.id) }, (x) => x.includes('Missed 3'));
    expect(text).toContain('Missed 2');
    expect(text).toContain('Missed 3');
    expect(text).not.toContain('Missed 1'); // already seen
  });
});

describe('the follow-up notification (no-show)', () => {
  it('tell the staff and the doctor about a missed appointment, but not the person who marked it', async () => {
    const a = await visit('09:00', 'confirmed', TODAY);
    expect((await staff.post(`/appointments/${a}/no-show`)).status).toBe(200);
    expect(await types(ayaUser)).toEqual(['appointment.no_show']);
    expect(await types(staffUser)).toEqual([]); // he did it himself
    expect(await types(adminUser)).toEqual([]);
    const n = await t.db('notifications').where({ user_id: ayaUser }).first();
    expect(n.content).toContain('missed the appointment');
  });
});

describe('the patient is told about their own appointments', () => {
  it('when the clinic books one, in plain words with a link to their appointments', async () => {
    const res = await book(staff);
    expect(res.status).toBe(201);
    const n = await t.db('notifications').where({ user_id: s.patientUserId, type: 'appointment.booked' }).first();
    expect(n).toMatchObject({ link: '/my/appointments', title: 'Your appointment' });
    expect(n.content).toBe(`Your appointment with Dr Aya Ghali is booked for ${TOMORROW} at 10:00.`);
  });

  it('when the clinic cancels one, but not when the patient cancels it themselves', async () => {
    const first = (await book(staff)).body.appointment.id as number;
    await staff.post(`/appointments/${first}/cancel`);
    const told = await t.db('notifications').where({ user_id: s.patientUserId, type: 'appointment.cancelled' });
    expect(told).toHaveLength(1);
    expect(told[0].content).toContain('was cancelled. Please call the clinic to book another.');

    const second = (await book(staff, { time: '12:00' })).body.appointment.id as number;
    await t.db('notifications').where({ user_id: s.patientUserId }).del();
    expect((await patient.post(`/appointments/${second}/cancel`)).status).toBe(200);
    expect(await types(s.patientUserId)).toEqual([]); // nobody is told about their own action
    expect(await types(staffUser)).toContain('appointment.cancelled'); // the clinic is
  });

  it('not another patient’s, and not a login that is switched off', async () => {
    await book(staff, { patientId: s.otherPatientId });
    expect(await types(s.patientUserId)).toEqual([]);
    await t.db('users').where({ id: s.patientUserId }).update({ is_active: false });
    await book(staff, { time: '14:00' });
    expect(await types(s.patientUserId)).toEqual([]);
    await t.db('users').where({ id: s.patientUserId }).update({ is_active: true });
  });
});

describe('the patient’s own list', () => {
  it('shows a patient only their own notifications, and lets them mark them read', async () => {
    await visit('09:00', 'confirmed', TOMORROW);
    await visit('11:30'); // today: the staff and the doctor are reminded too
    await runReminders(ctx());
    const mine = (await patient.get('/notifications')).body;
    expect(mine.data.map((n: { link: string }) => n.link)).toEqual(['/my/appointments', '/my/appointments']); // a day-ahead reminder for each, in their own words
    expect(mine.unread).toBe(2);
    expect(mine.data[0].link).toBe('/my/appointments');
    expect((await staff.get('/notifications')).body.data.some((n: { link: string }) => n.link === '/my/appointments')).toBe(false); // never the patient's
    expect((await patient.agent.patch(`/api/v1/notifications/${mine.data[0].id}/read`).set('x-csrf-token', patient.csrf)).status).toBe(200);
    expect((await patient.get('/notifications')).body.unread).toBe(1);
    const staffNote = (await staff.get('/notifications')).body.data[0];
    expect((await patient.agent.patch(`/api/v1/notifications/${staffNote.id}/read`).set('x-csrf-token', patient.csrf)).status).toBe(404); // someone else's is none
  });
});
