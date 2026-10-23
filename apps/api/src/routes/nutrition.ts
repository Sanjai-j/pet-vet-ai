import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { audit } from '../audit.js';
import {
  approvedHazards, hazardForFoodQuery, nutritionProfileForPet,
} from '../services/nutrition.js';
import { syncNutritionRagMirror } from '../services/nutrition-rag.js';

export const nutritionRouter = Router();
nutritionRouter.use(requireAuth);

export const nutritionAdminRouter = Router();
nutritionAdminRouter.use(requireAuth, requireRole('admin'));

// ── Owner-facing ──────────────────────────────────────────────

nutritionRouter.get(
  '/pets/:petId/nutrition',
  asyncHandler(async (req, res) => {
    res.json(await nutritionProfileForPet(req.params.petId, req.user!));
  }),
);

nutritionRouter.get(
  '/nutrition/hazards',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      species: z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other']).default('dog'),
      q: z.string().max(120).default(''),
    });
    const parsed = parse(schema, req.query);
    const species = parsed.species ?? 'dog';
    const q = parsed.q ?? '';
    if (!q.trim()) {
      const list = await approvedHazards(species);
      res.json({
        species,
        matches: list,
        coverageKnown: list.length > 0,
        note: list.length
          ? 'All approved hazards for this species. If any listed food has been eaten, contact a veterinarian now.'
          : 'No approved hazard records exist for this species yet — absence of records does not mean a food is safe.',
      });
      return;
    }
    const { matches, coverageKnown } = await hazardForFoodQuery(species, q);
    res.json({
      species,
      matches,
      coverageKnown,
      note: coverageKnown
        ? 'Matches from administrator-approved records only. Not listed does not mean safe.'
        : 'No approved hazard records exist for this species yet — absence of records does not mean safe.',
    });
  }),
);

// ── Administrator review workflow ─────────────────────────────

const RECORD_KINDS = ['guidance', 'hazard', 'recipe', 'breed', 'health_rule', 'source'] as const;
type RecordKind = (typeof RECORD_KINDS)[number];

const TABLES: Record<RecordKind, string> = {
  guidance: 'nutrition_guidance',
  hazard: 'nutrition_hazards',
  recipe: 'nutrition_recipes',
  breed: 'nutrition_breed_guidance',
  health_rule: 'nutrition_health_rules',
  source: 'nutrition_sources',
};

const EDITABLE: Record<RecordKind, Record<string, string>> = {
  guidance: {
    generalDietGuidance: 'general_diet_guidance', suitableFoodsText: 'suitable_foods_text',
    hazardsToAvoidText: 'hazards_to_avoid_text', recipeGuidanceText: 'recipe_guidance_text',
    goalSpecificGuidance: 'goal_specific_guidance', safetyCautions: 'safety_cautions',
    disclaimer: 'disclaimer',
  },
  hazard: {
    classification: 'classification', severity: 'severity', risk: 'risk',
    recommendedAction: 'recommended_action',
  },
  recipe: {
    dietRole: 'diet_role', applicability: 'applicability', safetyNotes: 'safety_notes',
    storageInstructions: 'storage_instructions', storageKnown: 'storage_known',
  },
  breed: {
    generalGuidance: 'general_guidance', limitation: 'limitation', referralRule: 'referral_rule',
  },
  health_rule: {
    generalGuidance: 'general_guidance', safetyRule: 'safety_rule', referralRule: 'referral_rule',
  },
  source: { usageNotes: 'usage_notes' },
};

const editSchema: Record<RecordKind, z.ZodTypeAny> = {
  guidance: z.object({
    generalDietGuidance: z.string().min(10).max(4000).optional(),
    suitableFoodsText: z.string().min(10).max(4000).optional(),
    hazardsToAvoidText: z.string().min(10).max(4000).optional(),
    recipeGuidanceText: z.string().min(10).max(4000).optional(),
    goalSpecificGuidance: z.string().min(10).max(4000).optional(),
    safetyCautions: z.string().min(10).max(4000).optional(),
    disclaimer: z.string().min(10).max(2000).optional(),
  }),
  hazard: z.object({
    classification: z.string().min(2).max(120).optional(),
    severity: z.enum(['toxic', 'potentially_toxic', 'dangerous', 'caution',
      'nutritionally_inappropriate', 'unknown']).optional(),
    risk: z.string().min(5).max(1000).optional(),
    recommendedAction: z.string().min(5).max(1000).optional(),
  }),
  recipe: z.object({
    dietRole: z.string().min(3).max(160).optional(),
    applicability: z.string().min(3).max(600).optional(),
    safetyNotes: z.string().min(3).max(2000).optional(),
    storageInstructions: z.string().min(3).max(2000).nullable().optional(),
    storageKnown: z.boolean().optional(),
  }),
  breed: z.object({
    generalGuidance: z.string().min(10).max(4000).optional(),
    limitation: z.string().min(10).max(2000).optional(),
    referralRule: z.string().min(10).max(2000).optional(),
  }),
  health_rule: z.object({
    generalGuidance: z.string().min(10).max(2000).optional(),
    safetyRule: z.string().min(5).max(2000).optional(),
    referralRule: z.string().min(5).max(2000).optional(),
  }),
  source: z.object({ usageNotes: z.string().min(1).max(2000).optional() }),
};

function kindFromParam(value: string): RecordKind {
  if (!(RECORD_KINDS as readonly string[]).includes(value)) {
    throw badRequest(`Unknown record kind. Use one of: ${RECORD_KINDS.join(', ')}`);
  }
  return value as RecordKind;
}

async function snapshot(kind: RecordKind, id: string): Promise<Record<string, unknown>> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM ${TABLES[kind]} WHERE id = $1`, [id],
  );
  if (!row) throw notFound(`${kind} record not found`);
  return row;
}

async function versionBump(
  kind: RecordKind,
  id: string,
  action: 'imported' | 'edited' | 'approved' | 'rejected' | 'reopened',
  actorId: string | null,
  notes: string | null,
): Promise<number> {
  const db = await getDb();
  const current = await one<{ version: number }>(
    `SELECT version FROM ${TABLES[kind]} WHERE id = $1`, [id],
  );
  const version = (current?.version ?? 0) + (action === 'imported' ? 0 : 1);
  if (action !== 'imported') {
    await db.query(`UPDATE ${TABLES[kind]} SET version = $1, updated_at = now() WHERE id = $2`, [version, id]);
  }
  await db.query(
    `INSERT INTO nutrition_record_versions (id, record_type, record_id, version, action, snapshot, actor_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (record_type, record_id, version, action) DO NOTHING`,
    [crypto.randomUUID(), kind, id, version, action, JSON.stringify(await snapshot(kind, id)), actorId, notes],
  );
  return version;
}

nutritionAdminRouter.get(
  '/admin/nutrition/queue',
  asyncHandler(async (_req, res) => {
    const rows = await many<{ kind: string; pending: number; approved: number; rejected: number }>(
      `SELECT 'guidance' AS kind,
              count(*) FILTER (WHERE review_status='pending')::int AS pending,
              count(*) FILTER (WHERE review_status='approved')::int AS approved,
              count(*) FILTER (WHERE review_status='rejected')::int AS rejected
       FROM nutrition_guidance
       UNION ALL SELECT 'hazard',
              count(*) FILTER (WHERE review_status='pending')::int,
              count(*) FILTER (WHERE review_status='approved')::int,
              count(*) FILTER (WHERE review_status='rejected')::int
       FROM nutrition_hazards
       UNION ALL SELECT 'recipe',
              count(*) FILTER (WHERE review_status='pending')::int,
              count(*) FILTER (WHERE review_status='approved')::int,
              count(*) FILTER (WHERE review_status='rejected')::int
       FROM nutrition_recipes
       UNION ALL SELECT 'breed',
              count(*) FILTER (WHERE review_status='pending')::int,
              count(*) FILTER (WHERE review_status='approved')::int,
              count(*) FILTER (WHERE review_status='rejected')::int
       FROM nutrition_breed_guidance
       UNION ALL SELECT 'health_rule',
              count(*) FILTER (WHERE review_status='pending')::int,
              count(*) FILTER (WHERE review_status='approved')::int,
              count(*) FILTER (WHERE review_status='rejected')::int
       FROM nutrition_health_rules
       UNION ALL SELECT 'source',
              count(*) FILTER (WHERE review_status='pending')::int,
              count(*) FILTER (WHERE review_status='approved')::int,
              count(*) FILTER (WHERE review_status='rejected')::int
       FROM nutrition_sources`,
    );
    res.json({ queue: rows });
  }),
);

nutritionAdminRouter.get(
  '/admin/nutrition/:kind',
  asyncHandler(async (req, res) => {
    const kind = kindFromParam(req.params.kind);
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
      throw badRequest('status must be pending, approved, rejected or all');
    }
    // Optional species filter: hazard rows store species_codes (array),
    // the rest store a single species_code. Sources have neither.
    const species = typeof req.query.species === 'string' && req.query.species ? req.query.species : null;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') {
      params.push(status);
      conditions.push(`review_status = $${params.length}`);
    }
    if (species) {
      params.push(species);
      if (kind === 'hazard') {
        conditions.push(`$${params.length} = ANY(species_codes)`);
      } else if (kind !== 'source') {
        conditions.push(`species_code = $${params.length}`);
      }
    }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await many(
      `SELECT * FROM ${TABLES[kind]} ${where}
       ORDER BY CASE review_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ kind, records: rows });
  }),
);

nutritionAdminRouter.get(
  '/admin/nutrition/:kind/:id/versions',
  asyncHandler(async (req, res) => {
    const kind = kindFromParam(req.params.kind);
    const rows = await many(
      `SELECT v.id, v.version, v.action, v.snapshot, v.notes, v.created_at AS "createdAt",
              u.full_name AS "actorName"
       FROM nutrition_record_versions v LEFT JOIN users u ON u.id = v.actor_id
       WHERE v.record_type = $1 AND v.record_id = $2
       ORDER BY v.created_at DESC`,
      [kind, req.params.id],
    );
    res.json({ versions: rows });
  }),
);

nutritionAdminRouter.patch(
  '/admin/nutrition/:kind/:id',
  asyncHandler(async (req, res) => {
    const kind = kindFromParam(req.params.kind);
    const body = parse(editSchema[kind], req.body);
    const existing = await one<{ id: string; review_status: string }>(
      `SELECT id, review_status FROM ${TABLES[kind]} WHERE id = $1`, [req.params.id],
    );
    if (!existing) throw notFound(`${kind} record not found`);

    const mapping = EDITABLE[kind];
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, column] of Object.entries(mapping)) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) {
        sets.push(`${column} = $${i++}`);
        values.push(value);
      }
    }
    if (!sets.length) throw badRequest('No editable fields supplied');

    // Editing an approved record returns it to the review queue so owners
    // never see unreviewed edits (same rule as knowledge documents).
    const newStatus: 'pending' | 'approved' | 'rejected' =
      existing.review_status === 'approved'
        ? 'pending'
        : (existing.review_status as 'pending' | 'rejected');
    sets.push(`review_status = $${i++}`, `updated_at = now()`);
    values.push(newStatus, req.params.id);
    await (await getDb()).query(
      `UPDATE ${TABLES[kind]} SET ${sets.join(', ')} WHERE id = $${i}`, values,
    );
    await versionBump(kind, req.params.id, 'edited', req.user!.id,
      typeof req.body?.reviewNotes === 'string' ? req.body.reviewNotes : null);
    if (existing.review_status === 'approved') await syncNutritionRagMirror(kind, req.params.id, newStatus);
    await audit(req.user!.id, `nutrition.${kind}_edit`, TABLES[kind], req.params.id, {
      status: newStatus,
    });
    res.json({ ok: true, reviewStatus: newStatus });
  }),
);

nutritionAdminRouter.post(
  '/admin/nutrition/:kind/bulk-review',
  asyncHandler(async (req, res) => {
    const kind = kindFromParam(req.params.kind);
    const body = parse(
      z.object({
        status: z.enum(['approved', 'rejected']),
        ids: z.array(z.string().min(1)).min(1).max(500).optional(),
        // Approve/reject every pending record of this kind in one action.
        allPending: z.boolean().optional(),
        species: z.string().max(20).optional(),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    if (!body.ids?.length && !body.allPending) {
      throw badRequest('Provide ids[] or allPending: true');
    }
    const db = await getDb();

    // Resolve the target set. Pending-only for allPending so an admin cannot
    // silently bulk-overwrite records already reviewed.
    let ids = body.ids ?? [];
    if (body.allPending) {
      // Species column differs per kind: hazards store species_codes (array),
      // guidance/recipe/breed/health_rule store species_code, sources have none.
      const speciesClause = !body.species ? null
        : kind === 'hazard' ? '$1 = ANY(species_codes)'
        : kind === 'source' ? 'FALSE'
        : 'species_code = $1';
      const rows = await many<{ id: string }>(
        `SELECT id FROM ${TABLES[kind]}
         WHERE review_status = 'pending'
           AND ($1::text IS NULL OR ${speciesClause ?? 'TRUE'})
         LIMIT 500`,
        [body.species ?? null],
      );
      ids = rows.map((r) => r.id);
    }
    if (!ids.length) {
      res.json({ ok: true, matched: 0, updated: 0, reviewStatus: body.status });
      return;
    }

    // Bulk actions apply to pending records only. Anything already reviewed
    // is skipped and reported back, so a bulk click can never silently
    // re-decide an individual veterinary review.
    const targets = await many<{ id: string; review_status: string }>(
      `SELECT id, review_status FROM ${TABLES[kind]} WHERE id = ANY($1::text[])`,
      [ids],
    );
    const eligible = targets.filter((t) => t.review_status === 'pending').map((t) => t.id);
    const skipped = targets.length - eligible.length;

    if (eligible.length) {
      await db.query(
        `UPDATE ${TABLES[kind]}
         SET review_status = $1, review_notes = COALESCE($2, review_notes),
             reviewed_by = $3, reviewed_at = now(), updated_at = now(),
             version = version + 1
         WHERE id = ANY($4::text[]) AND review_status = 'pending'`,
        [body.status, body.notes ?? null, req.user!.id, eligible],
      );
      // Snapshot each changed record so the version history stays complete,
      // then sync the RAG mirror for the ones that became visible.
      const snapshotted = await many<Record<string, unknown>>(
        `SELECT * FROM ${TABLES[kind]} WHERE id = ANY($1::text[])`,
        [eligible],
      );
      for (const row of snapshotted) {
        await db.query(
          `INSERT INTO nutrition_record_versions
             (id, record_type, record_id, version, action, snapshot, actor_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (record_type, record_id, version, action) DO NOTHING`,
          [crypto.randomUUID(), kind, row.id, row.version,
           body.status === 'approved' ? 'approved' : 'rejected',
           JSON.stringify(row), req.user!.id, body.notes ?? null],
        );
      }
      if (body.status === 'approved') {
        for (const id of eligible) await syncNutritionRagMirror(kind, id, 'approved');
      } else {
        for (const id of eligible) await syncNutritionRagMirror(kind, id, 'rejected');
      }
    }

    await audit(req.user!.id, `nutrition.${kind}_bulk_${body.status}`, TABLES[kind], null, {
      matched: targets.length,
      updated: eligible.length,
      skippedAlreadyReviewed: skipped,
      species: body.species ?? null,
      notes: body.notes ?? null,
    });
    res.json({
      ok: true,
      matched: targets.length,
      updated: eligible.length,
      skippedAlreadyReviewed: skipped,
      reviewStatus: body.status,
    });
  }),
);

nutritionAdminRouter.post(
  '/admin/nutrition/:kind/:id/review',
  asyncHandler(async (req, res) => {
    const kind = kindFromParam(req.params.kind);
    const body = parse(
      z.object({
        status: z.enum(['approved', 'rejected', 'pending']),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const existing = await one<{ id: string; review_status: string }>(
      `SELECT id, review_status FROM ${TABLES[kind]} WHERE id = $1`, [req.params.id],
    );
    if (!existing) throw notFound(`${kind} record not found`);
    if (existing.review_status === body.status && body.status !== 'pending') {
      throw badRequest(`Record is already ${body.status}`);
    }

    await (await getDb()).query(
      `UPDATE ${TABLES[kind]} SET review_status = $1, review_notes = COALESCE($2, review_notes),
         reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $4`,
      [body.status, body.notes ?? null, req.user!.id, req.params.id],
    );
    const action = body.status === 'approved' ? 'approved'
      : body.status === 'rejected' ? 'rejected' : 'reopened';
    await versionBump(kind, req.params.id, action, req.user!.id, body.notes ?? null);
    await syncNutritionRagMirror(kind, req.params.id, body.status);
    await audit(req.user!.id, `nutrition.${kind}_${body.status}`, TABLES[kind], req.params.id, {
      notes: body.notes ?? null,
    });
    res.json({ ok: true, reviewStatus: body.status });
  }),
);
