import fs from 'node:fs';
import { closeDb, getDb, one } from './db.js';
import { readXlsxSheets } from './import-workbook.js';
import {
  guidanceLevel,
  parseBoosterMonths,
  parseFirstDoseDays,
  parseSeriesIntervalWeeks,
  vaccineKey,
  WORKBOOK_SPECIES,
} from './services/vaccine-schedule.js';

/**
 * Vaccination schedule importer.
 *
 *   npm run import:vaccine-schedule -- <path/to/file.xlsx>            import
 *   npm run import:vaccine-schedule -- <file.xlsx> --dry-run          validate only
 *
 * Every row is validated before anything is written. Rows land as 'pending'
 * and are not used to schedule anything until an administrator approves them.
 * An approved row is never overwritten by a later import.
 */

const SHEET = 'Vaccination_Reference';

const REQUIRED_COLUMNS = [
  'species',
  'vaccine_or_disease',
  'typical_first_dose_age',
  'primary_series_or_booster',
  'later_booster_interval',
  'reference_basis',
  'review_status',
];

interface Candidate {
  speciesCode: string;
  speciesLabel: string;
  vaccineKey: string;
  vaccineName: string;
  firstDoseText: string;
  firstDoseDays: number | null;
  seriesText: string;
  boosterText: string;
  boosterMonths: number | null;
  mustCheck: string | null;
  appGuidance: string | null;
  guidance: ReturnType<typeof guidanceLevel>;
  seriesWeeks: number | null;
  autoAssignable: boolean;
  referenceBasis: string;
}

export async function importVaccinationSchedule(
  sheets: Record<string, string[][]>,
  options: { dryRun?: boolean } = {},
): Promise<{ imported: number; pending: number; skipped: number; warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rows = sheets[SHEET];
  if (!rows || !rows.length) {
    return { imported: 0, pending: 0, skipped: 0, warnings, errors: [`Sheet "${SHEET}" is missing`] };
  }

  const header = rows[0].map((cell) => cell.trim());
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) errors.push(`Sheet "${SHEET}" is missing the "${column}" column`);
  }
  if (errors.length) return { imported: 0, pending: 0, skipped: 0, warnings, errors };

  const index = new Map(header.map((name, position) => [name, position]));
  const cell = (row: string[], name: string) => (row[index.get(name) ?? -1] ?? '').trim();

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || row.every((value) => !value)) continue;

    const label = cell(row, 'species');
    const speciesCode = WORKBOOK_SPECIES[label.toLowerCase()];
    if (speciesCode === null) {
      warnings.push(`row ${r + 1}: "${label}" is a poultry flock schedule and is not imported for companion pets`);
      continue;
    }
    if (!speciesCode) {
      errors.push(`row ${r + 1}: unknown species "${label}"`);
      continue;
    }

    const vaccineName = cell(row, 'vaccine_or_disease');
    if (!vaccineName) {
      errors.push(`row ${r + 1}: missing vaccine name`);
      continue;
    }
    const key = vaccineKey(vaccineName);
    if (!key) {
      errors.push(`row ${r + 1}: vaccine name "${vaccineName}" has no usable key`);
      continue;
    }
    const unique = `${speciesCode}:${key}`;
    if (seen.has(unique)) {
      warnings.push(`row ${r + 1}: duplicate ${label} / ${vaccineName} — first occurrence kept`);
      continue;
    }
    seen.add(unique);

    const firstDoseText = cell(row, 'typical_first_dose_age');
    const seriesText = cell(row, 'primary_series_or_booster');
    const boosterText = cell(row, 'later_booster_interval');
    if (!firstDoseText || !seriesText || !boosterText) {
      errors.push(`row ${r + 1}: age, series and booster text are all required`);
      continue;
    }

    const level = guidanceLevel(cell(row, 'review_status'));
    const firstDoseDays = parseFirstDoseDays(firstDoseText);
    candidates.push({
      speciesCode,
      speciesLabel: label,
      vaccineKey: key,
      vaccineName,
      firstDoseText,
      firstDoseDays,
      seriesText,
      boosterText,
      boosterMonths: parseBoosterMonths(boosterText),
      mustCheck: cell(row, 'must_check_before_scheduling') || null,
      appGuidance: cell(row, 'app_guidance') || null,
      guidance: level,
      seriesWeeks: parseSeriesIntervalWeeks(seriesText),
      // Only plain age-based general guidance is allowed to create checkpoints.
      autoAssignable: level === 'general_guidance' && firstDoseDays !== null,
      referenceBasis: cell(row, 'reference_basis') || 'Workbook row',
    });
  }

  if (errors.length) return { imported: 0, pending: 0, skipped: 0, warnings, errors };
  if (options.dryRun) {
    return { imported: 0, pending: candidates.length, skipped: 0, warnings, errors };
  }

  const db = await getDb();
  let imported = 0;
  let skipped = 0;
  for (const c of candidates) {
    const existing = await one<{ id: string; status: string }>(
      'SELECT id, status FROM vaccine_schedules WHERE species_code = $1 AND vaccine_key = $2',
      [c.speciesCode, c.vaccineKey],
    );
    if (existing) {
      // Approved guidance is never replaced by a re-import.
      skipped += 1;
      continue;
    }
    await db.query(
      `INSERT INTO vaccine_schedules
         (id, species_code, species_label, vaccine_key, vaccine_name, first_dose_age_text,
          first_dose_age_days, primary_series_text, booster_interval_text, booster_interval_months,
          must_check_before_scheduling, app_guidance, guidance_level, series_interval_weeks,
          auto_assignable, reference_basis, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')`,
      [
        crypto.randomUUID(), c.speciesCode, c.speciesLabel, c.vaccineKey, c.vaccineName,
        c.firstDoseText, c.firstDoseDays, c.seriesText, c.boosterText, c.boosterMonths,
        c.mustCheck, c.appGuidance, c.guidance, c.seriesWeeks, c.autoAssignable, c.referenceBasis,
      ],
    );
    imported += 1;
  }
  return { imported, pending: imported, skipped, warnings, errors };
}

const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((arg) => !arg.startsWith('--'));

  if (!file) {
    console.error('Usage: npm run import:vaccine-schedule -- <path/to/workbook.xlsx> [--dry-run]');
    process.exitCode = 1;
  } else if (!fs.existsSync(file)) {
    console.error(`[import] file not found: ${file}`);
    process.exitCode = 1;
  } else {
    try {
      const sheets = readXlsxSheets(file);
      console.log(`[import] workbook: ${file}`);
      console.log(`[import] mode: ${dryRun ? 'DRY RUN (no writes)' : 'import as pending review rows'}`);
      const report = await importVaccinationSchedule(sheets, { dryRun });
      for (const warning of report.warnings) console.warn(`[import] warning: ${warning}`);
      for (const error of report.errors) console.error(`[import] ERROR: ${error}`);
      if (report.errors.length) {
        console.error(`[import] ${report.errors.length} validation error(s) — nothing was written.`);
        process.exitCode = 1;
      } else {
        console.log(
          `[import] ${dryRun ? 'staged' : 'imported'}: ${report.pending} schedule row(s), ` +
          `skipped ${report.skipped} already in the review queue or approved.`,
        );
        console.log('[import] rows are pending veterinary review — approve them in the admin console before they can schedule anything.');
      }
    } catch (err) {
      console.error('[import] failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  }
}
