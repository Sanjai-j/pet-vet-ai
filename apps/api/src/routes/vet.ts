import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth, requireVet } from '../auth.js';
import { audit } from '../audit.js';
import { createNotification } from '../services/notifications.js';

export const vetRouter = Router();
vetRouter.use(requireAuth, requireVet);

function toPgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

async function profilePayload(userId: string) {
  const profile = await one<Record<string, unknown>>(
    `SELECT user_id AS "userId", license_number AS "licenseNumber", council,
            experience_years AS "experienceYears", bio, clinic_name AS "clinicName",
            clinic_address AS "clinicAddress", city, state, pincode, latitude, longitude,
            specialties, species, availability, consultation_fee_inr AS "consultationFeeInr",
            verification_status AS "verificationStatus", verification_notes AS "verificationNotes",
            verified_at AS "verifiedAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM vet_profiles WHERE user_id = $1`,
    [userId],
  );
  if (!profile) throw notFound('Veterinarian profile not found');
  return profile;
}

vetRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const profile = await profilePayload(req.user!.id);
    const stats = await one<{
      pending: number; accepted: number; completed: number; sharedPets: number; unread: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM appointments WHERE vet_id = $1 AND status = 'pending') AS pending,
        (SELECT count(*)::int FROM appointments WHERE vet_id = $1 AND status = 'accepted') AS accepted,
        (SELECT count(*)::int FROM appointments WHERE vet_id = $1 AND status = 'completed') AS completed,
        (SELECT count(DISTINCT pet_id)::int FROM appointments WHERE vet_id = $1 AND status IN ('accepted','completed')) AS "sharedPets",
        (SELECT count(*)::int FROM messages m JOIN threads t ON t.id = m.thread_id
          WHERE t.vet_id = $1 AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread`,
      [req.user!.id],
    );
    res.json({ profile, stats });
  }),
);

vetRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        licenseNumber: z.string().min(3).max(60).optional(),
        council: z.string().min(2).max(120).optional(),
        experienceYears: z.number().int().min(0).max(70).nullable().optional(),
        bio: z.string().max(3000).nullable().optional(),
        clinicName: z.string().max(160).nullable().optional(),
        clinicAddress: z.string().max(300).nullable().optional(),
        city: z.string().max(80).nullable().optional(),
        state: z.string().max(80).nullable().optional(),
        pincode: z.string().max(12).nullable().optional(),
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        specialties: z.array(z.string().max(80)).max(12).optional(),
        species: z.array(z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other'])).min(1).max(6).optional(),
        availability: z
          .object({
            days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).max(7).optional(),
            slots: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(12).optional(),
          })
          .optional(),
        consultationFeeInr: z.number().int().min(0).max(100000).nullable().optional(),
      }),
      req.body,
    );
    const current = await one<{
      licenseNumber: string; council: string; verificationStatus: string;
    }>(
      `SELECT license_number AS "licenseNumber", council,
              verification_status AS "verificationStatus"
       FROM vet_profiles WHERE user_id = $1`,
      [req.user!.id],
    );
    if (!current) throw notFound('Veterinarian profile not found');

    const credentialsChanged =
      (body.licenseNumber && body.licenseNumber !== current.licenseNumber) ||
      (body.council && body.council !== current.council);
    const status = credentialsChanged ? 'pending' : current.verificationStatus;

    await (await getDb()).query(
      `UPDATE vet_profiles SET
        license_number = COALESCE($1, license_number),
        council = COALESCE($2, council),
        experience_years = COALESCE($3, experience_years),
        bio = COALESCE($4, bio),
        clinic_name = COALESCE($5, clinic_name),
        clinic_address = COALESCE($6, clinic_address),
        city = COALESCE($7, city),
        state = COALESCE($8, state),
        pincode = COALESCE($9, pincode),
        latitude = COALESCE($10, latitude),
        longitude = COALESCE($11, longitude),
        specialties = COALESCE($12::text[], specialties),
        species = COALESCE($13::text[], species),
        availability = COALESCE($14::jsonb, availability),
        consultation_fee_inr = COALESCE($15, consultation_fee_inr),
        verification_status = $16,
        verified_at = CASE WHEN $16 = 'verified' THEN verified_at ELSE NULL END,
        updated_at = now()
       WHERE user_id = $17`,
      [
        body.licenseNumber ?? null, body.council ?? null, body.experienceYears ?? null,
        body.bio ?? null, body.clinicName ?? null, body.clinicAddress ?? null,
        body.city ?? null, body.state ?? null, body.pincode ?? null,
        body.latitude ?? null, body.longitude ?? null,
        body.specialties ? toPgArray(body.specialties) : null,
        body.species ? toPgArray(body.species) : null,
        body.availability ? JSON.stringify(body.availability) : null,
        body.consultationFeeInr ?? null, status, req.user!.id,
      ],
    );
    await audit(req.user!.id, 'vet.profile_update', 'vet_profile', req.user!.id, {
      credentialsChanged,
      resubmitted: credentialsChanged,
    });
    if (credentialsChanged) {
      const admins = await many<{ id: string }>(
        `SELECT id FROM users WHERE role = 'admin' AND disabled = false`,
      );
      for (const admin of admins) {
        await createNotification({
          userId: admin.id,
          title: 'Veterinarian credentials resubmitted',
          body: `${req.user!.fullName} changed their license or council details and needs re-verification.`,
          kind: 'verification',
          link: '/admin',
        });
      }
    }
    res.json({ profile: await profilePayload(req.user!.id) });
  }),
);
