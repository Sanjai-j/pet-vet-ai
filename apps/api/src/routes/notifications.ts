import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { savePushSubscription } from '../services/notifications.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === '1';
    const rows = await many(
      `SELECT id, title, body, kind, link, read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    const unread = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.user!.id],
    );
    res.json({ notifications: rows, unread: Number(unread?.n ?? 0) });
  }),
);

notificationsRouter.patch(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const updated = await db.query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.id],
    );
    if (!updated.length) throw notFound('Notification not found');
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    await (await getDb()).query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [req.user!.id],
    );
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/notifications/push-subscription',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(5) }),
      }),
      req.body,
    );
    await savePushSubscription(req.user!.id, body.endpoint, body.keys);
    res.status(201).json({ ok: true });
  }),
);

notificationsRouter.get(
  '/reminders',
  asyncHandler(async (req, res) => {
    const rows = await many(
      `SELECT r.id, r.kind, r.title, r.scheduled_for AS "scheduledFor", r.status,
              r.channel, r.sent_at AS "sentAt", p.name AS "petName", r.pet_id AS "petId"
       FROM reminders r LEFT JOIN pets p ON p.id = r.pet_id
       WHERE r.user_id = $1 ORDER BY r.scheduled_for DESC LIMIT 50`,
      [req.user!.id],
    );
    res.json({ reminders: rows });
  }),
);

export const personalRouter = notificationsRouter;
