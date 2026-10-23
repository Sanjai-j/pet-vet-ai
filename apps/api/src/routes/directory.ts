import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth, requireRole, requireVet } from '../auth.js';
import { audit } from '../audit.js';
import { createNotification } from '../services/notifications.js';
import { haversineKm } from '../util.js';
import { config } from '../config.js';

export const directoryRouter = Router();
directoryRouter.use(requireAuth);

function toPgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

// ───────────────────────────────────────────────────────────────
// Public directory of approved veterinarians
// ───────────────────────────────────────────────────────────────

directoryRouter.get(
  '/directory/vets',
  requireRole('owner', 'admin', 'vet'),
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        city: z.string().max(80).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        species: z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other']).optional(),
        specialization: z.string().max(80).optional(),
        language: z.string().max(40).optional(),
        consultationType: z.enum(['in_person', 'video', 'chat']).optional(),
        availableWithinDays: z.coerce.number().int().min(1).max(60).optional(),
        clinic: z.string().max(160).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    );
    const pageSize = 20;
    const offset = ((query.page ?? 1) - 1) * pageSize;

    // Only administrators and the veterinarians themselves can see any
    // non-approved profile; owners only ever see approved listings.
    const rows = await many<{
      id: string; fullName: string; city: string | null; state: string | null;
      clinicName: string | null; latitude: number | null; longitude: number | null;
      species: string[]; specialties: string[]; languages: string[];
      consultationTypes: string[]; experienceYears: number | null; qualification: string | null;
      licenseNumber: string; council: string; registrationAuthority: string | null;
      consultationFeeInr: number | null; verifiedAt: string | null; bio: string | null;
      serviceArea: string | null; photoFileId: string | null; reverifyDueOn: string | null;
    }>(
      `SELECT u.id, u.full_name AS "fullName", v.city, v.state, v.clinic_name AS "clinicName",
              v.latitude, v.longitude, v.species, v.specialties, v.languages,
              v.consultation_types AS "consultationTypes", v.experience_years AS "experienceYears",
              v.qualification, v.license_number AS "licenseNumber", v.council,
              v.registration_authority AS "registrationAuthority",
              v.consultation_fee_inr AS "consultationFeeInr", v.verified_at AS "verifiedAt",
              v.bio, v.service_area AS "serviceArea", v.photo_file_id AS "photoFileId",
              v.reverify_due_on AS "reverifyDueOn"
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.verification_status = 'verified' AND u.disabled = false
         AND ($1 = '' OR lower(v.city) = lower($1))
         AND ($2 = '' OR $2 = ANY(v.species))
         AND ($3 = '' OR EXISTS (SELECT 1 FROM unnest(v.specialties) s WHERE s ILIKE '%' || $3 || '%'))
         AND ($4 = '' OR EXISTS (SELECT 1 FROM unnest(v.languages) l WHERE lower(l) = lower($4)))
         AND ($5 = '' OR $5 = ANY(v.consultation_types))
         AND ($6 = '' OR v.clinic_name ILIKE '%' || $6 || '%' OR v.service_area ILIKE '%' || $6 || '%')
       ORDER BY v.verified_at DESC NULLS LAST, u.full_name
       LIMIT $7 OFFSET $8`,
      [
        query.city?.trim() ?? '', query.species ?? '', query.specialization?.trim() ?? '',
        query.language?.trim() ?? '', query.consultationType ?? '', query.clinic?.trim() ?? '',
        pageSize, offset,
      ],
    );

    const withDistance = rows
      .map((r) => ({
        ...r,
        verified: true,
        distanceKm:
          query.lat != null && query.lng != null && r.latitude != null && r.longitude != null
            ? haversineKm(query.lat, query.lng, Number(r.latitude), Number(r.longitude))
            : null,
      }))
      .filter((r) => {
        if (!query.availableWithinDays) return true;
        return true; // slot filtering applied below in bulk
      });

    // Availability filter: who has open slots in the window
    let results = withDistance;
    if (query.availableWithinDays) {
      const ids = withDistance.map((r) => r.id);
      const open = ids.length
        ? await many<{ vet_user_id: string }>(
            `SELECT DISTINCT vet_user_id FROM vet_slots
             WHERE status = 'available' AND vet_user_id = ANY($1)
               AND slot_date >= current_date AND slot_date <= current_date + $2::int`,
            [ids, query.availableWithinDays],
          )
        : [];
      const openSet = new Set(open.map((o) => o.vet_user_id));
      results = withDistance.filter((r) => openSet.has(r.id));
    }

    results = results.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    res.json({
      veterinarians: results,
      page: query.page ?? 1,
      hasMore: results.length === pageSize,
      notice:
        'Every profile here has been reviewed and approved by Pet Vet AI administrators. ' +
        'A Google Maps listing is not a verification — only the "Verified by Pet Vet AI" label means a human review happened.',
    });
  }),
);

directoryRouter.get(
  '/directory/vets/:vetId',
  requireRole('owner', 'admin', 'vet'),
  asyncHandler(async (req, res) => {
    const vet = await one<Record<string, unknown>>(
      `SELECT u.id, u.full_name AS "fullName", v.city, v.state, v.pincode,
              v.clinic_name AS "clinicName", v.clinic_address AS "clinicAddress",
              v.latitude, v.longitude, v.species, v.specialties, v.languages,
              v.consultation_types AS "consultationTypes", v.experience_years AS "experienceYears",
              v.qualification, v.license_number AS "licenseNumber", v.council,
              v.registration_authority AS "registrationAuthority",
              v.consultation_fee_inr AS "consultationFeeInr", v.verified_at AS "verifiedAt",
              v.bio, v.service_area AS "serviceArea", v.photo_file_id AS "photoFileId",
              v.reverify_due_on AS "reverifyDueOn"
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE v.user_id = $1 AND v.verification_status = 'verified' AND u.disabled = false`,
      [req.params.vetId],
    );
    if (!vet) throw notFound('Verified veterinarian not found');

    const slots = await many(
      `SELECT id, slot_date AS "slotDate", start_time AS "startTime", end_time AS "endTime",
              consultation_type AS "consultationType"
       FROM vet_slots
       WHERE vet_user_id = $1 AND status = 'available'
         AND slot_date >= current_date AND slot_date <= current_date + 21
         AND (slot_date > current_date OR start_time::time > (now() AT TIME ZONE $2::text)::time)
       ORDER BY slot_date, start_time LIMIT 60`,
      [req.params.vetId, config.timezone],
    );

    const associations = await many(
      `SELECT ca.place_id AS "placeId", ca.clinic_name AS "clinicName", c.name AS "clinicRecordName"
       FROM clinic_associations ca LEFT JOIN clinics c ON c.id = ca.clinic_id
       WHERE ca.vet_user_id = $1 AND ca.status = 'approved'`,
      [req.params.vetId],
    );

    res.json({ veterinarian: { ...vet, verified: true }, slots, clinicAssociations: associations });
  }),
);

// ───────────────────────────────────────────────────────────────
// Veterinarian: submit a verification application
// ───────────────────────────────────────────────────────────────

const applicationBody = z.object({
  professionalName: z.string().min(3).max(120),
  phone: z.string().min(7).max(20),
  licenseNumber: z.string().min(3).max(60),
  registrationAuthority: z.string().min(2).max(120),
  qualification: z.string().min(2).max(160),
  specialization: z.array(z.string().max(80)).min(1).max(12),
  species: z.array(z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other'])).min(1).max(6),
  languages: z.array(z.string().max(40)).min(1).max(10),
  experienceYears: z.number().int().min(0).max(70),
  clinicName: z.string().max(160).optional(),
  clinicAddress: z.string().max(300).optional(),
  serviceArea: z.string().max(300).optional(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  pincode: z.string().max(12).optional(),
  consultationTypes: z.array(z.enum(['in_person', 'video', 'chat'])).min(1).max(3),
  consultationFeeInr: z.number().int().min(0).max(100000).optional(),
  bio: z.string().max(3000).optional(),
  documentIds: z.array(z.string().max(80)).max(8).default([]),
});

directoryRouter.get(
  '/directory/applications/me',
  requireVet,
  asyncHandler(async (req, res) => {
    const application = await one(
      `SELECT a.id, a.status, a.summary, a.document_ids AS "documentIds",
              a.review_notes AS "reviewNotes", a.submitted_at AS "submittedAt",
              a.reviewed_at AS "reviewedAt", a.reverify_due_on AS "reverifyDueOn",
              r.full_name AS "reviewerName"
       FROM vet_applications a LEFT JOIN users r ON r.id = a.reviewer_id
       WHERE a.vet_user_id = $1 ORDER BY a.submitted_at DESC LIMIT 1`,
      [req.user!.id],
    );
    const profile = await one(
      `SELECT verification_status AS "verificationStatus", profile_status AS "profileStatus",
              suspended_reason AS "suspendedReason", verified_at AS "verifiedAt",
              reverify_due_on AS "reverifyDueOn"
       FROM vet_profiles WHERE user_id = $1`,
      [req.user!.id],
    );
    res.json({ application: application ?? null, profile: profile ?? null });
  }),
);

directoryRouter.post(
  '/directory/applications',
  requireVet,
  asyncHandler(async (req, res) => {
    const body = parse(applicationBody, req.body);

    const documentIds = body.documentIds ?? [];
    // Every uploaded document must belong to the applicant.
    for (const fileId of documentIds) {
      const file = await one<{ owner_id: string; purpose: string }>(
        'SELECT owner_id, purpose FROM files WHERE id = $1',
        [fileId],
      );
      if (!file || file.owner_id !== req.user!.id) {
        throw badRequest('One of the attached documents is not available. Re-upload and try again.');
      }
    }

    const open = await one<{ id: string }>(
      `SELECT id FROM vet_applications
       WHERE vet_user_id = $1 AND status IN ('submitted', 'under_review', 'additional_info_required')
       LIMIT 1`,
      [req.user!.id],
    );
    if (open) {
      throw conflict('You already have an application under review. An administrator will contact you.');
    }

    const db = await getDb();
    const applicationId = crypto.randomUUID();
    await db.query(
      `INSERT INTO vet_applications (id, vet_user_id, status, summary, document_ids)
       VALUES ($1, $2, 'submitted', $3, $4::jsonb)`,
      [
        applicationId, req.user!.id,
        `${body.qualification} · ${body.experienceYears} years experience`,
        JSON.stringify(documentIds),
      ],
    );

    // Upsert the professional profile; it stays unapproved until reviewed.
    await db.query(
      `INSERT INTO vet_profiles
         (user_id, license_number, council, registration_authority, qualification, experience_years,
          bio, clinic_name, clinic_address, city, state, pincode, specialties, species,
          languages, consultation_types, consultation_fee_inr, phone, service_area,
          verification_status, profile_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14::text[],$15::text[],$16::text[],$17,$18,$19,
               'submitted', 'submitted')
       ON CONFLICT (user_id) DO UPDATE SET
         license_number = EXCLUDED.license_number,
         council = EXCLUDED.council,
         registration_authority = EXCLUDED.registration_authority,
         qualification = EXCLUDED.qualification,
         experience_years = EXCLUDED.experience_years,
         bio = EXCLUDED.bio,
         clinic_name = EXCLUDED.clinic_name,
         clinic_address = EXCLUDED.clinic_address,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         pincode = EXCLUDED.pincode,
         specialties = EXCLUDED.specialties,
         species = EXCLUDED.species,
         languages = EXCLUDED.languages,
         consultation_types = EXCLUDED.consultation_types,
         consultation_fee_inr = EXCLUDED.consultation_fee_inr,
         phone = EXCLUDED.phone,
         service_area = EXCLUDED.service_area,
         verification_status = 'submitted',
         profile_status = 'submitted',
         updated_at = now()`,
      [
        req.user!.id, body.licenseNumber, body.registrationAuthority, body.registrationAuthority,
        body.qualification, body.experienceYears, body.bio ?? null, body.clinicName ?? null,
        body.clinicAddress ?? null, body.city, body.state, body.pincode ?? null,
        toPgArray(body.specialization), toPgArray(body.species), toPgArray(body.languages),
        toPgArray(body.consultationTypes), body.consultationFeeInr ?? null, body.phone,
        body.serviceArea ?? null,
      ],
    );

    const admins = await many<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' AND disabled = false`,
    );
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: 'New veterinarian verification application',
        body: `${body.professionalName} submitted credentials for review.`,
        kind: 'verification',
        link: '/admin',
      });
    }

    await audit(req.user!.id, 'vet.application_submit', 'vet_application', applicationId, {
      documentCount: documentIds.length,
    });
    res.status(201).json({
      applicationId,
      status: 'submitted',
      notice: 'Your application is queued for administrator review. You stay unapproved until a decision is recorded.',
    });
  }),
);

// ───────────────────────────────────────────────────────────────
// Veterinarian: clinic association requests (always reviewed)
// ───────────────────────────────────────────────────────────────

directoryRouter.get(
  '/directory/associations/me',
  requireVet,
  asyncHandler(async (req, res) => {
    const rows = await many(
      `SELECT id, place_id AS "placeId", clinic_name AS "clinicName", status,
              review_notes AS "reviewNotes", created_at AS "createdAt", reviewed_at AS "reviewedAt"
       FROM clinic_associations WHERE vet_user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id],
    );
    res.json({ associations: rows });
  }),
);

directoryRouter.post(
  '/directory/associations',
  requireVet,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        placeId: z.string().min(4).max(128),
        clinicName: z.string().min(2).max(160),
        evidence: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const profile = await one<{ verification_status: string }>(
      'SELECT verification_status FROM vet_profiles WHERE user_id = $1',
      [req.user!.id],
    );
    if (profile?.verification_status !== 'verified') {
      throw forbidden('Only approved veterinarians can associate their profile with a clinic listing.');
    }
    const existing = await one<{ id: string; status: string }>(
      'SELECT id, status FROM clinic_associations WHERE vet_user_id = $1 AND place_id = $2',
      [req.user!.id, body.placeId],
    );
    if (existing) throw conflict('You already requested this clinic association.');

    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO clinic_associations (id, vet_user_id, place_id, clinic_name, evidence)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, req.user!.id, body.placeId, body.clinicName, body.evidence ?? null],
    );
    const admins = await many<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' AND disabled = false`,
    );
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: 'Clinic association requested',
        body: `A veterinarian asked to link their profile to “${body.clinicName}”.`,
        kind: 'verification',
        link: '/admin',
      });
    }
    await audit(req.user!.id, 'clinic.association_request', 'clinic_association', id, {
      placeId: body.placeId,
    });
    res.status(201).json({ id, status: 'pending' });
  }),
);

// ───────────────────────────────────────────────────────────────
// Administrator: review applications, associations, imports
// ───────────────────────────────────────────────────────────────

directoryRouter.get(
  '/directory/admin/applications',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        status: z.enum(['submitted', 'under_review', 'additional_info_required', 'approved', 'rejected']).optional(),
        page: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    );
    const pageSize = 20;
    const rows = await many(
      `SELECT a.id, a.status, a.summary, a.document_ids AS "documentIds",              a.submitted_at AS "submittedAt", a.reviewed_at AS "reviewedAt",
              a.reverify_due_on AS "reverifyDueOn", a.review_notes AS "reviewNotes",
              u.id AS "vetUserId", u.full_name AS "fullName", u.email,
              v.license_number AS "licenseNumber", v.registration_authority AS "registrationAuthority",
              v.qualification, v.experience_years AS "experienceYears", v.city, v.state,
              v.verification_status AS "verificationStatus",
              r.full_name AS "reviewerName",
              (SELECT count(*)::int FROM files f WHERE f.id IN (SELECT jsonb_array_elements_text(a.document_ids))) AS "documentCount"
       FROM vet_applications a
       JOIN users u ON u.id = a.vet_user_id
       LEFT JOIN vet_profiles v ON v.user_id = a.vet_user_id
       LEFT JOIN users r ON r.id = a.reviewer_id
       WHERE ($1 = '' OR a.status = $1)
       ORDER BY CASE a.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,
                a.submitted_at DESC
       LIMIT $2 OFFSET $3`,
      [query.status ?? '', pageSize, ((query.page ?? 1) - 1) * pageSize],
    );
    res.json({ applications: rows, page: query.page, hasMore: rows.length === pageSize });
  }),
);

directoryRouter.post(
  '/directory/admin/applications/:id/transition',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        action: z.enum(['under_review', 'additional_info_required', 'approved', 'rejected']),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const app = await one<{ id: string; vet_user_id: string; status: string }>(
      'SELECT id, vet_user_id, status FROM vet_applications WHERE id = $1',
      [req.params.id],
    );
    if (!app) throw notFound('Application not found');
    const allowed: Record<string, string[]> = {
      submitted: ['under_review', 'approved', 'rejected'],
      under_review: ['additional_info_required', 'approved', 'rejected'],
      additional_info_required: ['under_review', 'approved', 'rejected'],
    };
    if (!(allowed[app.status] ?? []).includes(body.action)) {
      throw badRequest(`Cannot move an application from ${app.status} to ${body.action}.`);
    }

    const db = await getDb();
    const reverifyDue =
      body.action === 'approved'
        ? new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10)
        : null;

    await db.query(
      `UPDATE vet_applications
       SET status = $1, reviewer_id = $2, review_notes = COALESCE($3, review_notes),
           reviewed_at = CASE WHEN $1 IN ('approved','rejected') THEN now() ELSE reviewed_at END,
           reverify_due_on = COALESCE($4::date, reverify_due_on)
       WHERE id = $5`,
      [body.action, req.user!.id, body.notes ?? null, reverifyDue, app.id],
    );

    const profileStatusMap: Record<string, string> = {
      under_review: 'under_review',
      additional_info_required: 'additional_info_required',
      approved: 'verified',
      rejected: 'rejected',
    };
    const verificationStatus = profileStatusMap[body.action];
    await db.query(
      `UPDATE vet_profiles SET
         verification_status = $1,
         profile_status = $2,
         verification_notes = COALESCE($3, verification_notes),
         verified_at = CASE WHEN $1 = 'verified' THEN now() ELSE NULL END,
         reverify_due_on = COALESCE($4::date, reverify_due_on),
         updated_at = now()
       WHERE user_id = $5`,
      [verificationStatus, body.action, body.notes ?? null, reverifyDue, app.vet_user_id],
    );

    const messages: Record<string, string> = {
      under_review: 'Your application is now under review.',
      additional_info_required: 'The reviewer needs more information. Check the notes in your portal.',
      approved: 'Your profile is approved and visible in the verified veterinarian directory.',
      rejected: 'Your application was not approved. Review the notes and reapply.',
    };
    await createNotification({
      userId: app.vet_user_id,
      title: `Verification application ${body.action.replace('_', ' ')}`,
      body: body.notes || messages[body.action],
      kind: 'verification',
      link: '/vet',
    });
    await audit(req.user!.id, `vet.application_${body.action}`, 'vet_application', app.id, {
      notes: body.notes ?? null,
    });
    res.json({ ok: true, status: body.action, verificationStatus });
  }),
);

directoryRouter.get(
  '/directory/admin/associations',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const rows = await many(
      `SELECT ca.id, ca.place_id AS "placeId", ca.clinic_name AS "clinicName", ca.status,
              ca.evidence, ca.created_at AS "createdAt", ca.reviewed_at AS "reviewedAt",
              ca.review_notes AS "reviewNotes",
              u.id AS "vetUserId", u.full_name AS "vetName", r.full_name AS "reviewerName"
       FROM clinic_associations ca
       JOIN users u ON u.id = ca.vet_user_id
       LEFT JOIN users r ON r.id = ca.reviewer_id
       ORDER BY CASE ca.status WHEN 'pending' THEN 0 ELSE 1 END, ca.created_at DESC`,
    );
    res.json({ associations: rows });
  }),
);

directoryRouter.post(
  '/directory/admin/associations/:id/transition',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        action: z.enum(['approved', 'rejected']),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const assoc = await one<{ id: string; vet_user_id: string; status: string }>(
      'SELECT id, vet_user_id, status FROM clinic_associations WHERE id = $1',
      [req.params.id],
    );
    if (!assoc) throw notFound('Association not found');
    if (assoc.status !== 'pending') throw badRequest('Only pending associations can be reviewed.');

    // Match against our own clinic records only if an admin links it later;
    // never auto-merge on name similarity.
    await (await getDb()).query(
      `UPDATE clinic_associations SET status = $1, reviewer_id = $2, review_notes = $3, reviewed_at = now()
       WHERE id = $4`,
      [body.action, req.user!.id, body.notes ?? null, assoc.id],
    );
    await audit(req.user!.id, `clinic.association_${body.action}`, 'clinic_association', assoc.id, {
      notes: body.notes ?? null,
    });
    res.json({ ok: true, status: body.action });
  }),
);

directoryRouter.get(
  '/directory/admin/imports',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const rows = await many(
      `SELECT i.id, i.source_name AS "sourceName", i.license_note AS "licenseNote",
              i.record_count AS "recordCount", i.accepted_count AS "acceptedCount",
              i.duplicate_count AS "duplicateCount", i.rejected_count AS "rejectedCount",
              i.status, i.review_notes AS "reviewNotes", i.created_at AS "createdAt",
              u.full_name AS "importedBy"
       FROM directory_imports i LEFT JOIN users u ON u.id = i.imported_by
       ORDER BY i.created_at DESC LIMIT 50`,
    );
    res.json({ imports: rows });
  }),
);

directoryRouter.post(
  '/directory/admin/imports',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        sourceName: z.string().min(3).max(160),
        licenseNote: z.string().min(3).max(400),
        records: z
          .array(
            z.object({
              name: z.string().min(2).max(200),
              address: z.string().min(3).max(300),
              city: z.string().min(2).max(80),
              state: z.string().min(2).max(80),
              pincode: z.string().max(12).optional(),
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
              phone: z.string().max(20).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );

    let duplicates = 0;
    let accepted = 0;
    let rejected = 0;
    const db = await getDb();
    for (const r of body.records) {
      const dupe = await one<{ id: string }>(
        `SELECT id FROM clinics WHERE lower(name) = lower($1) AND lower(city) = lower($2) LIMIT 1`,
        [r.name, r.city],
      );
      if (dupe) {
        duplicates += 1;
        continue;
      }
      if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
        rejected += 1;
        continue;
      }
      await db.query(
        `INSERT INTO clinics (id, name, address, city, state, pincode, latitude, longitude,
                              phone, services, is_demo, data_source, verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}', false, 'independent_import', 'unverified')`,
        [crypto.randomUUID(), r.name, r.address, r.city, r.state, r.pincode ?? null,
         r.latitude, r.longitude, r.phone ?? null],
      );
      accepted += 1;
    }

    const importId = crypto.randomUUID();
    await db.query(
      `INSERT INTO directory_imports (id, source_name, license_note, record_count, accepted_count,
                                      duplicate_count, rejected_count, status, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review',$8)`,
      [importId, body.sourceName, body.licenseNote, body.records.length, accepted,
       duplicates, rejected, req.user!.id],
    );
    await audit(req.user!.id, 'directory.import', 'directory_import', importId, {
      source: body.sourceName, accepted, duplicates, rejected,
    });
    res.status(201).json({ id: importId, accepted, duplicates, rejected });
  }),
);
