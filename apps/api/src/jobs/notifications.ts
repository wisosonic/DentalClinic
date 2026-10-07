import cron from 'node-cron';
import type { AppContext } from '../context';
import { clinicNow, toMinutes } from '../lib/time';
import { commissionStatement } from '../modules/finance/commission';
import { adminUserIds, doctorUserIds, notify, primaryDoctorUserIds, staffUserIds } from '../modules/notifications/service';
import { notificationSwitches } from '../modules/settings/app';

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

/** How long before an appointment its reminder goes out. */
export const REMINDER_MINUTES = 120;

/**
 * Reminds the appointment's doctor and the staff of every confirmed appointment that starts within the next two
 * hours. Safe to run as often as you like: a person is told once per appointment time (rescheduling it earns
 * a new reminder). Returns how many notifications were created.
 */
export async function runReminders(ctx: AppContext): Promise<number> {
  const { db, env } = ctx;
  if (!(await notificationSwitches(db)).reminders) return 0;
  const now = clinicNow(env, ctx.clock());
  const rows: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id')
    .whereNull('a.deleted_at').whereNull('p.deleted_at').where('a.status', 'confirmed').whereBetween('a.date', [now.date, addDays(now.date, 1)])
    .select('a.id', 'a.date', 'a.time', 'a.doctor_id', 'p.fname', 'p.lname', 'd.fname as d_fname', 'd.lname as d_lname');
  const staff = await staffUserIds(db);
  let told = 0;
  for (const a of rows) {
    const left = minutesUntil(now, a.date, a.time);
    if (left <= 0 || left > REMINDER_MINUTES) continue;
    told += await notify(ctx, {
      userIds: [...(await doctorUserIds(db, a.doctor_id)), ...staff], type: 'appointment.reminder',
      title: `Appointment at ${a.time}`, content: `${a.fname} ${a.lname} with Dr ${a.d_fname} ${a.d_lname} at ${a.time} today.`.replace('today', a.date === now.date ? 'today' : 'tomorrow'),
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

/** Days a specialist may owe an owner commission before the owner and the admins are reminded. */
export const COMMISSION_OVERDUE_DAYS = 30;

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Commission is overdue when a specialist still owes an owner something, the oldest money he collected for that
 * owner is more than 30 days old, and he has paid that owner nothing for 30 days. The owner and the admins are
 * reminded, once a month for as long as it lasts. A line with no percentage set (nothing can be worked out) or
 * no owner to pay (the admins sort it out) is left to the statement's own warnings.
 */
export async function runCommissionOverdue(ctx: AppContext): Promise<number> {
  const { db, env } = ctx;
  if (!(await notificationSwitches(db)).events) return 0;
  const today = clinicNow(env, ctx.clock()).date;
  const statement = await commissionStatement(db, undefined, undefined);
  const admins = await adminUserIds(db);
  let told = 0;
  for (const l of statement.rows) {
    if (l.balance === null || l.balance <= 0.004 || !l.oldestCollected || !l.ownerId || !l.owner) continue;
    if (daysBetween(l.oldestCollected, today) <= COMMISSION_OVERDUE_DAYS) continue;
    if (l.lastReceived && daysBetween(l.lastReceived, today) <= COMMISSION_OVERDUE_DAYS) continue;
    told += await notify(ctx, {
      userIds: [...admins, ...(await doctorUserIds(db, l.ownerId))], type: 'commission.overdue', title: 'Commission overdue',
      content: `Dr ${l.specialist.fname} ${l.specialist.lname} still owes Dr ${l.owner.fname} ${l.owner.lname} $${l.balance.toFixed(2)} in commission.`,
      link: '/commission', dedupeKey: `commission:${l.specialist.id}:${l.ownerId}:${today.slice(0, 7)}`,
    });
  }
  return told;
}

/**
 * A treatment offer the patient accepted, whose start date has come, with work still to book and nothing booked:
 * the staff (who book the visits) and the patient's doctor are told once per next item. An offer with no start
 * date, or with a visit already booked, is left alone.
 */
export async function runOfferVisitsDue(ctx: AppContext): Promise<number> {
  const { db, env } = ctx;
  if (!(await notificationSwitches(db)).events) return 0;
  const today = clinicNow(env, ctx.clock()).date;
  const offers: Row[] = await db('treatment_offers as q').join('patients as p', 'p.id', 'q.patient_id')
    .whereNull('q.deleted_at').whereNull('p.deleted_at').where('q.status', 'accepted').whereNotNull('q.start_date').where('q.start_date', '<=', today)
    .select('q.id', 'q.title', 'q.patient_id', 'p.fname', 'p.lname');
  if (!offers.length) return 0;
  const items: Row[] = await db('offer_items').whereIn('offer_id', offers.map((o) => o.id)).orderBy([{ column: 'sequence' }, { column: 'id' }]).select('id', 'offer_id', 'description', 'status');
  const staff = await staffUserIds(db);
  let told = 0;
  for (const offer of offers) {
    const mine = items.filter((i) => i.offer_id === offer.id);
    if (mine.some((i) => i.status === 'scheduled')) continue; // a visit is already on its way
    const next = mine.find((i) => i.status === 'pending');
    if (!next) continue;
    told += await notify(ctx, {
      userIds: [...staff, ...(await primaryDoctorUserIds(db, offer.patient_id))], type: 'offer.visit_due', title: 'Visit to book',
      content: `${offer.fname} ${offer.lname}: “${next.description}” in “${offer.title}” has no visit booked.`,
      link: `/treatment-offers/${offer.id}`, dedupeKey: `offer:${offer.id}:due:${next.id}`,
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
    cron.schedule('*/15 * * * *', run('offer-visits-due', () => runOfferVisitsDue(ctx))),
    cron.schedule('0 * * * *', run('commission-overdue', () => runCommissionOverdue(ctx))),
  ];
  return { stop: () => tasks.forEach((t) => t.stop()) };
}
