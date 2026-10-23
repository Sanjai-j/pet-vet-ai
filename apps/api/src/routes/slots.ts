import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth, requireVet } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';

export const slotsRouter = Router();
slotsRouter.use(requireAuth);

/**
 * GET /slots?vetId=&from=&to=
 * Public-to-authenticated: list a verified vet's open slots.
 */
slotsRouter.get(
  '/slots',
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        vetId: z.string().min(1),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.query,
    );
    const vet = await one<{ verification_status: string }>(
      'SELECT verification_status FROM vet_profiles WHERE user_id = $1',
      [query.vetId],
    );
    if (!vet || vet.verification_status !== 'verified') {
      throw notFound('Verified veterinarian not found');
    }
    const slots = await many(
      `SELECT id, to_char(slot_date, 'YYYY-MM-DD') AS "slotDate", start_time AS "startTime", end_time AS "endTime",
              consultation_type AS "consultationType", status
       FROM vet_slots
       WHERE vet_user_id = $1 AND status = 'available'
         AND slot_date >= COALESCE($2::date, current_date)
         AND slot_date <= COALESCE($3::date, current_date + 21)
         -- Slots that already started today are not bookable, so hide them.
         AND (slot_date > current_date OR start_time::time > (now() AT TIME ZONE $4::text)::time)
       ORDER BY slot_date, start_time LIMIT 120`,
      [query.vetId, query.from ?? null, query.to ?? null, config.timezone],
    );
    res.json({ slots });
  }),
);

/**
 * GET /vet/slots  — the vet's own full calendar.
 */
slotsRouter.get(
  '/vet/slots',
  requireVet,
  asyncHandler(async (req, res) => {
    const slots = await many(
      `SELECT s.id, to_char(s.slot_date, 'YYYY-MM-DD') AS "slotDate", s.start_time AS "startTime",
              s.end_time AS "endTime", s.consultation_type AS "consultationType", s.status,
              a.pet_id AS "appointmentPetId", a.status AS "appointmentStatus"
       FROM vet_slots s LEFT JOIN appointments a ON a.id = s.appointment_id
       WHERE s.vet_user_id = $1 AND s.slot_date >= current_date - 1
       ORDER BY s.slot_date, s.start_time LIMIT 300`,
      [req.user!.id],
    );
    res.json({ slots });
  }),
);

/**
 * POST /vet/slots — create availability. Idempotent per (date, start, type).
 */
slotsRouter.post(
  '/vet/slots',
  requireVet,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        slots: z
          .array(
            z.object({
              slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              consultationType: z.enum(['in_person', 'video', 'chat']).default('in_person'),
            }),
          )
          .min(1)
          .max(60),
      }),
      req.body,
    );
    const db = await getDb();
    let created = 0;
    let skipped = 0;
    for (const s of body.slots) {
      if (s.endTime <= s.startTime) {
        throw badRequest(`End time must be after start time for the ${s.slotDate} ${s.startTime} slot.`);
      }
      const existing = await one<{ id: string }>(
        `SELECT id FROM vet_slots WHERE vet_user_id = $1 AND slot_date = $2 AND start_time = $3`,
        [req.user!.id, s.slotDate, s.startTime],
      );
      if (existing) {
        skipped += 1;
        continue;
      }
      await db.query(
        `INSERT INTO vet_slots (id, vet_user_id, slot_date, start_time, end_time, consultation_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [crypto.randomUUID(), req.user!.id, s.slotDate, s.startTime, s.endTime, s.consultationType],
      );
      created += 1;
    }
    await audit(req.user!.id, 'vet.slots_create', 'vet_slot', req.user!.id, { created, skipped });
    res.status(201).json({ created, skipped });
  }),
);

/**
 * DELETE /vet/slots/:id — remove an unbooked slot.
 */
slotsRouter.delete(
  '/vet/slots/:id',
  requireVet,
  asyncHandler(async (req, res) => {
    const slot = await one<{ vet_user_id: string; status: string }>(
      'SELECT vet_user_id, status FROM vet_slots WHERE id = $1',
      [req.params.id],
    );
    if (!slot) throw notFound('Slot not found');
    if (slot.vet_user_id !== req.user!.id) throw forbidden();
    if (slot.status === 'booked') {
      throw badRequest('Cancel the appointment first — this slot is booked.');
    }
    await (await getDb()).query('DELETE FROM vet_slots WHERE id = $1', [req.params.id]);
    res.status(204).send();
  }),
);
