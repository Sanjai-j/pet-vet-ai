import { getDb, many, one } from '../db.js';
import { chunkText } from '../util.js';

/**
 * Mirror an approved vaccination-schedule row into the AI's knowledge corpus.
 *
 * The schedule workbook is a retrieval source, exactly like the nutrition
 * workbook: only approved rows become documents, and a row that is re-queued
 * or rejected loses its mirror immediately, so the assistant can never cite
 * guidance an administrator has not reviewed.
 */

interface ScheduleRow {
  id: string;
  speciesCode: string;
  speciesLabel: string;
  vaccineName: string;
  firstDoseAgeText: string;
  primarySeriesText: string;
  boosterIntervalText: string;
  mustCheck: string | null;
  appGuidance: string | null;
  guidanceLevel: string;
  autoAssignable: boolean;
  referenceBasis: string;
  isDemo: boolean;
}

export function vaccineDocumentId(scheduleId: string): string {
  return `vax_${scheduleId}`;
}

export async function syncVaccineScheduleMirror(
  scheduleId: string,
  status: 'pending' | 'approved' | 'rejected',
): Promise<void> {
  const db = await getDb();
  const docId = vaccineDocumentId(scheduleId);
  await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId]);
  if (status !== 'approved') {
    await db.query('DELETE FROM knowledge_documents WHERE id = $1', [docId]);
    return;
  }

  const row = await one<ScheduleRow>(
    `SELECT id, species_code AS "speciesCode", species_label AS "speciesLabel",
            vaccine_name AS "vaccineName", first_dose_age_text AS "firstDoseAgeText",
            primary_series_text AS "primarySeriesText", booster_interval_text AS "boosterIntervalText",
            must_check_before_scheduling AS "mustCheck", app_guidance AS "appGuidance",
            guidance_level AS "guidanceLevel", auto_assignable AS "autoAssignable",
            reference_basis AS "referenceBasis", is_demo AS "isDemo"
     FROM vaccine_schedules WHERE id = $1`,
    [scheduleId],
  );
  if (!row) return;

  const guidanceNote =
    row.guidanceLevel === 'general_guidance'
      ? 'Review status: general guidance — a veterinarian confirms the timing for each animal.'
      : row.guidanceLevel === 'programme_only'
        ? 'Review status: official programme only — timing follows the current government or herd programme, not this reference alone.'
        : row.guidanceLevel === 'avian_review'
          ? 'Review status: avian species need their own review; this row is context only.'
          : 'Review status: a veterinarian decides whether and when this vaccine applies.';

  const content = [
    `Species: ${row.speciesLabel} (${row.speciesCode}). Vaccine: ${row.vaccineName}.`,
    `Typical first dose: ${row.firstDoseAgeText}.`,
    `Primary series: ${row.primarySeriesText}.`,
    `Booster: ${row.boosterIntervalText}.`,
    row.mustCheck ? `Check before scheduling: ${row.mustCheck}.` : '',
    row.appGuidance ? `App guidance: ${row.appGuidance}.` : '',
    guidanceNote,
    row.autoAssignable
      ? 'The app may calculate age-based checkpoints from this row only when the pet has a birth date and is still inside the primary-series window. It never invents a date without a birth date.'
      : 'This row never creates an automatic due date; the owner or veterinarian sets the date.',
    `Reference basis: ${row.referenceBasis}.`,
    'Every date is general guidance, not a prescription; the treating veterinarian decides the actual schedule for the animal.',
  ]
    .filter(Boolean)
    .join('\n\n');

  await db.query(
    `INSERT INTO knowledge_documents
       (id, title, species, category, source_org, source_url, content, status, is_demo)
     VALUES ($1,$2,$3::text[],'vaccination',$4,NULL,$5,'approved',$6)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, species = excluded.species, source_org = excluded.source_org,
       content = excluded.content, status = excluded.status`,
    [
      docId,
      `${row.vaccineName} — ${row.speciesLabel} vaccination schedule`.slice(0, 200),
      `{${row.speciesCode}}`,
      'Pet Vet AI vaccination schedule workbook (administrator-reviewed)',
      content,
      row.isDemo,
    ],
  );

  // A schedule row is short, so keep it in one chunk: splitting it tore the
  // vaccine name away from its dates and retrieval could only return the
  // trailing safety line.
  const chunks = chunkText(content, 2000);
  for (let i = 0; i < chunks.length; i += 1) {
    await db.query(
      'INSERT INTO knowledge_chunks (id, document_id, chunk_index, content) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), docId, i, chunks[i]],
    );
  }
}

/** Mirror every currently approved row (used by seeding and the backfill script). */
export async function syncAllApprovedVaccineSchedules(): Promise<number> {
  const rows = await many<{ id: string }>(
    `SELECT id FROM vaccine_schedules WHERE status = 'approved' ORDER BY id`,
  );
  for (const row of rows) {
    await syncVaccineScheduleMirror(row.id, 'approved');
  }
  return rows.length;
}
