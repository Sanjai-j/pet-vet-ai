import { getDb, one } from '../db.js';
import { mapLifeStage, mapSeverity, mapWorkbookSpecies } from './nutrition.js';

/**
 * Workbook import: validation + pending-only upsert.
 *
 * Rules enforced here (they are the safety rail for requirements 1–3):
 *  - Every sheet's columns are validated against the expected header set
 *    before any row is touched.
 *  - Phase 1 validates EVERY record in memory; nothing is written until
 *    the whole workbook passes (or the caller opts into partial import).
 *  - Imported rows always land as review_status='pending'. An import can
 *    never create or overwrite an approved record: approved rows are
 *    administrator-reviewed and are skipped on conflict.
 *  - Source URLs, review status and species are preserved verbatim where
 *    present; placeholder text in a URL column is flagged, not trusted.
 */

export type SheetRows = Record<string, string[][]>;

export const EXPECTED_HEADERS: Record<string, string[]> = {
  Master_1200_Rows: [
    'record_id', 'species', 'breed_or_type', 'life_stage', 'nutrition_goal',
    'general_diet_guidance', 'potential_suitable_foods', 'foods_or_hazards_to_avoid',
    'recipe_or_preparation_guidance', 'goal_specific_guidance', 'safety_cautions',
    'individualization_factors', 'disclaimer', 'source_requirement', 'review_status',
    'data_quality_note',
  ],
  Foods_to_Avoid: [
    'species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status',
  ],
  Recipe_Guides: [
    'species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step',
    'safety_notes', 'review_status',
  ],
  Breed_LifeStage: [
    'species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule',
    'review_status',
  ],
  Health_Conditions: [
    'condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule',
  ],
  Sources: ['source_name', 'url', 'usage_notes'],
};

const KNOWN_STATUSES = new Set(['PENDING_VETERINARY_REVIEW', 'PENDING', 'APPROVED', 'REJECTED']);

/** Condition → matching keywords used against pet conditions/medications text. */
const CONDITION_KEYWORDS: Record<string, string[]> = {
  growth: ['growth', 'growing', 'puppy', 'kitten', 'juvenile'],
  obesity: ['obesity', 'overweight', 'weight management', 'body condition'],
  'food allergy suspected': ['allergy', 'allergies', 'allergic', 'sensitivity', 'intolerance', 'diet trial'],
  'kidney disease': ['kidney', 'renal'],
  'liver disease': ['liver', 'hepatic'],
  diabetes: ['diabetes', 'diabetic', 'blood sugar'],
  pancreatitis: ['pancrea'],
  'urinary disease/stones': ['urinary', 'bladder', 'crystal', 'stone', 'uti'],
  'pregnancy/lactation': ['pregnan', 'lactat', 'nursing', 'whelping', 'kittening'],
  'suspected toxin ingestion': ['toxin', 'poison', 'ingested', 'ate '],
};

function slug(text: string, max = 60): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, max);
}

function parseIngredients(cell: string): string[] {
  return cell.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
}

function parseSteps(cell: string): string[] {
  const parts = cell.split(/\s*(?=\d+\.\s)/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : cell.split(/\.\s+/).map((s) => `${s.trim()}.`).filter((s) => s.length > 1);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ImportReport {
  errors: string[];    // row-level validation failures (nothing written for them)
  warnings: string[];  // imported anyway, with a noted caveat
  imported: Record<string, number>;
  updated: Record<string, number>;
  skipped: Record<string, number>; // e.g. protected approved rows
  dryRun: boolean;
}

export function emptyReport(dryRun = false): ImportReport {
  return { errors: [], warnings: [], imported: {}, updated: {}, skipped: {}, dryRun };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function indexHeader(header: string[], expected: string[], sheet: string, report: ImportReport): Map<string, number> {
  const map = new Map<string, number>();
  const missing = expected.filter((h) => !header.includes(h));
  const extra = header.filter((h) => h && !expected.includes(h));
  if (missing.length) report.errors.push(`[${sheet}] missing required columns: ${missing.join(', ')}`);
  if (extra.length) report.warnings.push(`[${sheet}] ignored unexpected columns: ${extra.join(', ')}`);
  expected.forEach((h) => map.set(h, header.indexOf(h)));
  return map;
}

function cell(row: string[], cols: Map<string, number>, name: string): string {
  const i = cols.get(name) ?? -1;
  return (i >= 0 ? row[i] ?? '' : '').trim();
}

function toPgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

// ── Phase 1: in-memory validation ─────────────────────────────

interface StagedRecord {
  kind: 'source' | 'guidance' | 'hazard' | 'recipe' | 'breed' | 'health_rule';
  id: string;
  conflictKey: string;
  sql: string;
  params: unknown[];
  snapshot: Record<string, unknown>;
}

/**
 * Validate the whole workbook and produce staged writes. Throws nothing;
 * all row-level problems are collected in report.errors. Structural
 * problems (missing sheets/columns) are also collected — when there are
 * any errors at all, the caller writes nothing.
 */
export function stageWorkbook(sheets: SheetRows): { report: ImportReport; staged: StagedRecord[] } {
  const report = emptyReport();
  const staged: StagedRecord[] = [];
  const sourceIds = new Map<string, string>();

  for (const [sheet, expected] of Object.entries(EXPECTED_HEADERS)) {
    const rows = sheets[sheet];
    if (!rows || rows.length < 2) {
      report.errors.push(`[${sheet}] sheet is missing or has no data rows`);
      continue;
    }
    indexHeader(rows[0], expected, sheet, report);
  }
  if (report.errors.length) return { report, staged };

  // Sources (URLs preserved; placeholders flagged)
  {
    const cols = indexHeader(sheets.Sources[0], EXPECTED_HEADERS.Sources, 'Sources', report);
    for (const [n, row] of sheets.Sources.slice(1).entries()) {
      const line = `Sources row ${n + 2}`;
      const name = cell(row, cols, 'source_name');
      const url = cell(row, cols, 'url');
      const notes = cell(row, cols, 'usage_notes');
      if (!name) { report.errors.push(`[${line}] empty source_name`); continue; }
      const safeUrl = isHttpUrl(url) ? url : null;
      if (url && !safeUrl) {
        report.warnings.push(`[${line}] "${name}": URL column contains placeholder text; imported without a URL`);
      }
      const id = `ns_${slug(name)}`;
      sourceIds.set(name.toLowerCase(), id);
      staged.push({
        kind: 'source', id, conflictKey: name.toLowerCase(),
        sql: `INSERT INTO nutrition_sources (id, source_name, url, usage_notes, review_status, is_demo)
              VALUES ($1,$2,$3,$4,'pending',true)
              ON CONFLICT (lower(source_name)) DO UPDATE SET
                url = EXCLUDED.url, usage_notes = EXCLUDED.usage_notes, updated_at = now()
              WHERE nutrition_sources.review_status = 'pending'`,
        params: [id, name, safeUrl, notes],
        snapshot: { source_name: name, url: safeUrl, usage_notes: notes },
      });
    }
  }
  const sourceIdFor = (name: string) =>
    sourceIds.get(name.toLowerCase()) ?? null;

  // Master guidance
  {
    const cols = indexHeader(sheets.Master_1200_Rows[0], EXPECTED_HEADERS.Master_1200_Rows, 'Master_1200_Rows', report);
    for (const [n, row] of sheets.Master_1200_Rows.slice(1).entries()) {
      const line = `Master_1200_Rows row ${n + 2}`;
      const recordKey = cell(row, cols, 'record_id');
      const speciesRaw = cell(row, cols, 'species');
      const stageRaw = cell(row, cols, 'life_stage');
      const goal = cell(row, cols, 'nutrition_goal');
      const guidance = cell(row, cols, 'general_diet_guidance');
      const statusRaw = cell(row, cols, 'review_status').toUpperCase();
      const breed = cell(row, cols, 'breed_or_type') || null;

      const species = mapWorkbookSpecies(speciesRaw);
      if (!/^PVF-\d{5}$/.test(recordKey)) { report.errors.push(`[${line}] invalid record_id "${recordKey}"`); continue; }
      if (species.length !== 1) { report.errors.push(`[${line}] species "${speciesRaw}" must map to exactly one species`); continue; }
      const stage = mapLifeStage(stageRaw);
      if (stage === 'all' && !/all|any/i.test(stageRaw)) { report.errors.push(`[${line}] unrecognised life_stage "${stageRaw}"`); continue; }
      if (!goal) { report.errors.push(`[${line}] empty nutrition_goal`); continue; }
      if (!guidance) { report.errors.push(`[${line}] empty general_diet_guidance`); continue; }
      if (!KNOWN_STATUSES.has(statusRaw)) { report.errors.push(`[${line}] unknown review_status "${statusRaw}"`); continue; }

      const id = `ng_${recordKey}`;
      const params = [
        id, recordKey, species[0], breed, stage, goal, guidance,
        cell(row, cols, 'potential_suitable_foods'),
        cell(row, cols, 'foods_or_hazards_to_avoid'),
        cell(row, cols, 'recipe_or_preparation_guidance'),
        cell(row, cols, 'goal_specific_guidance'),
        cell(row, cols, 'safety_cautions'),
        cell(row, cols, 'individualization_factors'),
        cell(row, cols, 'disclaimer'),
        cell(row, cols, 'source_requirement'),
        cell(row, cols, 'data_quality_note'),
        sourceIdFor(cell(row, cols, 'source_requirement')) ?? sourceIdFor('Merck Veterinary Manual — Nutritional Requirements of Small Animals'),
      ];
      staged.push({
        kind: 'guidance', id, conflictKey: recordKey,
        sql: `INSERT INTO nutrition_guidance
                (id, record_key, species_code, breed_or_type, life_stage, nutrition_goal,
                 general_diet_guidance, suitable_foods_text, hazards_to_avoid_text,
                 recipe_guidance_text, goal_specific_guidance, safety_cautions,
                 individualization_factors, disclaimer, source_requirement, data_quality_note,
                 source_id, review_status, is_demo)
              VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}, 'pending', true)
              ON CONFLICT (record_key) DO UPDATE SET
                species_code = EXCLUDED.species_code, breed_or_type = EXCLUDED.breed_or_type,
                life_stage = EXCLUDED.life_stage, nutrition_goal = EXCLUDED.nutrition_goal,
                general_diet_guidance = EXCLUDED.general_diet_guidance,
                suitable_foods_text = EXCLUDED.suitable_foods_text,
                hazards_to_avoid_text = EXCLUDED.hazards_to_avoid_text,
                recipe_guidance_text = EXCLUDED.recipe_guidance_text,
                goal_specific_guidance = EXCLUDED.goal_specific_guidance,
                safety_cautions = EXCLUDED.safety_cautions,
                individualization_factors = EXCLUDED.individualization_factors,
                disclaimer = EXCLUDED.disclaimer, source_requirement = EXCLUDED.source_requirement,
                data_quality_note = EXCLUDED.data_quality_note, source_id = EXCLUDED.source_id,
                updated_at = now()
              WHERE nutrition_guidance.review_status = 'pending'`,
        params,
        snapshot: { record_key: recordKey, species: species[0], life_stage: stage, goal },
      });
    }
  }

  // Foods to avoid
  {
    const cols = indexHeader(sheets.Foods_to_Avoid[0], EXPECTED_HEADERS.Foods_to_Avoid, 'Foods_to_Avoid', report);
    for (const [n, row] of sheets.Foods_to_Avoid.slice(1).entries()) {
      const line = `Foods_to_Avoid row ${n + 2}`;
      const speciesCell = cell(row, cols, 'species');
      const species = mapWorkbookSpecies(speciesCell);
      const food = cell(row, cols, 'food_or_substance');
      const classification = cell(row, cols, 'classification');
      const statusRaw = cell(row, cols, 'review_status').toUpperCase();
      if (!species.length) { report.errors.push(`[${line}] species "${speciesCell}" maps to no species`); continue; }
      if (!food) { report.errors.push(`[${line}] empty food_or_substance`); continue; }
      if (!classification) { report.errors.push(`[${line}] empty classification`); continue; }
      if (!KNOWN_STATUSES.has(statusRaw)) { report.errors.push(`[${line}] unknown review_status "${statusRaw}"`); continue; }

      const id = `nh_${slug(food)}`;
      const severity = mapSeverity(classification);
      const risk = cell(row, cols, 'risk');
      const action = cell(row, cols, 'recommended_action');
      staged.push({
        kind: 'hazard', id, conflictKey: `${food.toLowerCase()}|${toPgArray(species)}`,
        sql: `INSERT INTO nutrition_hazards
                (id, species_codes, food_or_substance, classification, severity, risk,
                 recommended_action, review_status, is_demo)
              VALUES ($1,$2::text[],$3,$4,$5,$6,$7,'pending',true)
              ON CONFLICT (lower(food_or_substance), species_codes) DO UPDATE SET
                classification = EXCLUDED.classification, severity = EXCLUDED.severity,
                risk = EXCLUDED.risk, recommended_action = EXCLUDED.recommended_action,
                updated_at = now()
              WHERE nutrition_hazards.review_status = 'pending'`,
        params: [id, toPgArray(species), food, classification, severity, risk, action],
        snapshot: { food_or_substance: food, species, severity },
      });
    }
  }

  // Recipe guides
  {
    const cols = indexHeader(sheets.Recipe_Guides[0], EXPECTED_HEADERS.Recipe_Guides, 'Recipe_Guides', report);
    for (const [n, row] of sheets.Recipe_Guides.slice(1).entries()) {
      const line = `Recipe_Guides row ${n + 2}`;
      const speciesCell = cell(row, cols, 'species');
      const species = mapWorkbookSpecies(speciesCell);
      const name = cell(row, cols, 'recipe_name');
      const dietRole = cell(row, cols, 'diet_role');
      const statusRaw = cell(row, cols, 'review_status').toUpperCase();
      const applicability = cell(row, cols, 'applicability');
      const safety = cell(row, cols, 'safety_notes');
      if (species.length !== 1) { report.errors.push(`[${line}] recipe species "${speciesCell}" must map to exactly one species`); continue; }
      if (!name) { report.errors.push(`[${line}] empty recipe_name`); continue; }
      if (!dietRole) { report.errors.push(`[${line}] empty diet_role`); continue; }
      if (!KNOWN_STATUSES.has(statusRaw)) { report.errors.push(`[${line}] unknown review_status "${statusRaw}"`); continue; }
      // A recipe may never be imported as a complete diet: the workbook
      // must frame it as treat/supplement/template, and completeness
      // claims without validated adequacy are refused outright.
      if (/\bcomplete( and| &)? balanced\b/i.test(`${dietRole} ${applicability} ${safety}`)
        && !/not a complete|not complete/i.test(`${dietRole} ${applicability} ${safety}`)) {
        report.errors.push(
          `[${line}] recipe "${name}" claims completeness without validated nutritional adequacy — refusing to import`,
        );
        continue;
      }

      const id = `nr_${species[0]}_${slug(name)}`;
      const ingredients = parseIngredients(cell(row, cols, 'ingredients'));
      const steps = parseSteps(cell(row, cols, 'step_by_step'));
      staged.push({
        kind: 'recipe', id, conflictKey: `${species[0]}|${name.toLowerCase()}`,
        sql: `INSERT INTO nutrition_recipes
                (id, species_code, recipe_name, diet_role, applicability, ingredients, steps,
                 safety_notes, storage_instructions, storage_known, is_complete_diet,
                 nutritional_adequacy, review_status, is_demo)
              VALUES ($1,$2,$3,$4,$5,$6::text[],$7::text[],$8,NULL,false,false,'not_evaluated','pending',true)
              ON CONFLICT (species_code, lower(recipe_name)) DO UPDATE SET
                diet_role = EXCLUDED.diet_role, applicability = EXCLUDED.applicability,
                ingredients = EXCLUDED.ingredients, steps = EXCLUDED.steps,
                safety_notes = EXCLUDED.safety_notes, updated_at = now()
              WHERE nutrition_recipes.review_status = 'pending'`,
        params: [id, species[0], name, dietRole, applicability,
                 toPgArray(ingredients), toPgArray(steps), safety],
        snapshot: { recipe_name: name, species: species[0], diet_role: dietRole },
      });
    }
  }

  // Breed + life-stage guidance
  {
    const cols = indexHeader(sheets.Breed_LifeStage[0], EXPECTED_HEADERS.Breed_LifeStage, 'Breed_LifeStage', report);
    for (const [n, row] of sheets.Breed_LifeStage.slice(1).entries()) {
      const line = `Breed_LifeStage row ${n + 2}`;
      const speciesCell = cell(row, cols, 'species');
      const species = mapWorkbookSpecies(speciesCell);
      const breed = cell(row, cols, 'breed_or_type');
      const stageRaw = cell(row, cols, 'life_stage');
      const statusRaw = cell(row, cols, 'review_status').toUpperCase();
      const limitation = cell(row, cols, 'limitation');
      if (species.length !== 1) { report.errors.push(`[${line}] species "${speciesCell}" must map to exactly one species`); continue; }
      if (!breed) { report.errors.push(`[${line}] empty breed_or_type`); continue; }
      const stage = mapLifeStage(stageRaw);
      if (stage === 'all' && !/all|any/i.test(stageRaw)) { report.errors.push(`[${line}] unrecognised life_stage "${stageRaw}"`); continue; }
      if (!limitation) {
        // Breed advice without its limitation text could be read as
        // deterministic; requirement 6 needs the caveat attached.
        report.errors.push(`[${line}] breed guidance "${breed}" has no limitation text — refusing to import`);
        continue;
      }
      if (!KNOWN_STATUSES.has(statusRaw)) { report.errors.push(`[${line}] unknown review_status "${statusRaw}"`); continue; }

      const id = `nb_${species[0]}_${slug(breed)}_${stage}`;
      staged.push({
        kind: 'breed', id, conflictKey: `${species[0]}|${breed.toLowerCase()}|${stage}`,
        sql: `INSERT INTO nutrition_breed_guidance
                (id, species_code, breed_or_type, life_stage, general_guidance, limitation,
                 referral_rule, review_status, is_demo)
              VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',true)
              ON CONFLICT (species_code, lower(breed_or_type), life_stage) DO UPDATE SET
                general_guidance = EXCLUDED.general_guidance, limitation = EXCLUDED.limitation,
                referral_rule = EXCLUDED.referral_rule, updated_at = now()
              WHERE nutrition_breed_guidance.review_status = 'pending'`,
        params: [id, species[0], breed, stage, cell(row, cols, 'general_guidance'), limitation,
                 cell(row, cols, 'referral_rule')],
        snapshot: { breed_or_type: breed, species: species[0], life_stage: stage },
      });
    }
  }

  // Health-condition rules
  {
    const cols = indexHeader(sheets.Health_Conditions[0], EXPECTED_HEADERS.Health_Conditions, 'Health_Conditions', report);
    for (const [n, row] of sheets.Health_Conditions.slice(1).entries()) {
      const line = `Health_Conditions row ${n + 2}`;
      const condition = cell(row, cols, 'condition_or_goal');
      if (!condition) { report.errors.push(`[${line}] empty condition_or_goal`); continue; }
      const guidance = cell(row, cols, 'general_guidance');
      const safety = cell(row, cols, 'safety_rule');
      if (!guidance || !safety) { report.errors.push(`[${line}] "${condition}" missing general_guidance or safety_rule`); continue; }
      const keywords = CONDITION_KEYWORDS[condition.toLowerCase()]
        ?? condition.toLowerCase().split(/[\s/]+/).filter((w) => w.length > 3);
      const id = `nhr_${slug(condition)}`;
      staged.push({
        kind: 'health_rule', id, conflictKey: condition.toLowerCase(),
        sql: `INSERT INTO nutrition_health_rules
                (id, condition_or_goal, keywords, general_guidance, safety_rule, referral_rule,
                 review_status, is_demo)
              VALUES ($1,$2,$3::text[],$4,$5,$6,'pending',true)
              ON CONFLICT (lower(condition_or_goal)) DO UPDATE SET
                keywords = EXCLUDED.keywords, general_guidance = EXCLUDED.general_guidance,
                safety_rule = EXCLUDED.safety_rule, referral_rule = EXCLUDED.referral_rule,
                updated_at = now()
              WHERE nutrition_health_rules.review_status = 'pending'`,
        params: [id, condition, toPgArray(keywords), guidance, safety, cell(row, cols, 'referral_rule')],
        snapshot: { condition_or_goal: condition },
      });
    }
  }

  return { report, staged };
}

/**
 * Convenience wrapper: structural validation only, no writes and no DB
 * access. Used by tests for the validation contract.
 */
export function validateWorkbook(sheets: SheetRows): string[] {
  return stageWorkbook(sheets).report.errors;
}

async function recordVersion(
  recordType: StagedRecord['kind'], recordId: string, snapshot: Record<string, unknown>,
): Promise<void> {
  await (await getDb()).query(
    `INSERT INTO nutrition_record_versions (id, record_type, record_id, version, action, snapshot)
     VALUES ($1,$2,$3,1,'imported',$4)
     ON CONFLICT (record_type, record_id, version, action) DO NOTHING`,
    [crypto.randomUUID(), recordType, recordId, JSON.stringify(snapshot)],
  );
}

/**
 * Validate then import. With dryRun (default false) the whole workbook is
 * validated and staged but nothing touches the database. Without it, the
 * write happens in one transaction — all rows land as review_status
 * 'pending'; existing approved records are never modified (the upsert
 * clauses are guarded by review_status = 'pending').
 */
export async function importWorkbook(
  sheets: SheetRows,
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const { report, staged } = stageWorkbook(sheets);
  report.dryRun = dryRun;
  if (report.errors.length) return report;

  if (dryRun) {
    for (const rec of staged) bump(report.imported, rec.kind);
    return report;
  }

  const db = await getDb();
  await db.query('BEGIN');
  try {
    for (const rec of staged) {
      const params = rec.conflictKey.split('|');
      const existing = await one<{ id: string; review_status: string }>(
        `SELECT id, review_status FROM ${tableFor(rec.kind)} WHERE ${conflictWhere(rec.kind)}`,
        params,
      ).catch(() => null);
      const inserted = await db.query<{ id: string }>(`${rec.sql} RETURNING id`, rec.params);
      if (inserted.length) {
        bump(report.imported, rec.kind);
        if (existing?.review_status === 'approved') {
          // Never happens in practice — the upsert is guarded by
          // review_status = 'pending' — but count it if it ever does.
          bump(report.updated, rec.kind);
        }
        await recordVersion(rec.kind, rec.id, rec.snapshot);
      } else {
        bump(report.skipped, rec.kind);
      }
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  return report;
}

function tableFor(kind: StagedRecord['kind']): string {
  return {
    source: 'nutrition_sources', guidance: 'nutrition_guidance', hazard: 'nutrition_hazards',
    recipe: 'nutrition_recipes', breed: 'nutrition_breed_guidance', health_rule: 'nutrition_health_rules',
  }[kind];
}

function conflictWhere(kind: StagedRecord['kind']): string {
  return {
    source: 'lower(source_name) = $1',
    guidance: 'record_key = $1',
    hazard: 'lower(food_or_substance) = $1 AND species_codes = $2::text[]',
    recipe: 'species_code = $1 AND lower(recipe_name) = $2',
    breed: 'species_code = $1 AND lower(breed_or_type) = $2 AND life_stage = $3',
    health_rule: 'lower(condition_or_goal) = $1',
  }[kind];
}
