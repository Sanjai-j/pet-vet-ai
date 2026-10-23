import { getDb, many, one } from '../db.js';
import { addDays, daysBetween, todayInTz } from '../util.js';

/**
 * Vaccination schedule reference + per-pet checkpoints.
 *
 * The reference rows come from the vaccination-schedule workbook. Only rows an
 * administrator has approved, whose age text gives a concrete age, and whose
 * review status is general guidance are auto-scheduled. Everything else stays
 * visible as reference text with "confirm with your veterinarian".
 *
 * This module never invents a due date: without a birth date, or when the
 * animal is already past the primary-series window, it says so instead of
 * guessing (the workbook's own safety rule).
 */

// ── Workbook field parsing ────────────────────────────────────

/** Workbook species labels → application species codes. null = not importable. */
export const WORKBOOK_SPECIES: Record<string, string | null> = {
  dog: 'dog',
  cat: 'cat',
  cattle: 'cow',
  'cattle/buffalo': 'cow',
  goat: 'goat',
  'bird (pet)': 'bird',
  // Poultry flock schedules do not apply to companion birds; importing them
  // would invite a pet-bird owner to follow a hatchery programme.
  'bird (poultry)': null,
};

export type GuidanceLevel = 'general_guidance' | 'vet_decision' | 'programme_only' | 'avian_review';

export function guidanceLevel(reviewStatus: string): GuidanceLevel {
  const text = reviewStatus.toLowerCase();
  if (text.startsWith('general guidance')) return 'general_guidance';
  if (text.includes('avian')) return 'avian_review';
  if (text.includes('programme') || text.includes('program')) return 'programme_only';
  return 'vet_decision';
}

/** "Canine core combination (distemper, ...)" → "canine_core_combination". */
export function vaccineKey(name: string): string {
  return name
    .split('(')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** First concrete age in the text, in days. "6–8 weeks" → 42. null if prose only. */
export function parseFirstDoseDays(text: string): number | null {
  const match = text.match(/(\d+)\s*(?:[–—-]\s*\d+\s*)?(weeks?|months?)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return /^week/i.test(match[2]) ? value * 7 : Math.round(value * 30.44);
}

/** "Repeat every 3–4 weeks until ..." → 4 (the upper bound of the interval). */
export function parseSeriesIntervalWeeks(text: string): number | null {
  const match = text.match(/repeat every\s*(\d+)\s*(?:[–—-]\s*(\d+)\s*)?weeks?/i);
  if (!match) return null;
  const value = Number(match[2] ?? match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Booster interval in months, but only when the text states it plainly at the
 * start ("Every 6 months", "Annually", "1 year"). Prose such as "Commonly at
 * 1 year after primary dose, then per product label" deliberately returns
 * null so the owner sets the date their veterinarian advises.
 */
export function parseBoosterMonths(text: string): number | null {
  const trimmed = text.trim();
  const every = trimmed.match(/^(?:every\s*)?(\d+)\s*(months?|years?)\b/i);
  if (every) {
    const value = Number(every[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return /^year/i.test(every[2]) ? value * 12 : value;
  }
  if (/^annual(ly)?\b/i.test(trimmed)) return 12;
  return null;
}

/** Whole months between two YYYY-MM-DD dates (birth date to today). */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** Add whole months to a YYYY-MM-DD date without drifting across the month end. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The primary series for a row, as day offsets from birth. Puppy/kitten core
 * rows say "repeat every 3–4 weeks until final dose at ≥16 weeks", so the
 * series is generated up to the first dose at or after 16 weeks (max 4 doses).
 */
export function seriesOffsets(firstDoseDays: number, firstDoseText: string, seriesText: string): number[] {
  const intervalWeeks = parseSeriesIntervalWeeks(seriesText);
  if (!intervalWeeks) return [firstDoseDays];
  const finalWeekMatch = firstDoseText.match(/at\s*≥?\s*(\d+)\s*weeks/i) ?? seriesText.match(/at\s*≥?\s*(\d+)\s*weeks/i);
  const finalWeek = finalWeekMatch ? Number(finalWeekMatch[1]) : 16;
  const offsets: number[] = [];
  let weeks = Math.round(firstDoseDays / 7);
  for (let dose = 0; dose < 4; dose += 1) {
    offsets.push(weeks * 7);
    if (weeks >= finalWeek) break;
    weeks += intervalWeeks;
  }
  return offsets;
}

// ── Reference rows ───────────────────────────────────────────

export interface VaccineScheduleRow {
  id: string;
  speciesCode: string;
  vaccineKey: string;
  vaccineName: string;
  firstDoseAgeText: string;
  firstDoseAgeDays: number | null;
  primarySeriesText: string;
  boosterIntervalText: string;
  boosterIntervalMonths: number | null;
  mustCheck: string | null;
  appGuidance: string | null;
  guidanceLevel: GuidanceLevel;
  seriesIntervalWeeks: number | null;
  autoAssignable: boolean;
  referenceBasis: string;
  status: string;
  isDemo: boolean;
}

const SCHEDULE_COLUMNS = `
  id, species_code AS "speciesCode", vaccine_key AS "vaccineKey", vaccine_name AS "vaccineName",
  first_dose_age_text AS "firstDoseAgeText", first_dose_age_days AS "firstDoseAgeDays",
  primary_series_text AS "primarySeriesText", booster_interval_text AS "boosterIntervalText",
  booster_interval_months AS "boosterIntervalMonths",
  must_check_before_scheduling AS "mustCheck", app_guidance AS "appGuidance",
  guidance_level AS "guidanceLevel", series_interval_weeks AS "seriesIntervalWeeks",
  auto_assignable AS "autoAssignable", reference_basis AS "referenceBasis",
  status, is_demo AS "isDemo"`;

export async function approvedSchedules(speciesCode: string): Promise<VaccineScheduleRow[]> {
  return many<VaccineScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM vaccine_schedules
     WHERE species_code = $1 AND status = 'approved'
     ORDER BY auto_assignable DESC, first_dose_age_days NULLS LAST, vaccine_name`,
    [speciesCode],
  );
}

// ── Plan + checkpoint generation ─────────────────────────────

export interface PetForPlan {
  id: string;
  name: string;
  speciesCode: string;
  birthDate: string | null;
  ageEstimateMonths: number | null;
}

export async function loadPetForPlan(petId: string): Promise<PetForPlan | null> {
  return one<PetForPlan>(
    `SELECT id, name, species_code AS "speciesCode", birth_date::text AS "birthDate",
            age_estimate_months AS "ageEstimateMonths"
     FROM pets WHERE id = $1`,
    [petId],
  );
}

export interface CheckpointRow {
  id: string;
  petId: string;
  scheduleId: string | null;
  vaccineName: string;
  vaccineKey: string;
  dueOn: string;
  previousDueOn: string | null;
  status: 'pending' | 'done' | 'removed';
  completedOn: string | null;
  origin: string;
  notes: string | null;
  guidanceLevel: string | null;
  autoAssignable: boolean | null;
}

export async function checkpointsForPet(petId: string): Promise<CheckpointRow[]> {
  return many<CheckpointRow>(
    `SELECT vc.id, vc.pet_id AS "petId", vc.schedule_id AS "scheduleId", vc.vaccine_name AS "vaccineName",
            lower(replace(vc.vaccine_name, ' ', '_')) AS "vaccineKey",
            vc.due_on::text AS "dueOn", vc.previous_due_on::text AS "previousDueOn", vc.status,
            vc.completed_on::text AS "completedOn", vc.origin, vc.notes,
            vs.guidance_level AS "guidanceLevel", vs.auto_assignable AS "autoAssignable"
     FROM vaccination_checkpoints vc
     LEFT JOIN vaccine_schedules vs ON vs.id = vc.schedule_id
     WHERE vc.pet_id = $1 AND vc.status <> 'removed'
     ORDER BY (vc.status = 'pending') DESC, vc.due_on, vc.created_at`,
    [petId],
  );
}

export interface PlanResult {
  pet: PetForPlan;
  checkpoints: CheckpointRow[];
  reference: VaccineScheduleRow[];
  canGenerate: boolean;
  message: string | null;
}

const PRIMARY_SERIES_WINDOW_MONTHS = 18;
const KEEP_RECENT_DAYS = 30;

export async function planForPet(petId: string): Promise<PlanResult | null> {
  const pet = await loadPetForPlan(petId);
  if (!pet) return null;
  const [reference, checkpoints] = await Promise.all([
    approvedSchedules(pet.speciesCode),
    checkpointsForPet(petId),
  ]);

  const autoRows = reference.filter((row) => row.autoAssignable);
  let message: string | null = null;
  let canGenerate = false;
  if (!reference.length) {
    message = 'No approved vaccination schedule exists for this species yet. Add the dates your veterinarian gives you.';
  } else if (!autoRows.length) {
    message = 'This species has no age-based schedule that can be auto-calculated. Ask your veterinarian for the dates.';
  } else if (!pet.birthDate) {
    message = `Add ${pet.name}'s birth date in the profile tab and we can calculate the age-based due dates for the primary series.`;
  } else {
    const ageMonths = monthsBetween(pet.birthDate, todayInTz());
    if (ageMonths > PRIMARY_SERIES_WINDOW_MONTHS) {
      message =
        'This pet is past the primary-series window, so due dates cannot be calculated from age alone. ' +
        'Add the date your veterinarian advises — you will be reminded on that date.';
    } else {
      canGenerate = true;
    }
  }

  return { pet, checkpoints, reference, canGenerate, message };
}

export interface GenerateResult {
  created: number;
  skipped: number;
  message: string | null;
}

/**
 * Create the age-based checkpoints for one pet. Idempotent: a checkpoint or a
 * vaccination record that already covers a reference row is skipped, so the
 * owner can press the button again after adding records.
 */
export async function generateCheckpoints(pet: PetForPlan, userId: string): Promise<GenerateResult> {
  const today = todayInTz();
  if (!pet.birthDate) {
    return { created: 0, skipped: 0, message: `Add ${pet.name}'s birth date first — no date is guessed without it.` };
  }
  if (monthsBetween(pet.birthDate, today) > PRIMARY_SERIES_WINDOW_MONTHS) {
    return {
      created: 0,
      skipped: 0,
      message: 'This pet is past the primary-series window. Add the dates your veterinarian advises instead.',
    };
  }

  const rows = (await approvedSchedules(pet.speciesCode)).filter((row) => row.autoAssignable);
  const records = await many<{ vaccineName: string }>(
    'SELECT vaccine_name AS "vaccineName" FROM vaccinations WHERE pet_id = $1',
    [pet.id],
  );
  const existing = new Set(records.map((r) => vaccineKey(r.vaccineName)));
  const open = await many<{ scheduleId: string | null }>(
    `SELECT schedule_id AS "scheduleId" FROM vaccination_checkpoints
     WHERE pet_id = $1 AND status = 'pending'`,
    [pet.id],
  );
  const openSchedules = new Set(open.map((c) => c.scheduleId).filter(Boolean) as string[]);

  const db = await getDb();
  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const firstDoseDays = row.firstDoseAgeDays ?? parseFirstDoseDays(row.firstDoseAgeText);
    if (firstDoseDays == null) {
      skipped += 1;
      continue;
    }
    if (existing.has(row.vaccineKey) || openSchedules.has(row.id)) {
      skipped += 1;
      continue;
    }
    const offsets = seriesOffsets(firstDoseDays, row.firstDoseAgeText, row.primarySeriesText);
    let rowCreated = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      const dueOn = addDays(pet.birthDate, offsets[index]);
      // A dose long past cannot be actioned and would read as a false overdue.
      if (daysBetween(dueOn, today) > KEEP_RECENT_DAYS) continue;
      const doseNote = offsets.length > 1 ? `Primary series dose ${index + 1} of ${offsets.length}. ` : '';
      await db.query(
        `INSERT INTO vaccination_checkpoints
           (id, pet_id, schedule_id, vaccine_name, due_on, status, origin, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'pending','schedule',$6,$7)`,
        [
          crypto.randomUUID(), pet.id, row.id, row.vaccineName, dueOn,
          `${doseNote}Typical age: ${row.firstDoseAgeText}. Confirm timing with your veterinarian.`,
          userId,
        ],
      );
      rowCreated += 1;
      created += 1;
    }
    if (rowCreated === 0) skipped += 1;
  }

  const message = created
    ? 'Checkpoints created from the approved schedule. They are general guidance — confirm each date with your veterinarian.'
    : 'Nothing new to schedule. Existing records and checkpoints already cover the primary series.';
  return { created, skipped, message };
}

// ── Checkpoint mutations ─────────────────────────────────────

export async function createCheckpoint(input: {
  petId: string;
  userId: string;
  vaccineName: string;
  dueOn: string;
  notes?: string | null;
}): Promise<CheckpointRow> {
  const checkpointId = crypto.randomUUID();
  await (await getDb()).query(
    `INSERT INTO vaccination_checkpoints
       (id, pet_id, schedule_id, vaccine_name, due_on, status, origin, notes, created_by)
     VALUES ($1,$2,NULL,$3,$4,'pending','owner',$5,$6)`,
    [checkpointId, input.petId, input.vaccineName, input.dueOn, input.notes ?? null, input.userId],
  );
  const rows = await checkpointsForPet(input.petId);
  return rows.find((row) => row.id === checkpointId)!;
}

export async function rescheduleCheckpoint(
  checkpoint: { id: string; petId: string; dueOn: string; status: string },
  dueOn: string,
  notes?: string | null,
): Promise<void> {
  await (await getDb()).query(
    `UPDATE vaccination_checkpoints SET
       due_on = $1, previous_due_on = COALESCE(previous_due_on, due_on),
       notes = COALESCE($2, notes), updated_at = now()
     WHERE id = $3`,
    [dueOn, notes ?? null, checkpoint.id],
  );
}

export async function removeCheckpoint(checkpointId: string): Promise<void> {
  await (await getDb()).query(
    `UPDATE vaccination_checkpoints SET status = 'removed', updated_at = now() WHERE id = $1`,
    [checkpointId],
  );
}

export interface CompleteResult {
  vaccinationId: string;
  completedOn: string;
  next: { id: string; dueOn: string } | null;
}

/**
 * Mark a checkpoint done: writes a normal vaccination record (so the pet's
 * record list stays the single source of truth) and, when the reference row
 * states a plain booster interval, schedules the follow-up checkpoint.
 */
export async function completeCheckpoint(input: {
  checkpoint: { id: string; petId: string; scheduleId: string | null; vaccineName: string; status: string };
  userId: string;
  source: 'owner_reported' | 'vet_recorded';
  completedOn?: string;
  notes?: string | null;
}): Promise<CompleteResult> {
  const completedOn = input.completedOn ?? todayInTz();
  const db = await getDb();
  const vaccinationId = crypto.randomUUID();
  const noteParts = ['Recorded from a vaccination checkpoint.'];
  if (input.notes) noteParts.push(input.notes);
  await db.query(
    `INSERT INTO vaccinations
       (id, pet_id, vaccine_name, administered_on, next_due_on, notes, source, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [vaccinationId, input.checkpoint.petId, input.checkpoint.vaccineName, completedOn, null,
      noteParts.join(' '), input.source, input.userId],
  );
  await db.query(
    `UPDATE vaccination_checkpoints SET
       status = 'done', completed_on = $1, vaccination_id = $2, updated_at = now()
     WHERE id = $3`,
    [completedOn, vaccinationId, input.checkpoint.id],
  );

  let next: { id: string; dueOn: string } | null = null;
  if (input.checkpoint.scheduleId) {
    const schedule = await one<{ boosterIntervalMonths: number | null; boosterIntervalText: string }>(
      `SELECT booster_interval_months AS "boosterIntervalMonths",
              booster_interval_text AS "boosterIntervalText"
       FROM vaccine_schedules WHERE id = $1`,
      [input.checkpoint.scheduleId],
    );
    const months = schedule?.boosterIntervalMonths ?? (schedule ? parseBoosterMonths(schedule.boosterIntervalText) : null);
    if (months) {
      const dueOn = addMonths(completedOn, months);
      const nextId = crypto.randomUUID();
      await db.query(
        `INSERT INTO vaccination_checkpoints
           (id, pet_id, schedule_id, vaccine_name, due_on, status, origin, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'pending','follow_up',$6,$7)`,
        [nextId, input.checkpoint.petId, input.checkpoint.scheduleId, input.checkpoint.vaccineName, dueOn,
          `Auto-scheduled from the reference booster interval (${schedule?.boosterIntervalText}). ` +
          'Confirm with your veterinarian, and move the date if they advise a different one.',
          input.userId],
      );
      next = { id: nextId, dueOn };
    }
  }

  return { vaccinationId, completedOn, next };
}
