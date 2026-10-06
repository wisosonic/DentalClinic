import { EventEmitter } from 'node:events';
import type { NotificationDto, NotificationType } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { notificationSwitches } from '../settings/app';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

export interface NewNotification {
  userIds: number[];
  type: NotificationType;
  title: string;
  content: string;
  /** A path inside the app. */
  link?: string;
  appointmentId?: number;
  /** Makes it safe to ask twice: the same key for the same person is stored once. */
  dedupeKey?: string;
}

/**
 * Where a notification goes. In-app is the only channel; email, SMS or WhatsApp can be added later as another
 * implementation, without touching the code that decides who is told what.
 */
export interface NotificationChannel {
  deliver(db: Db, userId: number, notification: NewNotification): Promise<NotificationDto | null>;
}

export const toDto = (r: Row): NotificationDto => ({
  id: r.id, type: r.type ?? null, title: r.title, content: r.content, link: r.link ?? null,
  status: r.status === 'read' ? 'read' : 'unread', createdAt: r.created_at ?? null, readAt: r.read_at ?? null,
});

/** One live connection per open page: the stream route listens here, and new notifications are announced here. */
export const notificationBus = new EventEmitter();
notificationBus.setMaxListeners(0);

/** The in-app notification list (the `notifications` table), announced to open pages as it grows. */
export const inAppChannel: NotificationChannel = {
  async deliver(db, userId, n) {
    const key = n.dedupeKey ? `${n.dedupeKey}:u${userId}` : null;
    if (key && (await db('notifications').where({ dedupe_key: key }).first('id'))) return null; // already told
    const now = sqlNow();
    const [id] = await db('notifications').insert({
      title: n.title.slice(0, 255), content: n.content.slice(0, 255), status: 'unread', type: n.type, link: n.link ?? null,
      dedupe_key: key, user_id: userId, appointment_id: n.appointmentId ?? null, created_at: now, updated_at: now,
    });
    const dto = toDto(await db('notifications').where({ id }).first());
    notificationBus.emit(`user:${userId}`, dto);
    return dto;
  },
};

const CHANNELS: NotificationChannel[] = [inAppChannel];

/** Tells these people, once each. Returns how many were told. Never throws: a failed notification must not fail the request. */
export async function notify(ctx: AppContext, n: NewNotification): Promise<number> {
  let told = 0;
  try {
    for (const userId of [...new Set(n.userIds)]) {
      for (const channel of CHANNELS) if (await channel.deliver(ctx.db, userId, n)) told += 1;
    }
  } catch (err) {
    ctx.logger.error({ err, type: n.type }, 'notification failed');
  }
  return told;
}

// ----- who to tell -----------------------------------------------------------

const idsOf = (rows: Row[]) => rows.map((r) => r.id as number);

export const staffUserIds = async (db: Db): Promise<number[]> => idsOf(await db('users').where({ role: 'staff', is_active: true }).select('id'));
export const adminUserIds = async (db: Db): Promise<number[]> => idsOf(await db('users').where({ role: 'admin', is_active: true }).select('id'));

/** The login of a doctor (none if the doctor has no linked login, or it is switched off). */
export async function doctorUserIds(db: Db, doctorId: number | null | undefined): Promise<number[]> {
  if (!doctorId) return [];
  const row = await db('doctors as d').join('users as u', 'u.id', 'd.user_id').where({ 'd.id': doctorId, 'u.is_active': true }).first('u.id');
  return row ? [row.id as number] : [];
}

/** The login of the patient's primary doctor. */
export async function primaryDoctorUserIds(db: Db, patientId: number): Promise<number[]> {
  const p = await db('patients').where({ id: patientId }).first('doctor_id');
  return doctorUserIds(db, p?.doctor_id);
}

// ----- events ----------------------------------------------------------------

export interface EventNotification extends Omit<NewNotification, 'userIds'> {
  /** The person who did it: they are not told about their own action. */
  actorId?: number | null;
  recipients: () => Promise<number[]>;
}

/** An event (a booking, a payment...): told to its recipients unless an admin switched event notifications off. */
export async function emitEvent(ctx: AppContext, e: EventNotification): Promise<void> {
  try {
    if (!(await notificationSwitches(ctx.db)).events) return;
    const userIds = (await e.recipients()).filter((id) => id !== e.actorId);
    if (userIds.length) await notify(ctx, { ...e, userIds });
  } catch (err) {
    ctx.logger.error({ err, type: e.type }, 'notification failed');
  }
}
