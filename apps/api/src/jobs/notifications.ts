import cron from 'node-cron';
import type { AppContext } from '../context';
import { clinicNow, toMinutes } from '../lib/time';
import { adminUserIds, doctorUserIds, notify, patientUserIds, staffUserIds } from '../modules/notifications/service';
import { notificationSwitches } from '../modules/settings/app';
import { operating } from '../modules/settings/operating';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** 'YYYY-MM-DD' plus days, in UTC so daylight saving never shifts it. */
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Minutes between two clinic-local moments: `a` is a date and minutes into that day. */
const minutesUntil = (now: { date: string; minutes: number }, date: string, time: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.date}T00:00:00Z`)) / 60000) + toMinutes(time) - now.minutes;


/**
 * Reminds the appointment's doctor and the staff of every confirmed appointment that starts within the next two
 * hours. Safe to run as often as you like: a person is told once per appointment time (rescheduling it earns
 * a new reminder). Returns how many notifications were created.
 */
export async function runReminders(ctx: AppContext): Promise<number> {
  const { db, env } = ctx;
  if (!(await notificationSwitches(db)).reminders) return 0;
  // How far ahead each reminder goes out is the clinic's choice (Settings > Appointments).
  const lead = (await operating(ctx)).appointments;
  const REMINDER_MINUTES = lead.staffReminderMinutes;
  const PATIENT_REMINDER_MINUTES = lead.patientReminderHours * 60;
  const now = clinicNow(env, ctx.clock());
  const lookAheadDays = Math.ceil(Math.max(REMINDER_MINUTES, PATIENT_REMINDER_MINUTES) / 1440) + 1;
  const rows: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id')
    .whereNull('a.deleted_at').whereNull('p.deleted_at').where('a.status', 'confirmed').whereBetween('a.date', [now.date, addDays(now.date, lookAheadDays)])
    .select('a.id', 'a.date', 'a.time', 'a.doctor_id', 'a.patient_id', 'p.fname', 'p.lname', 'd.fname as d_fname', 'd.lname as d_lname');
  const staff = await staffUserIds(db);
  let told = 0;
  for (const a of rows) {
    const left = minutesUntil(now, a.date, a.time);
    if (left > 0 && left <= PATIENT_REMINDER_MINUTES) {
      told += await notify(ctx, {
        userIds: await patientUserIds(db, a.patient_id), type: 'appointment.reminder', title: 'Appointment reminder',
        content: `You have an appointment with Dr ${a.d_fname} ${a.d_lname} ${a.date === now.date ? 'today' : a.date === addDays(now.date, 1) ? 'tomorrow' : `on ${a.date}`} at ${a.time}. To cancel it online, do it at least ${lead.cancelMinHours} hours ahead.`,
        link: '/my/appointments', appointmentId: a.id, dedupeKey: `appt:${a.id}:patient:${a.date}T${a.time}`,
      });
    }
    if (left <= 0 || left > REMINDER_MINUTES) continue;
    told += await notify(ctx, {
      userIds: [...(await doctorUserIds(db, a.doctor_id)), ...staff], type: 'appointment.reminder',
      title: `Appointment at ${a.time}`, content: `${a.fname} ${a.lname} with Dr ${a.d_fname} ${a.d_lname} at ${a.time} today.`.replace('today', a.date === now.date ? 'today' : a.date === addDays(now.date, 1) ? 'tomorrow' : `on ${a.date}`),
      link: '/appointments', appointmentId: a.id, dedupeKey: `appt:${a.id}:2h:${a.date}T${a.time}`,
    });
  }
  return told;
}

/** Tells staff and admins about lab orders past their due date that have not come back (once per order and due date). */
export async function runOverdueLabs(ctx: AppContext): Promise<number> {
  const { db, env } = ctx;
  if (!(await notificationSwitches(db)).events) return 0;
  const today = clinicNow(env, ctx.clock()).date;
  const rows: Row[] = await db('lab_orders as o').join('patients as p', 'p.id', 'o.patient_id').join('labs as l', 'l.id', 'o.lab_id')
    .whereNull('o.deleted_at').whereNull('p.deleted_at').where('o.due_at', '<', today).whereIn('o.status', ['draft', 'sent'])
    .select('o.id', 'o.item', 'o.due_at', 'l.name as lab', 'p.fname', 'p.lname');
  if (!rows.length) return 0;
  const people = [...(await staffUserIds(db)), ...(await adminUserIds(db))];
  let told = 0;
  for (const o of rows) {
    told += await notify(ctx, {
      userIds: people, type: 'lab.overdue', title: 'Lab order overdue', content: `${o.item} for ${o.fname} ${o.lname} from ${o.lab} was due on ${o.due_at}.`,
      link: '/lab-orders?overdue=1', dedupeKey: `lab:${o.id}:overdue:${o.due_at}`,
    });
  }
  return told;
}

/**
 * Starts the schedule: every 15 minutes, reminders, overdue lab orders and offer visits to book; every hour, overdue commission. Run it from one process only (with
 * several API servers, run it on a single worker): the keys keep a second run harmless but wasteful.
 */
export function startNotificationJobs(ctx: AppContext): { stop: () => void } {
  const run = (name: string, job: () => Promise<number>) => async () => {
    try {
      const told = await job();
      if (told) ctx.logger.info({ job: name, told }, 'notifications created');
    } catch (err) {
      ctx.logger.error({ err, job: name }, 'notification job failed');
    }
  };
  const tasks = [
    cron.schedule('*/15 * * * *', run('reminders', () => runReminders(ctx))),
    cron.schedule('*/15 * * * *', run('overdue-labs', () => runOverdueLabs(ctx))),
  ];
  return { stop: () => tasks.forEach((t) => t.stop()) };
}
