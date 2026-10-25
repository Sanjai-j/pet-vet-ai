/**
 * Is the question about the pet the owner has selected?
 *
 * Every answer in this product is personalised from one pet record: age, breed,
 * weight, conditions and allergies all change a feeding amount. If the question
 * describes a different animal — "what should I feed a 2-year-old Labrador
 * weighing 25 kg?" while a 3-month-old Persian cat is selected — then answering
 * anyway silently applies cat numbers to a Labrador question. That is worse
 * than asking, because the reply looks personalised.
 *
 * This module is deliberately pure: no database, no config, no model. It reads
 * the question text and the selected profile and either finds a conflict or
 * returns null. Being pure is what makes the behaviour testable.
 *
 * False positives are the thing to fear here: a clarification on a question
 * that was never about another animal is pure friction. So a mismatch only
 * counts when the question is framed at a *specific* animal — a possessive, a
 * stated age or weight, or a request for a feeding plan — and never for a
 * general plural question ("which foods are toxic to dogs?") asked while a cat
 * happens to be selected.
 */

export interface ProfileSubject {
  name?: string | null;
  speciesCode: string;
  breedName?: string | null;
  customBreed?: string | null;
  ageEstimateMonths?: number | null;
  weightKg?: number | string | null;
}

export type ConflictField = 'species' | 'breed' | 'age' | 'weight';

export interface ProfileConflict {
  fields: ConflictField[];
  statedSpecies: string | null;
  statedBreed: string | null;
  statedAgeMonths: number | null;
  statedWeightKg: number | null;
}

/** Species vocabulary, including the breed words people use as species names. */
const SPECIES_WORDS: Record<string, string[]> = {
  dog: [
    'dog', 'dogs', 'puppy', 'puppies', 'pup', 'pups',
    'labrador', 'retriever', 'beagle', 'pug', 'pomeranian', 'husky',
    'rottweiler', 'doberman', 'shepherd', 'spaniel', 'terrier', 'mastiff',
    'dalmatian', 'chihuahua', 'greyhound', 'boxer',
  ],
  cat: [
    'cat', 'cats', 'kitten', 'kittens', 'kitty',
    'persian', 'siamese', 'ragdoll', 'tabby', 'shorthair', 'longhair',
  ],
  bird: [
    'bird', 'birds', 'parrot', 'parrots', 'parakeet', 'budgie', 'budgerigar',
    'cockatiel', 'cockatoo', 'macaw', 'lovebird', 'canary', 'finch', 'conure',
  ],
  cow: ['cow', 'cows', 'cattle', 'calf', 'calves', 'heifer', 'bull', 'buffalo'],
  goat: ['goat', 'goats', 'kid', 'kids', 'doeling', 'buckling'],
};

/** One flat list, longest phrases first so "maine coon" beats "cat". */
const SPECIES_LOOKUP: Array<{ word: string; species: string }> = Object.entries(SPECIES_WORDS)
  .flatMap(([species, words]) => words.map((word) => ({ word, species })))
  .sort((a, b) => b.word.length - a.word.length);

const SPECIES_LABEL: Record<string, string> = {
  dog: 'dog',
  cat: 'cat',
  bird: 'bird',
  cow: 'cow',
  goat: 'goat',
  other: 'animal',
};

/**
 * Concrete breed names, used only when the species already matches. Vague words
 * that double as place names ("bengal", "indie") are left out on purpose.
 */
const BREED_WORDS = [
  'labrador retriever', 'labrador', 'golden retriever', 'german shepherd',
  'beagle', 'pug', 'pomeranian', 'rottweiler', 'doberman', 'husky',
  'cocker spaniel', 'shih tzu', 'maltese',
  'persian', 'siamese', 'maine coon', 'ragdoll', 'british shorthair',
  'domestic shorthair', 'abyssinian',
];

const PERSONAL = /\b(?:my|our|his|her|their)\b/i;
/** Age or weight stated as a property of the animal, not an incidental number. */
const STATED_TRAIT = /\b(?:weighs?|weighing|weight of|years? old|months? old|year-old|month-old)\b/i;

/** A trailing "s" usually means the owner is asking about the species, not this pet. */
function isPlural(word: string): boolean {
  return /\bs$/i.test(word) && !/(ss|us)$/i.test(word);
}

function findSpecies(text: string): { species: string; word: string } | null {
  let best: { species: string; word: string; index: number } | null = null;
  for (const entry of SPECIES_LOOKUP) {
    const re = new RegExp(`\\b${entry.word.replace(/ /g, '\\s+')}\\b`, 'i');
    const match = re.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) {
      best = { species: entry.species, word: match[0], index: match.index };
    }
  }
  return best ? { species: best.species, word: best.word } : null;
}

function findBreed(text: string): { breed: string; count: number } | null {
  let found: { breed: string; count: number } | null = null;
  for (const breed of BREED_WORDS) {
    const re = new RegExp(`\\b${breed.replace(/ /g, '\\s+')}\\b`, 'gi');
    const matches = text.match(re);
    if (!matches) continue;
    if (found) found.count += matches.length;
    else found = { breed, count: matches.length };
  }
  return found;
}

const AGE_PATTERNS: Array<{ re: RegExp; unit: 'year' | 'month' }> = [
  { re: /\b(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)?\s*(?:years?|yrs?|y)\s*(?:-|\s)?\s*old\b/i, unit: 'year' },
  { re: /\b(\d{1,2}(?:\.\d+)?)\s*(?:-|\s)?\s*(?:months?|mos?|mo)\s*(?:-|\s)?\s*old\b/i, unit: 'month' },
  { re: /\b(?:aged?|about|around|approximately)\s*(\d{1,2}(?:\.\d+)?)\s*(years?|yrs?)\b/i, unit: 'year' },
  { re: /\b(?:aged?|about|around|approximately)\s*(\d{1,2}(?:\.\d+)?)\s*(months?|mos?)\b/i, unit: 'month' },
];

function findAge(text: string): number | null {
  for (const { re, unit } of AGE_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return Math.round(unit === 'year' ? value * 12 : value);
  }
  return null;
}

/** Packages and bags are not body weights. */
const CONTAINER = /\b(?:bag|pack|packet|sack|tin|can|box|bottle|sachet|pouch)\b/i;

function findWeight(text: string): number | null {
  const re = /\b(\d{1,3}(?:\.\d+)?)\s*(kg|kgs|kilos?|kilograms?|lb|lbs|pounds?)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const nearby = text.slice(Math.max(0, match.index - 24), match.index + match[0].length + 12);
    if (CONTAINER.test(nearby)) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = (match[2] ?? '').toLowerCase();
    return unit.startsWith('lb') || unit.startsWith('pound') ? Math.round(value * 0.4536 * 10) / 10 : value;
  }
  return null;
}

function numericWeight(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Compare the question against the selected pet. Returns null when the question
 * is about this animal, or is not about a specific animal at all.
 */
export function detectProfileConflict(pet: ProfileSubject, message: string): ProfileConflict | null {
  const text = message.toLowerCase();
  const personal = PERSONAL.test(text);
  const statedTrait = STATED_TRAIT.test(text);

  const species = findSpecies(text);
  const ageMonths = findAge(text);
  const weightKg = findWeight(text);
  const breed = findBreed(text);

  // "Is chocolate toxic to dogs?" while a cat is selected is a general
  // question, not a conflict: it names the species in the plural and asks
  // nothing about a particular animal.
  const aboutOneAnimal = personal || statedTrait || ageMonths !== null || weightKg !== null;

  const fields: ConflictField[] = [];
  let statedSpecies: string | null = null;
  let statedBreed: string | null = null;
  let statedAge: number | null = null;
  let statedWeight: number | null = null;

  if (species && species.species !== pet.speciesCode) {
    if (!isPlural(species.word) || aboutOneAnimal) {
      fields.push('species');
      statedSpecies = species.species;
      // Echo the words the owner actually used: "dog" is accurate, but
      // "dog · Labrador" is what makes the clarification feel heard.
      if (breed) statedBreed = breed.breed;
    }
  }

  if (breed && !fields.includes('species')) {
    const recorded = normalise(pet.breedName ?? pet.customBreed ?? '');
    const spoken = normalise(breed.breed);
    const sameBreed = recorded.length > 0 && (recorded.includes(spoken) || spoken.includes(recorded));
    // Only when it is unmistakably about one animal with a different breed.
    if (recorded && breed.count === 1 && !sameBreed && (personal || statedTrait)) {
      fields.push('breed');
      statedBreed = breed.breed;
    }
  }

  const profileAge = pet.ageEstimateMonths ?? null;
  if (ageMonths !== null && profileAge !== null && aboutOneAnimal) {
    const tolerance = profileAge < 6 ? 2 : Math.max(3, Math.round(profileAge * 0.25));
    if (Math.abs(ageMonths - profileAge) > tolerance) {
      fields.push('age');
      statedAge = ageMonths;
    }
  }

  const profileWeight = numericWeight(pet.weightKg);
  if (weightKg !== null && profileWeight !== null && aboutOneAnimal) {
    const diff = Math.abs(weightKg - profileWeight);
    if (diff / Math.max(profileWeight, weightKg) > 0.25) {
      fields.push('weight');
      statedWeight = weightKg;
    }
  }

  if (!fields.length) return null;
  return { fields, statedSpecies, statedBreed, statedAgeMonths: statedAge, statedWeightKg: statedWeight };
}

function ageText(months: number | null): string {
  if (months === null) return 'age not recorded';
  if (months < 12) return `about ${months} month${months === 1 ? '' : 's'}`;
  const years = Math.round((months / 12) * 10) / 10;
  return `about ${years} year${years === 1 ? '' : 's'}`;
}

/**
 * The clarification. It never calculates anything for the animal described,
 * because the profile it would calculate from belongs to a different one.
 */
export function profileConflictAnswer(pet: ProfileSubject, message: string, conflict: ProfileConflict): string {
  const selected = [
    `${SPECIES_LABEL[pet.speciesCode] ?? pet.speciesCode}`,
    pet.breedName ?? pet.customBreed ?? null,
    ageText(pet.ageEstimateMonths ?? null),
    numericWeight(pet.weightKg) !== null ? `${numericWeight(pet.weightKg)} kg` : null,
  ].filter(Boolean).join(' · ');

  const described = [
    conflict.statedSpecies ? SPECIES_LABEL[conflict.statedSpecies] ?? conflict.statedSpecies : null,
    conflict.statedBreed,
    conflict.statedAgeMonths !== null ? ageText(conflict.statedAgeMonths) : null,
    conflict.statedWeightKg !== null ? `${conflict.statedWeightKg} kg` : null,
  ].filter(Boolean).join(' · ');

  const lines = [
    `I can only answer for the pet you have selected, and the animal in your question does not look like the same one.`,
    '',
    `• Selected pet: ${pet.name || 'this pet'} — ${selected}`,
    `• Your question describes: ${described || 'a different animal'}`,
    '',
    'Feeding amounts, meal sizes and health advice depend on species, age and weight. Answering that question with this pet\'s record would give you numbers for the wrong animal, so I have not calculated anything.',
  ];

  const speciesChanged = conflict.fields.includes('species');
  if (speciesChanged) {
    lines.push(
      '',
      `Species is the part that matters most: ${SPECIES_LABEL[pet.speciesCode] ?? 'this species'} and ${SPECIES_LABEL[conflict.statedSpecies ?? ''] ?? 'that species'} need different food, different amounts and different warning signs.`,
    );
  }

  lines.push(
    '',
    'Which would you like?',
    `1. Advice for ${pet.name || 'the selected pet'} — the ${SPECIES_LABEL[pet.speciesCode] ?? 'animal'} whose record is open.`,
    '2. Advice for the animal described — add it under Pets → Add pet, select it, then ask again. Every answer here is built from the selected pet\'s record, so the right pet has to be selected first.',
    '',
    'If you meant a general question and not one particular animal, say so ("for a dog in general") and I will answer generally without using this pet\'s numbers.',
    '',
    'If either animal is unwell — not eating, vomiting, breathing difficulty, collapse or a suspected poisoning — contact a veterinarian rather than waiting for this answer.',
  );

  return lines.join('\n');
}
