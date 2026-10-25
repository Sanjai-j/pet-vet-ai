import { many, one } from '../db.js';
import { loadPet, type PetRow } from '../access.js';

/**
 * Food & nutrition knowledge service.
 *
 * Sources a personalized nutrition profile for a pet from the normalized
 * workbook tables (db/migrations/003_nutrition.sql). Hard rules enforced
 * here and covered by tests:
 *
 *  - Only records an administrator approved are ever served (requirement:
 *    unreviewed workbook rows stay in the review queue).
 *  - Personalized guidance is generated only when the required pet
 *    information is available; otherwise the response says what is missing
 *    instead of guessing.
 *  - Recipes are treats/supplements unless nutritional adequacy was
 *    professionally formulated and validated for the species + life stage.
 *    No code path in this app can mark a recipe complete; the column
 *    exists only for reviewed database-level attestations.
 *  - Livestock (cow/goat) always require an individually formulated feed
 *    plan; no universal quantities are generated anywhere.
 *  - Unknown safety is reported as unknown, never inferred as safe.
 *  - Breed is context only: it never changes a recommendation, and any
 *    breed-specific text is always surfaced with its limitation.
 */

export type LifeStage = 'young' | 'adult' | 'senior' | 'all';
export type PetLifeStage = LifeStage | 'unknown';
export type HazardSeverity =
  | 'toxic' | 'potentially_toxic' | 'dangerous'
  | 'caution' | 'nutritionally_inappropriate' | 'unknown';

export const ALL_SPECIES = ['dog', 'cat', 'bird', 'cow', 'goat', 'other'] as const;
export const LIVESTOCK = new Set(['cow', 'goat']);

const LIFESPAN_TOP_MONTHS: Record<string, number> = {
  // Thresholds after which a healthy pet is usually considered senior.
  // Approximate and intentionally conservative: they gate wording, not doses.
  dog: 84,   // 7 years
  cat: 132,  // 11 years
  bird: 120, // 10 years (varies hugely by species; treated as context only)
  cow: 96,   // 8 years
  goat: 72,  // 6 years
  other: 96,
};

export function petLifeStage(pet: {
  speciesCode: string;
  birthDate?: string | null;
  ageEstimateMonths?: number | null;
}): PetLifeStage {
  let months = pet.ageEstimateMonths ?? null;
  if (!months && pet.birthDate) {
    const born = Date.parse(`${pet.birthDate}T00:00:00Z`);
    if (!Number.isNaN(born)) months = Math.floor((Date.now() - born) / (30.44 * 86_400_000));
  }
  if (months === null || months < 0) return 'unknown';
  const seniorFrom = LIFESPAN_TOP_MONTHS[pet.speciesCode] ?? 96;
  if (months < 12) return 'young';
  if (months >= seniorFrom) return 'senior';
  return 'adult';
}

/** Workbook "Dog/Cat", "Cow/Goat", "All species" cells → species codes. */
export function mapWorkbookSpecies(cell: string): string[] {
  const norm = cell.trim().toLowerCase();
  if (norm === 'all species' || norm === 'all') return [...ALL_SPECIES];
  const parts = norm.split(/[+/&,]/).map((p) => p.trim()).filter(Boolean);
  const codes: string[] = [];
  for (const p of parts) {
    if ((ALL_SPECIES as readonly string[]).includes(p)) codes.push(p);
  }
  return [...new Set(codes)];
}

export function mapLifeStage(cell: string): LifeStage {
  const norm = cell.trim().toLowerCase();
  if (norm.startsWith('young') || norm.includes('growing')) return 'young';
  if (norm.startsWith('senior') || norm.includes('older')) return 'senior';
  if (norm.startsWith('adult')) return 'adult';
  return 'all';
}

export function mapSeverity(classification: string): HazardSeverity {
  const norm = classification.trim().toLowerCase();
  if (norm.includes('toxic risk') && norm.includes('avoid')) return 'potentially_toxic';
  if (norm.includes('toxic risk')) return 'toxic';
  if (norm.includes('potentially toxic')) return 'potentially_toxic';
  if (norm.includes('dangerous')) return 'dangerous';
  if (norm.includes('inappropriate')) return 'nutritionally_inappropriate';
  if (norm.includes('unknown')) return 'unknown';
  if (norm.includes('avoid') || norm.includes('caution')) return 'caution';
  return 'unknown';
}

/** Split owner free text ("Chicken, dairy intolerance") into allergy tokens. */
export function allergyTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[,;(/\n]|\band\b|\bplus\b/gi)
    .map((t) => t.replace(/[^a-z0-9\s-]/g, '').trim())
    .filter((t) => t.length >= 3 && !/^(no|none|not|n\/a|unknown)$/.test(t));
}

function textMentions(haystack: string, token: string): boolean {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);
}

// ── Row shapes ────────────────────────────────────────────────

export interface GuidanceRow {
  id: string; recordKey: string; speciesCode: string; breedOrType: string | null;
  lifeStage: LifeStage; nutritionGoal: string;
  generalDietGuidance: string; suitableFoodsText: string; hazardsToAvoidText: string;
  recipeGuidanceText: string; goalSpecificGuidance: string; safetyCautions: string;
  individualizationFactors: string; disclaimer: string; dataQualityNote: string;
  sourceUrl: string | null; sourceName: string | null; version: number; reviewedAt: string | null;
}

export interface HazardRow {
  id: string; speciesCodes: string[]; foodOrSubstance: string; classification: string;
  severity: HazardSeverity; risk: string; recommendedAction: string;
  sourceUrl: string | null; version: number; reviewedAt: string | null;
}

export interface RecipeRow {
  id: string; speciesCode: string; recipeName: string; dietRole: string;
  applicability: string; ingredients: string[]; steps: string[];
  safetyNotes: string; storageInstructions: string | null; storageKnown: boolean;
  isCompleteDiet: boolean; nutritionalAdequacy: string; adequacyNote: string | null;
  version: number; reviewedAt: string | null;
}

export interface BreedGuidanceRow {
  id: string; speciesCode: string; breedOrType: string; lifeStage: LifeStage;
  generalGuidance: string; limitation: string; referralRule: string; version: number;
}

export interface HealthRuleRow {
  id: string; conditionOrGoal: string; keywords: string[];
  generalGuidance: string; safetyRule: string; referralRule: string; version: number;
}

// ── Queries (approved records only) ───────────────────────────

const GUIDANCE_SELECT = `
  SELECT g.id, g.record_key AS "recordKey", g.species_code AS "speciesCode",
         g.breed_or_type AS "breedOrType", g.life_stage AS "lifeStage",
         g.nutrition_goal AS "nutritionGoal",
         g.general_diet_guidance AS "generalDietGuidance",
         g.suitable_foods_text AS "suitableFoodsText",
         g.hazards_to_avoid_text AS "hazardsToAvoidText",
         g.recipe_guidance_text AS "recipeGuidanceText",
         g.goal_specific_guidance AS "goalSpecificGuidance",
         g.safety_cautions AS "safetyCautions",
         g.individualization_factors AS "individualizationFactors",
         g.disclaimer, g.data_quality_note AS "dataQualityNote",
         s.url AS "sourceUrl", s.source_name AS "sourceName",
         g.version, g.reviewed_at AS "reviewedAt"
  FROM nutrition_guidance g
  LEFT JOIN nutrition_sources s ON s.id = g.source_id AND s.review_status = 'approved'`;

/**
 * The fields the nutrition lookups actually read. Narrowing it here lets the
 * feeding planner reuse these queries for a pet it has already loaded and
 * authorised, without inventing a full PetRow.
 */
export type NutritionSubject = Pick<PetRow, 'speciesCode' | 'breedName' | 'customBreed' | 'ageEstimateMonths'>;

export async function approvedGuidanceForPet(pet: NutritionSubject, stage: PetLifeStage): Promise<GuidanceRow[]> {
  const stages: LifeStage[] = stage === 'unknown' ? ['all'] : [stage as LifeStage, 'all'];
  const breed = pet.breedName ?? pet.customBreed ?? null;
  return many<GuidanceRow>(
    `${GUIDANCE_SELECT}
     WHERE g.review_status = 'approved'
       AND g.species_code = $1
       AND (g.breed_or_type IS NULL OR lower(g.breed_or_type) = lower($2) OR $2 IS NULL)
       AND g.life_stage = ANY($3::text[])
     ORDER BY (g.breed_or_type IS NULL), g.nutrition_goal`,
    [pet.speciesCode, breed, stages],
  );
}

export async function approvedHazards(speciesCode: string): Promise<HazardRow[]> {
  return many<HazardRow>(
    `SELECT h.id, h.species_codes AS "speciesCodes", h.food_or_substance AS "foodOrSubstance",
            h.classification, h.severity, h.risk, h.recommended_action AS "recommendedAction",
            s.url AS "sourceUrl", h.version, h.reviewed_at AS "reviewedAt"
     FROM nutrition_hazards h
     LEFT JOIN nutrition_sources s ON s.id = h.source_id AND s.review_status = 'approved'
     WHERE h.review_status = 'approved'
       AND ($1 = ANY(h.species_codes) OR 'other' = $1 AND 'other' = ANY(h.species_codes))
     ORDER BY CASE h.severity
       WHEN 'toxic' THEN 0 WHEN 'dangerous' THEN 1 WHEN 'potentially_toxic' THEN 2
       WHEN 'caution' THEN 3 WHEN 'nutritionally_inappropriate' THEN 4 ELSE 5 END,
       h.food_or_substance`,
    [speciesCode],
  );
}

export async function approvedRecipes(speciesCode: string): Promise<RecipeRow[]> {
  return many<RecipeRow>(
    `SELECT id, species_code AS "speciesCode", recipe_name AS "recipeName",
            diet_role AS "dietRole", applicability, ingredients, steps,
            safety_notes AS "safetyNotes", storage_instructions AS "storageInstructions",
            storage_known AS "storageKnown", is_complete_diet AS "isCompleteDiet",
            nutritional_adequacy AS "nutritionalAdequacy", adequacy_note AS "adequacyNote",
            version, reviewed_at AS "reviewedAt"
     FROM nutrition_recipes
     WHERE review_status = 'approved' AND species_code = $1
     ORDER BY recipe_name`,
    [speciesCode],
  );
}

export async function approvedBreedGuidance(
  pet: NutritionSubject, stage: PetLifeStage,
): Promise<BreedGuidanceRow | null> {
  const breed = pet.breedName ?? pet.customBreed ?? null;
  if (!breed || stage === 'unknown') return null;
  return one<BreedGuidanceRow>(
    `SELECT id, species_code AS "speciesCode", breed_or_type AS "breedOrType",
            life_stage AS "lifeStage", general_guidance AS "generalGuidance",
            limitation, referral_rule AS "referralRule", version
     FROM nutrition_breed_guidance
     WHERE review_status = 'approved' AND species_code = $1
       AND lower(breed_or_type) = lower($2)
       AND life_stage IN ($3, 'all')
     ORDER BY (life_stage = 'all') LIMIT 1`,
    [pet.speciesCode, breed, stage],
  );
}

export async function approvedHealthRules(): Promise<HealthRuleRow[]> {
  return many<HealthRuleRow>(
    `SELECT id, condition_or_goal AS "conditionOrGoal", keywords,
            general_guidance AS "generalGuidance", safety_rule AS "safetyRule",
            referral_rule AS "referralRule", version
     FROM nutrition_health_rules WHERE review_status = 'approved'
     ORDER BY condition_or_goal`,
  );
}

// ── Profile assembly ──────────────────────────────────────────

export interface PetNutritionProfile {
  pet: {
    id: string; name: string; speciesCode: string; speciesName: string; speciesIcon: string;
    breedName: string | null; lifeStage: PetLifeStage;
  };
  knowledge: {
    approvedGuidanceCount: number;
    approvedHazardCount: number;
    approvedRecipeCount: number;
    note: string;
  };
  missingInfo: string[];
  guidance: Array<GuidanceRow & { allergenWarnings: string[] }>;
  breedContext: {
    applied: boolean;
    basis: 'approved_breed_evidence' | 'no_breed_on_file' | 'no_approved_evidence';
    guidance?: BreedGuidanceRow;
    note: string;
  };
  hazards: HazardRow[];
  hazardCoverageKnown: boolean;
  recipes: Array<RecipeRow & {
    allergenWarnings: string[];
    roleLabel: string;
    isSupplementary: boolean;
    completeDietWarning: string | null;
    storageNote: string;
  }>;
  healthRules: Array<HealthRuleRow & { matchedOn: string[] }>;
  livestock: null | {
    feedPlanRequired: true;
    planNote: string;
  };
  emergencyNotice: null | { title: string; body: string };
  disclaimer: string;
}

export async function nutritionProfileForPet(
  petId: string,
  user: Parameters<typeof loadPet>[1],
): Promise<PetNutritionProfile> {
  const pet = await loadPet(petId, user);
  const stage = petLifeStage(pet);
  const [guidance, hazards, recipes, breedGuidance, healthRules] = await Promise.all([
    approvedGuidanceForPet(pet, stage),
    approvedHazards(pet.speciesCode),
    approvedRecipes(pet.speciesCode),
    approvedBreedGuidance(pet, stage),
    approvedHealthRules(),
  ]);

  // What information would we need to be more specific?
  const missingInfo: string[] = [];
  if (stage === 'unknown') {
    missingInfo.push(
      pet.speciesCode === 'bird'
        ? 'Age: bird lifespans vary widely, so life-stage guidance is withheld until the age (or approximate age) is recorded.'
        : 'Age or date of birth: life-stage-specific nutrition guidance is withheld until this is recorded.',
    );
  }
  if (!pet.weightKg) missingInfo.push('Weight: portion and body-condition advice needs a recent measured weight.');
  if (!pet.allergies) missingInfo.push('Allergies: record known food allergies (or "none known") to filter suitable foods.');
  if (!pet.conditions) missingInfo.push('Medical conditions: record diagnosed conditions to apply diet safety rules.');
  if (!pet.dietaryRestrictions) missingInfo.push('Veterinary dietary restrictions: record any prescribed diet plan.');

  // Allergy / restriction conflicts against suitable-foods text and recipes.
  const allergy = allergyTokens(pet.allergies);
  const restriction = allergyTokens(pet.dietaryRestrictions);
  const conflictTokens = [...new Set([...allergy, ...restriction])];

  const withWarnings = guidance.map((g) => {
    const blob = `${g.suitableFoodsText} ${g.generalDietGuidance} ${g.goalSpecificGuidance}`;
    return {
      ...g,
      allergenWarnings: conflictTokens.filter((t) => textMentions(blob, t)),
    };
  });

  const recipesWithWarnings = recipes.map((r) => {
    const blob = `${r.ingredients.join(' ')} ${r.safetyNotes} ${r.applicability}`;
    const allergenWarnings = conflictTokens.filter((t) => textMentions(blob, t));
    const supplementary = !r.isCompleteDiet;
    return {
      ...r,
      allergenWarnings,
      isSupplementary: supplementary,
      roleLabel: r.dietRole,
      // Requirement: never present a recipe as a complete diet unless
      // nutritional adequacy was professionally formulated AND validated.
      completeDietWarning: r.isCompleteDiet && r.nutritionalAdequacy === 'validated'
        ? null
        : 'This is a treat or supplementary food only — not a complete and balanced diet. ' +
          'It must not replace a nutritionally complete food for this species and life stage.',
      storageNote: r.storageKnown && r.storageInstructions
        ? r.storageInstructions
        : 'Storage instructions are not specified in the reviewed source — ask your veterinarian or prepare fresh each time.',
    };
  });

  // Match pet conditions/medications against approved health rules.
  const conditionText = [pet.conditions, pet.medications, pet.dietaryRestrictions]
    .filter(Boolean).join(' · ').toLowerCase();
  const matchedRules = healthRules
    .map((rule) => ({
      ...rule,
      matchedOn: rule.keywords.filter((k) => conditionText.includes(k.toLowerCase())),
    }))
    .filter((r) => r.matchedOn.length > 0);

  // Breed is context only — surfaced with its limitation, never as a rule.
  const petBreed = pet.breedName ?? pet.customBreed ?? null;
  const breedContext: PetNutritionProfile['breedContext'] = breedGuidance
    ? {
        applied: true,
        basis: 'approved_breed_evidence',
        guidance: breedGuidance,
        note:
          'Breed information is additional context reviewed by an administrator. ' +
          'It does not by itself determine portion sizes, allergy status or a therapeutic diet.',
      }
    : {
        applied: false,
        basis: petBreed ? 'no_approved_evidence' : 'no_breed_on_file',
        note: petBreed
          ? `No reviewed breed-specific evidence is approved for this ${pet.speciesCode} breed, so no breed-specific advice is shown. Breed alone cannot determine food safety or portions.`
          : 'No breed on file — guidance is species-wide, which is appropriate unless a veterinarian identifies a breed-linked risk.',
      };

  const livestock = LIVESTOCK.has(pet.speciesCode)
    ? {
        feedPlanRequired: true as const,
        planNote:
          `For ${pet.speciesCode === 'cow' ? 'cattle' : 'goats'}, safe feeding depends on weight, ` +
          'body condition, production stage, forage quality and local mineral availability. ' +
          'An appropriately formulated feed plan from a veterinarian or livestock nutritionist is ' +
          'required — this app does not generate universal feed quantities.',
      }
    : null;

  const hasUrgentHazard = hazards.some((h) =>
    ['toxic', 'dangerous', 'potentially_toxic'].includes(h.severity));
  const emergencyNotice: PetNutritionProfile['emergencyNotice'] = hasUrgentHazard
    ? {
        title: 'If your pet has eaten any listed food, contact a veterinarian now',
        body:
          'Do not wait for symptoms and do not induce vomiting unless a veterinarian tells you to. ' +
          'Call your clinic or an emergency veterinary service immediately and take the food ' +
          'packaging with you. Each entry below includes the specific action recommended by the source.',
      }
    : null;

  return {
    pet: {
      id: pet.id,
      name: pet.name,
      speciesCode: pet.speciesCode,
      speciesName: pet.speciesName,
      speciesIcon: pet.speciesIcon,
      breedName: petBreed,
      lifeStage: stage,
    },
    knowledge: {
      approvedGuidanceCount: guidance.length,
      approvedHazardCount: hazards.length,
      approvedRecipeCount: recipes.length,
      note:
        guidance.length || hazards.length || recipes.length
          ? 'Only knowledge approved by an administrator is shown. Anything still under veterinary review is excluded.'
          : 'No approved nutrition knowledge is available for this species yet. Entries from the ' +
            'starter workbook stay in the administrator review queue until a veterinarian approves them — ' +
            'they are not shown as recommendations.',
    },
    missingInfo,
    guidance: withWarnings,
    breedContext,
    hazards,
    hazardCoverageKnown: hazards.length > 0,
    recipes: recipesWithWarnings,
    healthRules: matchedRules,
    livestock,
    emergencyNotice,
    disclaimer:
      'General educational nutrition guidance — not a diagnosis, prescription or portion plan. ' +
      'For disease, allergies, growth, pregnancy/lactation or persistent symptoms, obtain an ' +
      'individualized plan from a veterinarian.',
  };
}

/** Free-text food lookup used by the food safety page. */
export async function hazardForFoodQuery(
  speciesCode: string,
  query: string,
): Promise<{ matches: HazardRow[]; coverageKnown: boolean }> {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [], coverageKnown: false };
  const all = await approvedHazards(speciesCode);
  const matches = all.filter(
    (h) => h.foodOrSubstance.toLowerCase().includes(q) || textMentions(h.foodOrSubstance, q),
  );
  return { matches, coverageKnown: all.length > 0 };
}
