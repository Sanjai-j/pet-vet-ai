import type { FeedingPlan } from './feeding-plan.js';

/**
 * The deterministic answer to "what should I feed this pet?".
 *
 * It exists for the case where no model is configured, or the model's answer is
 * discarded by the output guard. The old fallback printed approved snippets and
 * a coverage note — honest, but not an answer to a feeding question. This
 * composer answers the question from the same reviewed tables plus the energy
 * arithmetic in feeding-plan.ts, and it says plainly which part is sourced and
 * which part is a calculation.
 *
 * What it will never do: claim a homemade recipe is complete, apply dog/cat
 * energy equations to another species, or print a dose.
 */

export interface NutritionAnswerPet {
  name?: string | null;
  speciesCode: string;
  breedName?: string | null;
  customBreed?: string | null;
}

const SPECIES_LABEL: Record<string, string> = {
  dog: 'dog',
  cat: 'cat',
  bird: 'bird',
  cow: 'cow',
  goat: 'goat',
  other: 'animal',
};

const REFERRAL: Record<string, string> = {
  bird: 'an avian-experienced veterinarian',
  cow: 'a large-animal veterinarian',
  goat: 'a large-animal veterinarian',
  other: 'a veterinarian experienced with this species',
};

function referralFor(species: string): string {
  return REFERRAL[species] ?? 'a licensed veterinarian';
}

function firstSentence(text: string, max = 320): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).replace(/[,;:\s]+\S*$/, '')}…`;
}

export function nutritionAnswer(pet: NutritionAnswerPet, plan: FeedingPlan): string {
  const species = SPECIES_LABEL[pet.speciesCode] ?? 'animal';
  const breed = pet.breedName ?? pet.customBreed ?? null;
  const stage = plan.pet.lifeStage === 'unknown' ? '' : ` ${plan.pet.lifeStage}`;
  const lines: string[] = [];

  lines.push(
    `Feeding guidance for ${pet.name || 'your pet'} (${species}${breed ? `, ${breed}` : ''}${stage}) — general information, not a prescription.`,
    '',
    'What to feed',
    `• The default is a commercially prepared food whose label states it is complete and balanced for ${plan.pet.lifeStage === 'unknown' ? 'this species and life stage' : `${plan.pet.lifeStage} ${species}s`}. That label is the only claim of nutritional completeness worth relying on here.`,
  );

  if (plan.breedGuidance) {
    lines.push(`• Breed context: ${firstSentence(plan.breedGuidance.guidance)}`);
    if (plan.breedGuidance.limitation) {
      lines.push(`• Limit of that guidance: ${firstSentence(plan.breedGuidance.limitation)}`);
    }
  }

  for (const guidance of plan.lifeStageGuidance.slice(0, 2)) {
    lines.push(`• ${guidance.goal}: ${firstSentence(guidance.guidance)}`);
  }

  lines.push('', 'How much');
  if (plan.energy) {
    lines.push(
      `• Estimated resting energy: ${plan.energy.restingKcal} kcal/day.`,
      `• Daily maintenance range: ${plan.energy.merLowKcal}–${plan.energy.merHighKcal} kcal/day (${plan.energy.factorLow}–${plan.energy.factorHigh}× resting energy), calculated from the recorded weight of ${plan.pet.weightKg} kg.`,
      '• Start at the lower half of that range and adjust by body condition over two to three weeks rather than by appetite.',
      '• This is an estimate, not a portion prescription: neuter status, body condition score, illness and real activity all move it. The feeding guide on the food packet is a starting point, and the packet figures assume an unneutered active adult.',
    );
    if (plan.energy.assumptions.length) {
      lines.push(`• Assumption recorded: ${firstSentence(plan.energy.assumptions[0], 240)}`);
    }
  } else if (plan.energyUnavailableReason) {
    lines.push(`• ${plan.energyUnavailableReason}`);
  }

  lines.push(`• Treats: ${firstSentence(plan.treats.note, 240)}`);

  lines.push('', 'Meals and water', `• ${plan.meals.perDay} meal(s) a day. ${firstSentence(plan.meals.note, 240)}`, `• ${firstSentence(plan.water, 240)}`);
  lines.push('• Change to a new food gradually over about a week, mixing increasing amounts of the new food, to avoid stomach upset.');
  lines.push('• Fresh water always available, and no table scraps, spiced food, fried food or sweets.');

  if (plan.conditions.length) {
    lines.push('', 'Because of the conditions on record');
    for (const condition of plan.conditions.slice(0, 3)) {
      lines.push(`• ${condition.condition}: ${firstSentence(condition.guidance)}`);
      if (condition.safety) lines.push(`  Safety: ${firstSentence(condition.safety)}`);
    }
    lines.push('• A recorded condition needs a diet set by a veterinarian, not a diet chosen from an app.');
  }

  if (plan.topHazards.length) {
    lines.push('', 'Keep these out of reach');
    for (const hazard of plan.topHazards.slice(0, 4)) {
      lines.push(`• ${hazard.food} (${hazard.severity}): ${firstSentence(hazard.action, 200)}`);
    }
  }

  const recipes = plan.recipes.filter((recipe) => !recipe.excludedByAllergy).slice(0, 2);
  if (recipes.length) {
    lines.push('', 'Recipes from the approved set');
    for (const recipe of recipes) {
      const adequacy = recipe.completeDiet
        ? 'recorded as a complete diet in the reviewed source'
        : 'a treat or topper — not a complete and balanced diet';
      lines.push(`• ${recipe.name} — ${adequacy}. ${firstSentence(recipe.note, 200)}`);
    }
    lines.push('• No homemade recipe here is claimed to be nutritionally complete unless the reviewed source says so; a home-cooked complete diet needs a veterinary nutritionist\'s formulation.');
  }

  if (plan.missingInfo.length) {
    lines.push('', 'Still needed to be specific');
    for (const item of plan.missingInfo) lines.push(`• ${item}`);
  }

  lines.push(
    '',
    `Next: weigh ${pet.name || 'your pet'} every two weeks and check body condition by hand (ribs easy to feel, waist visible from above). If the weight is drifting, the portion needs adjusting.`,
    `Contact ${referralFor(pet.speciesCode)} before changing the diet for a young, pregnant, ill or senior animal, and if the animal stops eating, vomits repeatedly or loses weight.`,
    'This is general information built from administrator-approved nutrition records and a calculation from the recorded weight. It is not a substitute for an examination.',
  );

  return lines.join('\n');
}
