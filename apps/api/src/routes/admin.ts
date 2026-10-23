import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { chunkText, parseJson } from '../util.js';
import { audit } from '../audit.js';
import { createNotification } from '../services/notifications.js';
import { syncVaccineScheduleMirror } from '../services/vaccine-rag.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

function toPgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

adminRouter.get(
  '/admin/stats',
  asyncHandler(async (_req, res) => {
    const counts = await many<{ key: string; n: number }>(`
      SELECT 'users' AS key, count(*)::int AS n FROM users
      UNION ALL SELECT 'owners', count(*)::int FROM users WHERE role = 'owner'
      UNION ALL SELECT 'pets', count(*)::int FROM pets
      UNION ALL SELECT 'vets_pending', count(*)::int FROM vet_profiles WHERE verification_status = 'pending'
      UNION ALL SELECT 'vets_verified', count(*)::int FROM vet_profiles WHERE verification_status = 'verified'
      UNION ALL SELECT 'appointments_pending', count(*)::int FROM appointments WHERE status = 'pending'
      UNION ALL SELECT 'knowledge_pending', count(*)::int FROM knowledge_documents WHERE status = 'pending'
      UNION ALL SELECT 'vaccine_schedules_pending', count(*)::int FROM vaccine_schedules WHERE status = 'pending'
      UNION ALL SELECT 'reports_open', count(*)::int FROM content_reports WHERE status = 'open'
      UNION ALL SELECT 'ai_messages_24h', count(*)::int FROM ai_messages WHERE created_at > now() - interval '1 day'
    `);
    const map = Object.fromEntries(counts.map((c) => [c.key, Number(c.n)]));
    res.json({ stats: map });
  }),
);

adminRouter.get(
  '/admin/vets',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = await many(
      `SELECT u.id, u.full_name AS "fullName", u.email, u.city, u.state, u.created_at AS "createdAt",
              v.license_number AS "licenseNumber", v.council, v.experience_years AS "experienceYears",
              v.clinic_name AS "clinicName", v.specialties, v.species, v.consultation_fee_inr AS "feeInr",
              v.verification_status AS "verificationStatus", v.verification_notes AS "verificationNotes",
              v.verified_at AS "verifiedAt", v.bio
       FROM vet_profiles v JOIN users u ON u.id = v.user_id
       WHERE ($1 = '' OR v.verification_status = $1)
       ORDER BY CASE v.verification_status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC`,
      [status],
    );
    res.json({ veterinarians: rows });
  }),
);

adminRouter.patch(
  '/admin/vets/:vetId/verification',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['verified', 'rejected']),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const vet = await one<{ user_id: string; verification_status: string }>(
      'SELECT user_id, verification_status FROM vet_profiles WHERE user_id = $1',
      [req.params.vetId],
    );
    if (!vet) throw notFound('Veterinarian not found');
    await (await getDb()).query(
      `UPDATE vet_profiles SET verification_status = $1, verification_notes = $2,
        verified_at = CASE WHEN $1 = 'verified' THEN now() ELSE NULL END, updated_at = now()
       WHERE user_id = $3`,
      [body.status, body.notes ?? null, req.params.vetId],
    );
    await createNotification({
      userId: req.params.vetId,
      title: `Professional verification ${body.status}`,
      body: body.notes || (body.status === 'verified'
        ? 'Your profile is now visible in the verified veterinarian directory.'
        : 'Your verification was rejected. Review the notes and resubmit your credentials.'),
      kind: 'verification',
      link: '/vet',
    });
    await audit(req.user!.id, `vet.verification_${body.status}`, 'vet_profile', req.params.vetId, {
      notes: body.notes ?? null,
    });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/users',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rows = await many(
      `SELECT u.id, u.email, u.full_name AS "fullName", u.role, u.city, u.state,
              u.disabled, u.created_at AS "createdAt",
              (SELECT count(*)::int FROM pets p WHERE p.owner_id = u.id) AS "petCount"
       FROM users u
       WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC LIMIT 100`,
      [q],
    );
    res.json({ users: rows });
  }),
);

adminRouter.patch(
  '/admin/users/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.id) throw badRequest('You cannot disable your own administrator account');
    const body = parse(z.object({ disabled: z.boolean() }), req.body);
    const user = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [req.params.id]);
    if (!user) throw notFound('User not found');
    await (await getDb()).query('UPDATE users SET disabled = $1 WHERE id = $2', [body.disabled, req.params.id]);
    await audit(req.user!.id, body.disabled ? 'user.disable' : 'user.enable', 'user', req.params.id);
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/species',
  asyncHandler(async (_req, res) => {
    const species = await many('SELECT * FROM species ORDER BY sort_order, name');
    const breeds = await many('SELECT * FROM breeds ORDER BY species_code, sort_order, name');
    res.json({ species, breeds });
  }),
);

adminRouter.post(
  '/admin/species',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        code: z.string().regex(/^[a-z_]{2,30}$/),
        name: z.string().min(2).max(60),
        category: z.enum(['companion', 'poultry', 'farm', 'other']),
        icon: z.string().max(8).default('🐾'),
        description: z.string().max(400).default(''),
        sortOrder: z.number().int().min(0).max(999).default(100),
      }),
      req.body,
    );
    await (await getDb()).query(
      `INSERT INTO species (code, name, category, icon, description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [body.code, body.name, body.category, body.icon, body.description, body.sortOrder],
    );
    await audit(req.user!.id, 'catalog.species_create', 'species', body.code);
    res.status(201).json({ ok: true });
  }),
);

adminRouter.patch(
  '/admin/species/:code',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).max(60).optional(),
        category: z.enum(['companion', 'poultry', 'farm', 'other']).optional(),
        icon: z.string().max(8).optional(),
        description: z.string().max(400).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
      req.body,
    );
    const existing = await one<{ code: string }>('SELECT code FROM species WHERE code = $1', [req.params.code]);
    if (!existing) throw notFound('Species not found');
    await (await getDb()).query(
      `UPDATE species SET name = COALESCE($1, name), category = COALESCE($2, category),
        icon = COALESCE($3, icon), description = COALESCE($4, description),
        is_active = COALESCE($5, is_active), sort_order = COALESCE($6, sort_order)
       WHERE code = $7`,
      [body.name ?? null, body.category ?? null, body.icon ?? null, body.description ?? null,
       body.isActive ?? null, body.sortOrder ?? null, req.params.code],
    );
    await audit(req.user!.id, 'catalog.species_update', 'species', req.params.code, body);
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/admin/breeds',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        speciesCode: z.string().min(2),
        name: z.string().min(1).max(100),
        notes: z.string().max(300).optional(),
        isUnknown: z.boolean().default(false),
        sortOrder: z.number().int().min(0).max(999).default(100),
      }),
      req.body,
    );
    const species = await one('SELECT code FROM species WHERE code = $1', [body.speciesCode]);
    if (!species) throw badRequest('Species not found');
    const id = `breed_${body.speciesCode}_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}_${Date.now().toString(36).slice(-4)}`;
    await (await getDb()).query(
      `INSERT INTO breeds (id, species_code, name, notes, is_unknown, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, body.speciesCode, body.name, body.notes ?? null, body.isUnknown, body.sortOrder],
    );
    await audit(req.user!.id, 'catalog.breed_create', 'breed', id);
    res.status(201).json({ id });
  }),
);

adminRouter.patch(
  '/admin/breeds/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(100).optional(),
        notes: z.string().max(300).nullable().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
      req.body,
    );
    await (await getDb()).query(
      `UPDATE breeds SET name = COALESCE($1, name), notes = COALESCE($2, notes),
        is_active = COALESCE($3, is_active), sort_order = COALESCE($4, sort_order) WHERE id = $5`,
      [body.name ?? null, body.notes ?? null, body.isActive ?? null, body.sortOrder ?? null, req.params.id],
    );
    await audit(req.user!.id, 'catalog.breed_update', 'breed', req.params.id, body);
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/knowledge',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = await many(
      `SELECT d.id, d.title, d.species, d.category, d.source_org AS "sourceOrg",
              d.source_url AS "sourceUrl", d.published_year AS "publishedYear", d.content,
              d.status, d.is_demo AS "isDemo", d.created_at AS "createdAt",
              d.review_notes AS "reviewNotes", d.reviewed_at AS "reviewedAt",
              reviewer.full_name AS "reviewedBy",
              (SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id = d.id) AS "chunkCount"
       FROM knowledge_documents d
       LEFT JOIN users reviewer ON reviewer.id = d.reviewed_by
       WHERE ($1 = '' OR d.status = $1)
       ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.created_at DESC`,
      [status],
    );
    res.json({ documents: rows });
  }),
);

adminRouter.post(
  '/admin/knowledge',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().min(5).max(200),
        species: z.array(z.string()).min(1).max(6),
        category: z.string().min(2).max(60),
        sourceOrg: z.string().min(2).max(200),
        sourceUrl: z.string().url().nullable().optional(),
        publishedYear: z.number().int().min(1900).max(2100).nullable().optional(),
        content: z.string().min(50).max(50000),
        isDemo: z.boolean().default(false),
      }),
      req.body,
    );
    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO knowledge_documents
        (id, title, species, category, source_org, source_url, published_year, content, status, is_demo, submitted_by)
       VALUES ($1,$2,$3::text[],$4,$5,$6,$7,$8,'pending',$9,$10)`,
      [id, body.title, toPgArray(body.species), body.category, body.sourceOrg, body.sourceUrl ?? null,
       body.publishedYear ?? null, body.content, body.isDemo, req.user!.id],
    );
    await audit(req.user!.id, 'knowledge.create', 'knowledge_document', id);
    res.status(201).json({ id });
  }),
);

adminRouter.patch(
  '/admin/knowledge/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().min(5).max(200).optional(),
        category: z.string().min(2).max(60).optional(),
        sourceOrg: z.string().min(2).max(200).optional(),
        sourceUrl: z.string().url().nullable().optional(),
        content: z.string().min(50).max(50000).optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        reviewNotes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const doc = await one<{ id: string; content: string; status: string }>(
      'SELECT id, content, status FROM knowledge_documents WHERE id = $1',
      [req.params.id],
    );
    if (!doc) throw notFound('Document not found');

    const status = body.status ?? (body.content && doc.status === 'approved' ? 'pending' : doc.status);
    await (await getDb()).query(
      `UPDATE knowledge_documents SET
         title = COALESCE($1, title), category = COALESCE($2, category),
         source_org = COALESCE($3, source_org), source_url = COALESCE($4, source_url),
         content = COALESCE($5, content), status = $6,
         review_notes = COALESCE($7, review_notes),
         reviewed_by = $8, reviewed_at = now()
       WHERE id = $9`,
      [body.title ?? null, body.category ?? null, body.sourceOrg ?? null, body.sourceUrl ?? null,
       body.content ?? null, status, body.reviewNotes ?? null, req.user!.id, req.params.id],
    );

    const db = await getDb();
    await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [req.params.id]);
    if (status === 'approved') {
      const content = body.content ?? doc.content;
      const chunks = chunkText(content);
      for (let i = 0; i < chunks.length; i++) {
        await db.query(
          'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content) VALUES ($1,$2,$3,$4)',
          [crypto.randomUUID(), req.params.id, i, chunks[i]],
        );
      }
    }
    await audit(req.user!.id, `knowledge.${status}`, 'knowledge_document', req.params.id, {
      notes: body.reviewNotes ?? null,
      chunks: status === 'approved' ? chunkText(body.content ?? doc.content).length : 0,
    });
    res.json({ ok: true, status });
  }),
);

adminRouter.patch(
  '/admin/capabilities/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['validated', 'limited', 'not_supported']),
        evidenceSummary: z.string().min(10).max(1000),
        evaluationNotes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const cap = await one<{ id: string }>('SELECT id FROM capability_registry WHERE id = $1', [req.params.id]);
    if (!cap) throw notFound('Capability not found');
    await (await getDb()).query(
      `UPDATE capability_registry SET status = $1, evidence_summary = $2,
        evaluation_notes = COALESCE($3, evaluation_notes), updated_by = $4, updated_at = now()
       WHERE id = $5`,
      [body.status, body.evidenceSummary, body.evaluationNotes ?? null, req.user!.id, req.params.id],
    );
    await audit(req.user!.id, 'capability.update', 'capability', req.params.id, { status: body.status });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/settings',
  asyncHandler(async (_req, res) => {
    const rows = await many('SELECT key, value, updated_at AS "updatedAt" FROM settings ORDER BY key');
    res.json({ settings: rows });
  }),
);

adminRouter.patch(
  '/admin/settings/ai',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        llmEnabled: z.boolean().optional(),
        speciesAware: z.boolean().optional(),
        disclaimer: z.string().min(10).max(600).optional(),
      }),
      req.body,
    );
    const current = await one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'ai'`);
    const merged = { ...parseJson<Record<string, unknown>>(current?.value, {}), ...body };
    await (await getDb()).query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('ai', $1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [JSON.stringify(merged), req.user!.id],
    );
    await audit(req.user!.id, 'settings.ai_update', 'settings', 'ai', body);
    res.json({ ai: merged });
  }),
);

adminRouter.get(
  '/admin/audit',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 300);
    const rows = await many(
      `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.meta,
              a.created_at AS "createdAt", u.full_name AS "actorName", u.email AS "actorEmail"
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ entries: rows });
  }),
);

adminRouter.get(
  '/admin/reports',
  asyncHandler(async (_req, res) => {
    const rows = await many(
      `SELECT r.id, r.target_type AS "targetType", r.target_id AS "targetId", r.reason,
              r.status, r.resolution, r.created_at AS "createdAt", u.full_name AS "reporterName"
       FROM content_reports r LEFT JOIN users u ON u.id = r.reporter_id
       ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC`,
    );
    res.json({ reports: rows });
  }),
);

adminRouter.patch(
  '/admin/reports/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ status: z.enum(['resolved', 'dismissed']), resolution: z.string().max(1000).optional() }),
      req.body,
    );
    await (await getDb()).query('UPDATE content_reports SET status = $1, resolution = $2 WHERE id = $3', [
      body.status, body.resolution ?? null, req.params.id,
    ]);
    await audit(req.user!.id, 'report.resolve', 'content_report', req.params.id, body);
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/admin/evaluations',
  asyncHandler(async (_req, res) => {
    const rows = await many(
      `SELECT id, name, capability, dataset_size AS "datasetSize", passed, failed,
              cases, created_at AS "createdAt" FROM ai_evaluation_runs ORDER BY created_at DESC`,
    );
    res.json({ evaluations: rows });
  }),
);

adminRouter.post(
  '/admin/evaluations',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(3).max(160),
        capability: z.string().min(2).max(60),
        cases: z
          .array(
            z.object({
              input: z.string().min(1).max(500),
              expected: z.string().min(1).max(120),
              actual: z.string().max(120).optional(),
              pass: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      req.body,
    );
    const cases = body.cases.map((c) => ({
      ...c,
      pass: c.pass ?? (c.actual ? c.actual === c.expected : false),
    }));
    const passed = cases.filter((c) => c.pass).length;
    const id = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO ai_evaluation_runs (id, name, capability, dataset_size, passed, failed, cases, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.name, body.capability, cases.length, passed, cases.length - passed, JSON.stringify(cases), req.user!.id],
    );
    await audit(req.user!.id, 'evaluation.create', 'ai_evaluation', id, {
      passed,
      failed: cases.length - passed,
      note: 'Technical regression result only; not clinical validation.',
    });
    res.status(201).json({ id, passed, failed: cases.length - passed });
  }),
);

// ── Vaccination schedule review ──────────────────────────────
// Rows imported from a vaccination-schedule workbook wait here. Nothing is
// scheduled for a pet until the row is approved, and approval records who
// reviewed it.

adminRouter.get(
  '/admin/vaccine-schedules',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = await many(
      `SELECT vs.id, vs.species_code AS "speciesCode", vs.species_label AS "speciesLabel",
              vaccine_key AS "vaccineKey", vaccine_name AS "vaccineName",
              first_dose_age_text AS "firstDoseAgeText", first_dose_age_days AS "firstDoseAgeDays",
              primary_series_text AS "primarySeriesText",
              booster_interval_text AS "boosterIntervalText",
              booster_interval_months AS "boosterIntervalMonths",
              must_check_before_scheduling AS "mustCheck", app_guidance AS "appGuidance",
              guidance_level AS "guidanceLevel", auto_assignable AS "autoAssignable",
              reference_basis AS "referenceBasis", status, is_demo AS "isDemo",
              review_notes AS "reviewNotes", reviewed_at AS "reviewedAt",
              reviewer.full_name AS "reviewedBy"
       FROM vaccine_schedules vs
       LEFT JOIN users reviewer ON reviewer.id = vs.reviewed_by
       WHERE ($1 = '' OR vs.status = $1)
       ORDER BY CASE vs.status WHEN 'pending' THEN 0 ELSE 1 END, vs.species_code, vs.vaccine_name`,
      [status],
    );
    res.json({ schedules: rows });
  }),
);

adminRouter.patch(
  '/admin/vaccine-schedules/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected']),
        reviewNotes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const row = await one<{ id: string; vaccine_name: string; auto_assignable: boolean }>(
      'SELECT id, vaccine_name, auto_assignable FROM vaccine_schedules WHERE id = $1',
      [req.params.id],
    );
    if (!row) throw notFound('Schedule row not found');
    await (await getDb()).query(
      `UPDATE vaccine_schedules SET
         status = $1, review_notes = COALESCE($2, review_notes),
         reviewed_by = $3, reviewed_at = now()
       WHERE id = $4`,
      [body.status, body.reviewNotes ?? null, req.user!.id, req.params.id],
    );
    await audit(req.user!.id, `vaccine_schedule.${body.status}`, 'vaccine_schedule', req.params.id, {
      vaccineName: row.vaccine_name,
      autoAssignable: row.auto_assignable,
      notes: body.reviewNotes ?? null,
    });
    // Approval is what makes the row citable by the AI; re-queueing or
    // rejecting it removes the mirrored document again.
    await syncVaccineScheduleMirror(req.params.id, body.status);
    res.json({ ok: true, status: body.status });
  }),
);
