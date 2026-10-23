import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { audit } from '../audit.js';
import { createNotification } from '../services/notifications.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.post(
  '/reports',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        targetType: z.enum(['message', 'ai_message', 'vet_profile', 'user']),
        targetId: z.string().min(1).max(120),
        reason: z.string().min(5).max(2000),
      }),
      req.body,
    );
    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO content_reports (id, reporter_id, target_type, target_id, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.user!.id, body.targetType, body.targetId, body.reason],
    );
    const admins = await many<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND disabled = false`);
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: 'New content report',
        body: body.reason.slice(0, 160),
        kind: 'report',
        link: '/admin',
      });
    }
    await audit(req.user!.id, 'report.create', 'content_report', id, { targetType: body.targetType });
    res.status(201).json({ id, status: 'open' });
  }),
);
