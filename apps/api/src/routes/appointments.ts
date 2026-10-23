import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { assertPetOwner, loadPet } from '../access.js';
import { createNotification } from '../services/notifications.js';
import { audit } from '../audit.js';

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

const appointmentSelect = `
  SELECT a.id, a.owner_id AS "ownerId", a.vet_id AS "vetId", a.pet_id AS "petId",
         a.scheduled_for AS "scheduledFor", a.mode, a.reason, a.status,
         a.response_note AS "responseNote", a.created_at AS "createdAt",
         p.name AS "petName", p.species_code AS "petSpecies",
         owner.full_name AS "ownerName", vet.full_name AS "vetName",
         vp.clinic_name AS "clinicName", vp.consultation_fee_inr AS "feeInr"
  FROM appointments a
  JOIN pets p ON p.id = a.pet_id
  JOIN users owner ON owner.id = a.owner_id
  JOIN users vet ON vet.id = a.vet_id
  LEFT JOIN vet_profiles vp ON vp.user_id = a.vet_id
`;

/**
 * The pg / PGlite drivers hand back `date` columns as JS Date objects, so a
 * plain template interpolation would produce an unparseable string. Normalise
 * either form to `YYYY-MM-DD` before building a timestamp out of it.
 */
function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function slotStart(date: string | Date, startTime: string): string {
  const time = startTime.length === 5 ? `${startTime}:00` : startTime;
  return new Date(`${dateOnly(date)}T${time}`).toISOString();
}

async function loadAppointment(id: string, userId: string, role: string) {
  const appt = await one<Record<string, any>>(`${appointmentSelect} WHERE a.id = $1`, [id]);
  if (!appt) throw notFound('Appointment not found');
  if (role === 'admin') return appt;
  if (appt.ownerId !== userId && appt.vetId !== userId) throw forbidden('This appointment is not yours');
  return appt;
}

appointmentsRouter.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    let where = 'a.owner_id = $1';
    if (user.role === 'vet') where = 'a.vet_id = $1';
    if (user.role === 'admin') where = '1 = 1';
    const rows = await many(
      `${appointmentSelect} WHERE ${where} ORDER BY a.scheduled_for DESC LIMIT 100`,
      user.role === 'admin' ? [] : [user.id],
    );
    res.json({ appointments: rows });
  }),
);

appointmentsRouter.get(
  '/appointments/:id',
  asyncHandler(async (req, res) => {
    const appt = await loadAppointment(req.params.id, req.user!.id, req.user!.role);
    const notes = await many(
      `SELECT n.id, n.notes, n.care_plan AS "carePlan", n.follow_up_on AS "followUpOn",
              n.created_at AS "createdAt", u.full_name AS "vetName"
       FROM consultation_notes n JOIN users u ON u.id = n.vet_id
       WHERE n.appointment_id = $1 ORDER BY n.created_at DESC`,
      [appt.id],
    );
    res.json({ appointment: appt, notes });
  }),
);

appointmentsRouter.post(
  '/appointments',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if (user.role !== 'owner') throw forbidden('Only pet owners can book appointments');
    const body = parse(
      z.object({
        petId: z.string().min(1),
        vetId: z.string().min(1),
        slotId: z.string().optional(),
        scheduledFor: z.string().datetime().optional(),
        mode: z.enum(['in_person', 'video']).default('in_person'),
        reason: z.string().min(5, 'Tell the veterinarian what this is about').max(2000),
        consentToShareRecords: z.boolean().default(false),
      }),
      req.body,
    );
    if (!body.slotId && !body.scheduledFor) {
      throw badRequest('Pick an available time slot or provide a date and time.');
    }
    const pet = await assertPetOwner(body.petId, user);
    const vet = await one<{
      userId: string; verificationStatus: string; species: string[]; fullName: string; email: string;
    }>(
      `SELECT v.user_id AS "userId", v.verification_status AS "verificationStatus", v.species,
              u.full_name AS "fullName", u.email
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.user_id = $1 AND u.disabled = false`,
      [body.vetId],
    );
    if (!vet) throw notFound('Veterinarian not found');
    if (vet.verificationStatus !== 'verified') {
      throw badRequest(
        vet.verificationStatus === 'suspended'
          ? 'This veterinarian’s account is suspended and cannot take new bookings.'
          : vet.verificationStatus === 'rejected'
            ? 'This veterinarian is not approved on Pet Vet AI and cannot take appointments.'
            : 'This veterinarian has not been verified yet and cannot take appointments',
      );
    }
    if (!vet.species.includes(pet.speciesCode)) {
      throw badRequest('This veterinarian does not list your pet’s species in their practice');
    }

    const db = await getDb();
    let scheduledFor = body.scheduledFor ?? null;

    if (body.slotId) {
      // Two owners racing for the same slot are serialised by the conditional
      // UPDATE below (`... AND status = 'available'`), so this read is only
      // used for validation and to work out the appointment time.
      const slot = await one<{
        id: string; vet_user_id: string; slot_date: string | Date; start_time: string;
        end_time: string; consultation_type: string; status: string;
      }>(
        `SELECT id, vet_user_id, slot_date, start_time, end_time, consultation_type, status
         FROM vet_slots WHERE id = $1`,
        [body.slotId],
      );
      if (!slot) throw notFound('That time slot no longer exists. Pick another.');
      if (slot.vet_user_id !== body.vetId) throw badRequest('That slot belongs to a different veterinarian.');
      if (slot.status !== 'available') {
        throw conflict('That slot was just booked. Pick another available time.');
      }
      scheduledFor = slotStart(slot.slot_date, slot.start_time);
      if (new Date(scheduledFor).getTime() < Date.now() - 60_000) {
        throw badRequest('That slot is in the past. Pick a future time.');
      }
    } else if (scheduledFor && new Date(scheduledFor).getTime() < Date.now() - 60_000) {
      throw badRequest('Choose a future date and time');
    }

    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO appointments (id, owner_id, vet_id, pet_id, scheduled_for, mode, reason, slot_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, user.id, body.vetId, pet.id, scheduledFor, body.mode, body.reason, body.slotId ?? null],
    );
    if (body.slotId) {
      const updated = await db.query(
        `UPDATE vet_slots SET status = 'booked', appointment_id = $1
         WHERE id = $2 AND status = 'available'
         RETURNING id`,
        [id, body.slotId],
      );
      if (!updated.length) {
        // Lost the race to another owner: undo the insert rather than
        // leave a booking holding a slot it never claimed.
        await db.query('DELETE FROM appointments WHERE id = $1', [id]);
        throw conflict('That slot was just booked. Pick another available time.');
      }
    }
    await createNotification({
      userId: body.vetId,
      title: `New appointment request — ${pet.name}`,
      body: `${user.fullName}: ${body.reason.slice(0, 120)}`,
      kind: 'appointment',
      link: '/appointments',
    });
    await audit(user.id, 'appointment.create', 'appointment', id, {
      vetId: body.vetId, petId: pet.id, slotId: body.slotId ?? null,
      consentToShareRecords: body.consentToShareRecords,
    });
    res.status(201).json({ appointment: await one(`${appointmentSelect} WHERE a.id = $1`, [id]) });
  }),
);

appointmentsRouter.patch(
  '/appointments/:id/status',
  asyncHandler(async (req, res) => {
    const appt = await loadAppointment(req.params.id, req.user!.id, req.user!.role);
    const body = parse(
      z.object({
        status: z.enum(['accepted', 'rejected', 'completed', 'cancelled']),
        note: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const role = req.user!.role;
    const target = body.status;

    if (role === 'vet') {
      if (appt.vetId !== req.user!.id) throw forbidden();
      if (target === 'accepted' && !['pending', 'rescheduled'].includes(appt.status)) {
        throw badRequest('Only pending requests can be accepted');
      }
      if (target === 'rejected' && !['pending', 'rescheduled'].includes(appt.status)) {
        throw badRequest('Only pending requests can be rejected');
      }
      if (target === 'completed' && appt.status !== 'accepted') throw badRequest('Only accepted appointments can be completed');
      if (target === 'cancelled') throw badRequest('Ask the owner to cancel the appointment');
    } else if (role === 'owner') {
      if (appt.ownerId !== req.user!.id) throw forbidden();
      if (target !== 'cancelled') throw badRequest('Owners can only cancel an appointment');
      if (!['pending', 'accepted', 'rescheduled'].includes(appt.status)) {
        throw badRequest('This appointment cannot be cancelled');
      }
    }

    await (await getDb()).query(
      `UPDATE appointments SET status = $1, response_note = COALESCE($2, response_note), updated_at = now()
       WHERE id = $3`,
      [target, body.note ?? null, appt.id],
    );
    if (['rejected', 'cancelled'].includes(target)) {
      // Release the slot so other owners can book it.
      await (await getDb()).query(
        `UPDATE vet_slots SET status = 'available', appointment_id = NULL WHERE appointment_id = $1`,
        [appt.id],
      );
    }

    if (target === 'accepted') {
      await (await getDb()).query(
        `INSERT INTO threads (id, owner_id, vet_id, pet_id, appointment_id, last_message_at)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (owner_id, vet_id, pet_id)
         DO UPDATE SET appointment_id = COALESCE(threads.appointment_id, excluded.appointment_id)`,
        [crypto.randomUUID(), appt.ownerId, appt.vetId, appt.petId, appt.id],
      );
    }

    await createNotification({
      userId: role === 'vet' ? appt.ownerId : appt.vetId,
      title: `Appointment ${target} — ${appt.petName}`,
      body: body.note || `${role === 'vet' ? appt.vetName : appt.ownerName} updated the appointment.`,
      kind: 'appointment',
      link: '/appointments',
    });
    await audit(req.user!.id, `appointment.${target}`, 'appointment', appt.id, { note: body.note ?? null });
    res.json({ appointment: await one(`${appointmentSelect} WHERE a.id = $1`, [appt.id]) });
  }),
);

appointmentsRouter.post(
  '/appointments/:id/reschedule',
  asyncHandler(async (req, res) => {
    const appt = await loadAppointment(req.params.id, req.user!.id, req.user!.role);
    if (!['pending', 'accepted'].includes(appt.status)) {
      throw badRequest('Only pending or accepted appointments can be rescheduled');
    }
    const body = parse(
      z.object({
        slotId: z.string().optional(),
        scheduledFor: z.string().datetime().optional(),
        note: z.string().max(1000).optional(),
      }),
      req.body,
    );
    if (!body.slotId && !body.scheduledFor) {
      throw badRequest('Provide a new slot or a new date and time.');
    }

    let scheduledFor = body.scheduledFor ?? null;
    if (body.slotId) {
      const slot = await one<{
        vet_user_id: string; slot_date: string | Date; start_time: string; status: string;
      }>(
        `SELECT vet_user_id, slot_date, start_time, status FROM vet_slots WHERE id = $1`,
        [body.slotId],
      );
      if (!slot) throw notFound('That time slot no longer exists. Pick another.');
      if (slot.vet_user_id !== appt.vetId) throw badRequest('That slot belongs to a different veterinarian.');
      if (slot.status !== 'available') throw conflict('That slot was just booked. Pick another.');
      scheduledFor = slotStart(slot.slot_date, slot.start_time);
    }
    if (!scheduledFor || new Date(scheduledFor).getTime() < Date.now() - 60_000) {
      throw badRequest('Choose a future date and time');
    }

    const db = await getDb();
    // Claim the new slot first so a lost race changes nothing, then release the
    // old one. The conditional UPDATE keeps the claim atomic.
    if (body.slotId) {
      const claimed = await db.query(
        `UPDATE vet_slots SET status = 'booked', appointment_id = $1
         WHERE id = $2 AND status = 'available'
         RETURNING id`,
      );
      if (!claimed.length) {
        throw conflict('That slot was just booked. Pick another available time.');
      }
    }
    await db.query(
      `UPDATE vet_slots SET status = 'available', appointment_id = NULL
       WHERE appointment_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [appt.id, body.slotId ?? null],
    );
    await db.query(
      `UPDATE appointments SET scheduled_for = $1, slot_id = $2, status = 'rescheduled',
              response_note = COALESCE($3, response_note), updated_at = now()
       WHERE id = $4`,
      [scheduledFor, body.slotId ?? null, body.note ?? null, appt.id],
    );

    const other = req.user!.role === 'vet' ? appt.ownerId : appt.vetId;
    await createNotification({
      userId: other,
      title: `Appointment rescheduled — ${appt.petName}`,
      body: body.note || `${req.user!.role === 'vet' ? appt.vetName : appt.ownerName} proposed a new time.`,
      kind: 'appointment',
      link: '/appointments',
    });
    await audit(req.user!.id, 'appointment.reschedule', 'appointment', appt.id, {
      slotId: body.slotId ?? null, scheduledFor,
    });
    res.json({ appointment: await one(`${appointmentSelect} WHERE a.id = $1`, [appt.id]) });
  }),
);

appointmentsRouter.post(
  '/appointments/:id/notes',
  asyncHandler(async (req, res) => {
    const appt = await loadAppointment(req.params.id, req.user!.id, req.user!.role);
    if (req.user!.role !== 'vet' || appt.vetId !== req.user!.id) {
      throw forbidden('Only the consulting veterinarian can add consultation notes');
    }
    if (appt.status !== 'accepted' && appt.status !== 'completed') {
      throw badRequest('Notes can be added after the appointment is accepted');
    }
    const body = parse(
      z.object({
        notes: z.string().min(3).max(5000),
        carePlan: z.string().max(5000).optional(),
        followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.body,
    );
    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO consultation_notes (id, appointment_id, vet_id, notes, care_plan, follow_up_on)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, appt.id, req.user!.id, body.notes, body.carePlan ?? null, body.followUpOn ?? null],
    );
    if (body.followUpOn) {
      await (await getDb()).query(
        `INSERT INTO care_tasks (id, pet_id, type, title, instructions, frequency, times, due_date, created_by)
         VALUES ($1,$2,'other','Follow-up visit','Veterinarian recommended a follow-up visit. Contact the clinic to confirm a time.', 'once', '[]', $3, $4)`,
        [crypto.randomUUID(), appt.petId, body.followUpOn, req.user!.id],
      );
    }
    await createNotification({
      userId: appt.ownerId,
      title: `Consultation notes added — ${appt.petName}`,
      body: 'Your veterinarian added notes and a care plan. Open the appointment to review them.',
      kind: 'appointment',
      link: '/appointments',
    });
    await audit(req.user!.id, 'appointment.note_create', 'consultation_note', id, { appointmentId: appt.id });
    res.status(201).json({ note: await one('SELECT * FROM consultation_notes WHERE id = $1', [id]) });
  }),
);
