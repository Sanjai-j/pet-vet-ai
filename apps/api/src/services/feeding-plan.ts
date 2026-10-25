import { loadPet } from '../access.js';
import type { AuthUser } from '../auth.js';
import {
  allergyTokens,
  approvedBreedGuidance,
  approvedGuidanceForPet,
  approvedHazards,
  approvedHealthRules,
  approvedRecipes,
  petLifeStage,
  type NutritionSubject,
  type PetLifeStage,
} from './nutrition.js';

/**
 * Turns the approved nutrition tables into one answer for one animal:
 * how much energy it probably needs, how that splits into meals, which
 * recorded conditions change the picture, and which approved recipes are
 * merely treats.
 *
 * Two rules shape everything here.
 *
 * 1. **Arithmetic is code, never a language model.** Energy is computed from
 *    the recorded weight with a documented equation; the assumptions are
 *    returned alongside the number so nobody reads it as a prescription.
 * 2. **The pet's own data decides the filters.** Life stage comes from age,
 *    breed guidance from the breed, and condition rules from what the owner
 *    recorded. Nothing is inferred from the question text.
 */

export interface EnergyEstimate {
  restingKcal: number;
  merLowKcal: number;
  merHighKcal: number;
  factorLow: number;
  factorHigh: number;
  formula: string;
  assumptions: string[];
}

export interface FeedingPlan {
  pet: {
    id: string;
    name: string;
    speciesCode: string;
    breedName: string | null;
    lifeStage: PetLifeStage;
    ageMonths: number | null;
    weightKg: number | null;
  };
  /** null when the animal is not a dog or cat, or its weight is not recorded */
  energy: EnergyEstimate | null;
  energyUnavailableReason: string | null;
  meals: { perDay: number; note: string };
  treats: { maxKcal: number | null; note: string };
  water: string;
  lifeStageGuidance: Array<{ goal: string; guidance: string; safety: string }>;
  breedGuidance: { guidance: string; limitation: string; referralRule: string } | null;
  conditions: Array<{ condition: string; guidance: string; safety: string; referralRule: string }>;
  recipes: Array<{
    name: string;
    dietRole: string;
    completeDiet: boolean;
    adequacy: string;
    note: string;
    excludedByAllergy: string | null;
  }>;
  topHazards: Array<{ food: string; severity: string; action: string }>;
  missingInfo: string[];
  disclaimer: string;
}

/** Energy equations in veterinary nutrition are validated for dogs and cats. */
const ENERGY_SPECIES = new Set(['dog', 'cat']);

/**
 * Maintenance factors, as ranges rather than points, because published
 * guidance differs between sources and every factor is corrected by body
 * condition in a real consultation. Base values are the commonly cited
 * maintenance bands; life stage and recorded activity shift them.
 */
const STAGE_FACTOR: Record<PetLifeStage, [number, number]> = {
  young: [2.0, 3.0],
  adult: [1.6, 1.8],
  senior: [1.4, 1.6],
  all: [1.4, 1.8],
  unknown: [1.4, 1.8],
};

const WEIGHT_LOSS_KEYWORDS = /(obes|overweight|weight loss|weight management|slimming|diet plan)/i;

function numericWeight(weightKg: number | string | null | undefined): number | null {
  if (weightKg === null || weightKg === undefined || weightKg === '') return null;
  const value = Number(weightKg);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, dp = 0): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export function estimateEnergy(
  speciesCode: string,
  lifeStage: PetLifeStage,
  weightKg: number | null,
  activityLevel?: string | null,
  conditions?: string | null,
): { estimate: EnergyEstimate | null; reason: string | null } {
  if (!ENERGY_SPECIES.has(speciesCode)) {
    return {
      estimate: null,
      reason: `Energy equations used here are validated for dogs and cats. They are not applied to ${speciesCode === 'bird' ? 'birds' : 'this species'} — the approved feeding guidance above is the reliable part.`,
    };
  }
  if (weightKg === null) {
    return { estimate: null, reason: 'A current weight is needed before energy can be estimated. Record the weight, then ask again.' };
  }

  const factor: [number, number] = [...STAGE_FACTOR[lifeStage]] as [number, number];
  const assumptions: string[] = [];

  const activity = (activityLevel ?? '').toLowerCase();
  if (activity === 'high' || activity === 'very high') {
    factor[0] += 0.2;
    factor[1] += 0.3;
    assumptions.push('The recorded activity level is high, so the maintenance band was raised.');
  } else if (activity === 'low' || activity === 'sedentary') {
    factor[0] -= 0.15;
    factor[1] -= 0.15;
    assumptions.push('The recorded activity level is low, so the maintenance band was lowered.');
  }

  if (WEIGHT_LOSS_KEYWORDS.test(conditions ?? '')) {
    factor[0] = 1.0;
    factor[1] = 1.2;
    assumptions.push('A weight-management condition is recorded, so the band uses weight-loss factors instead of maintenance. Do not start a weight-loss plan without veterinary supervision.');
  }

  const low = Math.max(0.9, factor[0]);
  const high = Math.max(low, factor[1]);
  const resting = 70 * weightKg ** 0.75;

  assumptions.push(
    'Maintenance factors are ranges taken from published small-animal nutrition guidance; body condition score, neuter status, pregnancy and illness all move the real requirement.',
    'The estimate uses the weight on file. If that weight is more than a few weeks old, weigh the animal again before changing portions.',
    'This is an energy estimate, not a feeding plan: it says nothing about which food to use or how it is formulated.',
  );

  return {
    estimate: {
      restingKcal: round(resting),
      merLowKcal: round(resting * low),
      merHighKcal: round(resting * high),
      factorLow: round(low, 2),
      factorHigh: round(high, 2),
      formula: 'RER = 70 × (body weight in kg)^0.75 kcal/day; maintenance = RER × life-stage/activity factor',
      assumptions,
    },
    reason: null,
  };
}

function mealCount(speciesCode: string, lifeStage: PetLifeStage): { perDay: number; note: string } {
  if (speciesCode === 'bird') {
    return { perDay: 2, note: 'Birds eat through the day, not in two servings: offer measured food at set times and do not leave an unlimited bowl of seed. Species-specific feeding advice is limited here.' };
  }
  if (lifeStage === 'young') return { perDay: 4, note: 'Growing animals need smaller meals more often — around 3–4 a day, with a growth-appropriate complete food.' };
  if (lifeStage === 'senior') return { perDay: 2, note: 'Two smaller meals are usually easier on older animals than one large one.' };
  return { perDay: 2, note: 'Two measured meals a day is a common starting pattern for adults.' };
}

function waterGuidance(speciesCode: string): string {
  if (speciesCode === 'bird') return 'Fresh water in a clean drinker, changed at least daily. Many birds drink very little; watch droppings and droppings moisture rather than counting millilitres.';
  if (speciesCode === 'cat') return 'Fresh water always available. Cats often drink little — wet food helps, and a moving fountain can encourage drinking.';
  return 'Fresh, clean water always available, and more in hot weather or after exercise.';
}

export interface FeedingSubject extends NutritionSubject {
  id?: string;
  name?: string;
  weightKg?: number | string | null;
  conditions?: string | null;
  allergies?: string | null;
  dietaryRestrictions?: string | null;
  activityLevel?: string | null;
}

/**
 * The full plan for one animal. Authorisation happens in loadPet(), so a pet
 * belonging to another owner cannot be read.
 */
export async function feedingPlanForPet(petId: string, user: AuthUser): Promise<FeedingPlan> {
  const pet = await loadPet(petId, user);
  return buildPlan(pet);
}

/** Same builder, for callers that have already authorised the pet. */
export async function buildPlan(pet: FeedingSubject): Promise<FeedingPlan> {
  const stage = petLifeStage({ speciesCode: pet.speciesCode, ageEstimateMonths: pet.ageEstimateMonths ?? null });
  const weight = numericWeight(pet.weightKg);

  const [guidance, hazards, recipes, breed, healthRules] = await Promise.all([
    approvedGuidanceForPet(pet, stage),
    approvedHazards(pet.speciesCode),
    approvedRecipes(pet.speciesCode),
    approvedBreedGuidance(pet, stage),
    approvedHealthRules(),
  ]);

  const { estimate, reason } = estimateEnergy(pet.speciesCode, stage, weight, pet.activityLevel, pet.conditions);

  // Recorded conditions select the approved rules; a rule whose keywords do not
  // appear in what the owner wrote is not applied.
  const conditionText = [pet.conditions, pet.dietaryRestrictions].filter(Boolean).join(' ').toLowerCase();
  const matchedRules = conditionText.trim()
    ? healthRules.filter((rule) => rule.keywords.some((k) => {
        const keyword = k.trim().toLowerCase();
        return keyword.length >= 3 && conditionText.includes(keyword);
      }))
    : [];

  const allergies = allergyTokens(pet.allergies);
  const recipesForPet = recipes.map((r) => {
    const haystack = r.ingredients.join(' ').toLowerCase();
    const hit = allergies.find((token) => haystack.includes(token)) ?? null;
    const therapeutic = matchedRules.length > 0;
    const note = therapeutic
      ? 'Not offered: a recorded condition needs a diet set by a veterinarian, not a recipe from an app.'
      : hit
        ? `Not offered: contains an ingredient matching the recorded allergy "${hit}".`
        : r.isCompleteDiet
          ? 'Recorded as a complete diet in the reviewed source.'
          : 'Treat, topper or occasional meal — not a complete and balanced diet.';
    return {
      name: r.recipeName,
      dietRole: r.dietRole,
      completeDiet: r.isCompleteDiet,
      adequacy: r.nutritionalAdequacy,
      note,
      excludedByAllergy: hit,
    };
  });

  const missingInfo: string[] = [];
  if (weight === null) missingInfo.push('Current weight in kg — needed for any energy estimate.');
  if (stage === 'unknown') missingInfo.push('Date of birth or an age estimate — needed to pick the life-stage guidance.');
  if (!pet.breedName && !pet.customBreed) missingInfo.push('Breed (or "mixed") — breed-specific guidance stays generic without it.');

  const meals = mealCount(pet.speciesCode, stage);
  const treatsMax = estimate ? round(estimate.merLowKcal * 0.1) : null;

  return {
    pet: {
      id: pet.id ?? '',
      name: pet.name ?? '',
      speciesCode: pet.speciesCode,
      breedName: pet.breedName ?? pet.customBreed ?? null,
      lifeStage: stage,
      ageMonths: pet.ageEstimateMonths ?? null,
      weightKg: weight,
    },
    energy: estimate,
    energyUnavailableReason: reason,
    meals,
    treats: {
      maxKcal: treatsMax,
      note: treatsMax
        ? `Around ${treatsMax} kcal a day or less, roughly a tenth of the daily estimate. Subtract it from the meal portion rather than adding it.`
        : 'Keep treats small and occasional — roughly a tenth of daily intake once the daily estimate is known.',
    },
    water: waterGuidance(pet.speciesCode),
    lifeStageGuidance: guidance.slice(0, 4).map((g) => ({
      goal: g.nutritionGoal,
      guidance: g.generalDietGuidance,
      safety: g.safetyCautions,
    })),
    breedGuidance: breed
      ? { guidance: breed.generalGuidance, limitation: breed.limitation, referralRule: breed.referralRule }
      : null,
    conditions: matchedRules.map((rule) => ({
      condition: rule.conditionOrGoal,
      guidance: rule.generalGuidance,
      safety: rule.safetyRule,
      referralRule: rule.referralRule,
    })),
    recipes: recipesForPet,
    topHazards: hazards.slice(0, 5).map((h) => ({ food: h.foodOrSubstance, severity: h.severity, action: h.recommendedAction })),
    missingInfo,
    disclaimer:
      'Built from administrator-approved nutrition records for this species, breed, life stage and recorded conditions. It is general guidance, not a prescription: portions for an individual animal are set by a veterinarian who has examined it.',
  };
}

/**
 * Compact lines for the chat prompt, so a food question is answered with this
 * animal's age, breed and conditions rather than generic advice.
 */
export async function feedingDigest(pet: FeedingSubject): Promise<string[]> {
  return digestLines(await buildPlan(pet));
}

/**
 * The same facts as short prompt/answer lines. Split out from feedingDigest so
 * one plan can feed both the model prompt and the deterministic answer instead
 * of being rebuilt twice for the same question.
 */
export function digestLines(plan: FeedingPlan): string[] {
  const lines: string[] = [];

  lines.push(`Life stage on file: ${plan.pet.lifeStage}${plan.pet.ageMonths != null ? ` (${plan.pet.ageMonths} months)` : ''}${plan.pet.breedName ? `, breed ${plan.pet.breedName}` : ''}.`);

  if (plan.energy) {
    lines.push(`Estimated resting energy ${plan.energy.restingKcal} kcal/day; maintenance range ${plan.energy.merLowKcal}–${plan.energy.merHighKcal} kcal/day at ${plan.energy.factorLow}–${plan.energy.factorHigh}× RER.`);
  } else if (plan.energyUnavailableReason) {
    lines.push(`No energy estimate: ${plan.energyUnavailableReason}`);
  }

  lines.push(`${plan.meals.perDay} meal(s) a day. ${plan.treats.note}`);

  if (plan.breedGuidance) lines.push(`Breed guidance: ${plan.breedGuidance.guidance}`);
  for (const c of plan.conditions) lines.push(`Recorded condition "${c.condition}": ${c.guidance} Safety: ${c.safety}`);

  const allergens = plan.recipes.filter((r) => r.excludedByAllergy).map((r) => r.excludedByAllergy);
  if (allergens.length) lines.push(`Recorded allergies exclude recipes containing: ${[...new Set(allergens)].join(', ')}.`);

  const treats = plan.recipes.filter((r) => r.dietRole === 'treat' && !r.excludedByAllergy).map((r) => r.name);
  if (treats.length) lines.push(`Approved treat ideas (treats, never a complete diet): ${treats.slice(0, 3).join('; ')}.`);

  if (plan.missingInfo.length) lines.push(`Missing before advice can be specific: ${plan.missingInfo.join(' ')}`);

  return lines;
}
