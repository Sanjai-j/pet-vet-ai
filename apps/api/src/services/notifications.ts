import { EventEmitter } from 'node:events';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { getDb, id } from '../db.js';
import { config } from '../config.js';

export const notificationEvents = new EventEmitter();

export interface NotificationInput {
  userId: string;
  title: string;
  body: string;
  kind?: string;
  link?: string | null;
}

let mailer: nodemailer.Transporter | null | undefined;

function getMailer(): nodemailer.Transporter | null {
  if (mailer !== undefined) return mailer;
  if (!config.smtp.host) {
    mailer = null;
    return mailer;
  }
  mailer = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return mailer;
}

let vapidReady = false;
function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!config.push.publicKey || !config.push.privateKey) return false;
  try {
    webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    vapidReady = true;
    return true;
  } catch (err) {
    console.warn('[push] invalid VAPID keys; push disabled', err);
    return false;
  }
}

export async function createNotification(input: NotificationInput) {
  const db = await getDb();
  const notificationId = id();
  await db.query(
    `INSERT INTO notifications (id, user_id, title, body, kind, link)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [notificationId, input.userId, input.title, input.body, input.kind ?? 'info', input.link ?? null],
  );
  const row = await db.query(
    `SELECT id, title, body, kind, link, read_at AS "readAt", created_at AS "createdAt"
     FROM notifications WHERE id = $1`,
    [notificationId],
  );
  const notification = row[0];
  notificationEvents.emit('notification', { userId: input.userId, notification });
  return notification;
}

/** Returns whether the email was actually accepted by a configured SMTP server. */
export async function sendEmail(to: string, subject: string, text: string): Promise<{ delivered: boolean; reason?: string }> {
  const transport = getMailer();
  if (!transport) return { delivered: false, reason: 'smtp_not_configured' };
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, text });
    return { delivered: true };
  } catch (err) {
    console.warn('[email] delivery failed', (err as Error).message);
    return { delivered: false, reason: 'smtp_delivery_failed' };
  }
}

export async function sendPush(
  userId: string,
  payload: { title: string; body: string; link?: string | null },
): Promise<{ delivered: number; reason?: string }> {
  if (!ensureVapid()) return { delivered: 0, reason: 'vapid_not_configured' };
  const db = await getDb();
  const subs = await db.query<{ id: string; endpoint: string; keys: unknown }>(
    'SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
        JSON.stringify(payload),
      );
      delivered += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      }
    }
  }
  return { delivered, reason: delivered ? undefined : 'no_active_subscriptions' };
}

export async function savePushSubscription(userId: string, endpoint: string, keys: unknown) {
  const db = await getDb();
  await db.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, keys)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
    [id(), userId, endpoint, JSON.stringify(keys)],
  );
}
