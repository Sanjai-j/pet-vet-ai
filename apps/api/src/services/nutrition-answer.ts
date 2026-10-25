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

/**
 * The deterministic answer to a *general* feeding question — "for a dog in
 * general, what should a healthy adult Labrador eat?"
 *
 * It deliberately receives no pet record. When the owner states a weight in the
 * question, the energy figures are calculated from that stated weight and say
 * so; when no weight is stated, it asks for one instead of borrowing the weight
 * of whichever pet happens to be selected. That is the difference between
 * answering a general question and quietly personalising it with the wrong
 * animal's data.
 */
export interface GeneralNutritionSubject {
  speciesCode: string;
  /** weight stated in the question, never a profile value */
  weightKg?: number | null;
  lifeStage?: 'young' | 'adult' | 'senior' | 'unknown';
  energy?: {
    restingKcal: number;
    merLowKcal: number;
    merHighKcal: number;
    factorLow: number;
    factorHigh: number;
  } | null;
  /** approved references attached to the reply, for the sourcing note */
  sourceCount?: number;
}

const PLURAL: Record<string, string> = {
  dog: 'dogs',
  cat: 'cats',
  bird: 'birds',
  cow: 'cattle',
  goat: 'goats',
  other: 'animals',
};

/** Foods a general answer should always name, per species. */
const AVOID: Record<string, string[]> = {
  dog: [
    'chocolate and cocoa', 'grapes, raisins and sultanas', 'xylitol (sugar-free gum, mints and some peanut butters)',
    'onions, garlic, leeks and chives', 'alcohol and caffeine', 'cooked bones, and fatty or spiced table scraps',
  ],
  cat: [
    'chocolate and cocoa', 'onions, garlic and chives', 'grapes and raisins', 'alcohol and caffeine',
    'dog food as a long-term diet (it lacks enough taurine)', 'cow milk for most adult cats',
  ],
  bird: [
    'avocado', 'chocolate', 'caffeine and alcohol', 'salty or sugary snacks', 'fruit pits and apple seeds',
    'an all-seed diet, which is not complete for most species',
  ],
  cow: [
    'mouldy or spoiled feed', 'sudden changes in concentrate level', 'non-protein nitrogen as a careless substitute for protein',
    'metal, plastic or sand contamination',
  ],
  goat: [
    'mouldy or spoiled feed', 'sudden diet changes', 'ornamental plants and garden clippings',
    'too much grain relative to forage',
  ],
  other: ['human food that is high in fat, salt or sugar', 'alcohol and caffeine', 'mouldy or spoiled food'],
};

const ENERGY_SPECIES = new Set(['dog', 'cat']);

export function generalNutritionAnswer(subject: GeneralNutritionSubject): string {
  const species = subject.speciesCode;
  const plural = PLURAL[species] ?? 'animals';
  const stage = subject.lifeStage && subject.lifeStage !== 'unknown' ? subject.lifeStage : 'adult';
  const lines: string[] = [
    `General feeding guidance for ${stage} ${plural} — not a diagnosis, not a prescription, and not calculated from any pet record.`,
    '',
    'What to feed',
    `• The default for ${stage} ${plural} is a commercially prepared food whose label states it is complete and balanced for that species and life stage. That label is the only completeness claim worth relying on.`,
    '• Choose the food by life stage and body size, then let body condition rather than the packet alone decide the portion.',
    '• Fresh, clean water always available.',
  ];

  lines.push('', 'How much');
  if (subject.energy && subject.weightKg) {
    lines.push(
      `• Estimated resting energy: ${subject.energy.restingKcal} kcal/day.`,
      `• Daily maintenance range: ${subject.energy.merLowKcal}–${subject.energy.merHighKcal} kcal/day (${subject.energy.factorLow}–${subject.energy.factorHigh}× resting energy), calculated from the ${subject.weightKg} kg stated in your question — not from a pet on your account.`,
      '• Start in the lower half of that range and adjust by body condition over two to three weeks.',
    );
  } else if (ENERGY_SPECIES.has(species)) {
    lines.push(
      '• A daily amount needs a current weight. Weigh the animal and ask again, or start from the feeding guide on the food packet and adjust by body condition from there.',
    );
  } else {
    lines.push(
      `• No weight-based calorie equation is applied to ${plural}: the equations in common use are validated for dogs and cats. Follow the formulated feed or species-specific guidance, and ask a veterinarian who works with ${plural} for a quantity.`,
    );
  }
  lines.push(
    '• Feeding-guide figures on a packet assume an unneutered, active animal; neutered, less active or overweight animals usually need less.',
    '• Treats: keep them to roughly a tenth of the daily amount and subtract them from the meal rather than adding them.',
  );

  const meals = stage === 'young' ? 4 : 2;
  lines.push(
    '',
    'Meals',
    `• ${meals} measured meals a day${stage === 'young' ? ' for a growing animal, reducing to two or three as it matures' : ', at consistent times'}.`,
    '• Change foods gradually over about a week, mixing increasing amounts of the new food, to avoid stomach upset.',
  );

  const avoid = AVOID[species] ?? AVOID.other!;
  lines.push('', 'Foods to avoid', ...avoid.map((item) => `• ${item}`));
  lines.push('• If any of these has already been eaten, treat it as a possible poisoning and contact a veterinarian rather than waiting for signs.');

  lines.push(
    '',
    'How to adjust the portion',
    '• Check body condition by hand: ribs easy to feel but not visible, a waist behind the ribs and a tucked belly.',
    '• Too thin: increase by about a tenth and re-check in two weeks. Too heavy: reduce by about a tenth, keep treats small, and re-check in two weeks.',
    '• Weigh the animal on the same scale every two weeks; a steady drift matters more than a single reading.',
  );

  if (subject.sourceCount) {
    lines.push(
      '',
      'The approved references attached to this answer cover part of this. Anything they do not state is general guidance, not sourced fact.',
    );
  }

  lines.push(
    '',
    `Contact ${referralFor(species)} for a quantity for an individual animal, and before changing the diet of a young, pregnant, ill or senior one. Treat difficulty breathing, collapse, repeated vomiting or a suspected poisoning as an emergency.`,
    'This is general information, not a substitute for an examination.',
  );

  return lines.join('\n');
}
