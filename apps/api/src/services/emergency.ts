export interface EmergencyRule {
  id: string;
  species: string[];
  label: string;
  pattern: RegExp;
  advice: string;
}

/**
 * Deterministic safety layer. These rules escalate to urgent veterinary care.
 * They are intentionally conservative and never produce a diagnosis or a dose.
 */
const RULES: EmergencyRule[] = [
  {
    id: 'chocolate',
    species: ['dog', 'cat'],
    label: 'Possible chocolate exposure',
    pattern: /chocolat|cocoa|cacao/i,
    advice: 'Chocolate can be dangerous, especially dark chocolate or cocoa. Contact a veterinarian or emergency hospital now with the product type and estimated amount. Do not wait for symptoms.',
  },
  {
    id: 'xylitol',
    species: ['dog'],
    label: 'Possible xylitol exposure',
    pattern: /xylitol|sugar[- ]?free (gum|mints|candy)|sugarless gum/i,
    advice: 'Xylitol can cause a rapid, dangerous drop in blood sugar and liver injury in dogs. Treat this as an emergency and contact a veterinarian immediately.',
  },
  {
    id: 'grapes',
    species: ['dog', 'cat'],
    label: 'Possible grape or raisin exposure',
    pattern: /grape|raisin|sultana/i,
    advice: 'Grapes and raisins can cause kidney injury. There is no reliable safe amount. Contact a veterinarian or emergency hospital now.',
  },
  {
    id: 'allium',
    species: ['dog', 'cat'],
    label: 'Possible onion or garlic exposure',
    pattern: /\bonion|\bgarlic|shallot|leek/i,
    advice: 'Onions, garlic and similar alliums can damage red blood cells, especially in cats and with larger or repeated exposures. Contact a veterinarian for advice.',
  },
  {
    id: 'poison',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Possible poison or pesticide exposure',
    pattern: /rat poison|rodenticide|pesticide|insecticide|antifreeze|coolant|snail bait|poison(ed|ing)?/i,
    advice: 'Poisoning can worsen quickly. Keep the packaging, move the animal away from the source, and contact a veterinarian or emergency hospital immediately. Do not induce vomiting unless a veterinarian tells you to.',
  },
  {
    id: 'breathing',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Breathing difficulty',
    pattern: /(can.?t|cannot|difficulty|trouble|struggling|hard) (to )?breath|open[- ]?mouth breath|gasping|blue (gums|tongue)|choking/i,
    advice: 'Difficulty breathing is an emergency. Keep the animal calm and minimally handled, avoid the heat, and go to a veterinarian or emergency hospital now.',
  },
  {
    id: 'collapse',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Collapse, seizure or unconsciousness',
    pattern: /collaps|unconscious|seizure|convuls|fitting|can.?t stand|unable to stand|downer/i,
    advice: 'Collapse, seizures and inability to stand are emergencies. Protect the animal from injury, do not put anything in the mouth, and contact a veterinarian immediately.',
  },
  {
    id: 'heatstroke',
    species: ['dog', 'cat'],
    label: 'Possible heatstroke',
    pattern: /heat ?stroke|overheat|panting (heavily|excessively)|left in (a )?(car|vehicle)|hot car/i,
    advice: 'Heatstroke is life-threatening. Move the animal to shade, begin gentle cooling with cool water while arranging transport, and go to a veterinarian immediately. Do not use ice-cold water or force fluids.',
  },
  {
    id: 'bloat_dog',
    species: ['dog'],
    label: 'Possible bloat (GDV)',
    pattern: /bloat|swollen (belly|abdomen)|distended (belly|abdomen)|unproductive (vomit|retching)|dry heaving/i,
    advice: 'A swollen abdomen with unproductive retching can indicate a life-threatening stomach torsion. Do not wait — go to an emergency veterinary hospital now.',
  },
  {
    id: 'urinary_cat',
    species: ['cat'],
    label: 'Possible urinary blockage',
    pattern: /(straining|strain|crying|can.?t|cannot|unable).{0,40}(urinate|urinating|pee|peeing|piss)|no urine|blocked (bladder|urethra)|litter (box).{0,30}(nothing|no urine)/i,
    advice: 'A male cat straining or unable to urinate may have a blockage that can be fatal within a day. Go to a veterinarian or emergency hospital now.',
  },
  {
    id: 'bleeding',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Significant bleeding',
    pattern: /bleeding (heavily|a lot|profusely|non-?stop|won.?t stop|won.t stop|still)|won.?t stop bleeding|hasn.?t stopped bleeding|blood loss|deep (cut|wound)|hit by (a )?(car|vehicle)|bleeding from a (broken )?(nail|claw|toe|paw|cut|wound)|broken (nail|claw).{0,30}bleed|(nail|claw|toe|paw|cut|wound).{0,30}bleeding/i,
    advice: 'Apply gentle pressure with a clean cloth if safe to do so, keep the animal warm, and go to a veterinarian immediately. Do not remove an object stuck in a wound.',
  },
  {
    id: 'vomiting',
    species: ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
    label: 'Persistent vomiting or vomiting with blood',
    pattern: /vomit(?!ing\b.{0,40}(sign|watch|monitor))|throw(?:ing|s)? up|threw up|puk(?:e|es|ed|ing)|barf(?:s|ed|ing)?|coffee[- ]?ground (vomit|stool)|blood in (the )?vomit|can.?t keep (water|food|anything) down|cannot keep (water|food|anything) down/i,
    advice: 'Repeated vomiting, vomit containing blood, or vomiting that will not settle can be serious and dehydrate small animals quickly. Do not give human medicines and do not induce vomiting. Contact a veterinarian today; go to an emergency hospital if the vomiting is repeated over hours, the vomit contains blood, or the animal also collapses, cannot stand, or has a painful, swollen belly.',
  },
  {
    id: 'rumen_bloat',
    species: ['cow', 'goat'],
    label: 'Possible rumen bloat',
    pattern: /bloat|swollen (left )?(flank|belly|abdomen)|distended (flank|belly|abdomen)|difficult (calving|kidding)|downer/i,
    advice: 'Bloat and difficult calving/kidding are emergencies in cattle and goats. Remove suspected feed and contact a large-animal veterinarian immediately. Do not attempt to puncture the abdomen.',
  },
  {
    id: 'bird_respiratory',
    species: ['bird'],
    label: 'Possible avian respiratory distress',
    pattern: /open[- ]?mouth breath|tail bob|breathing (hard|heavily)|sitting on (the )?cage floor|fluffed.{0,30}(floor|bottom)/i,
    advice: 'Birds mask illness until they are very unwell. Open-mouth breathing, tail bobbing or sitting fluffed on the cage floor needs prompt avian veterinary care. Keep the bird warm, quiet and away from fumes.',
  },
  {
    id: 'not_eating',
    species: ['dog', 'cat', 'bird', 'cow', 'goat'],
    label: 'Not eating or drinking',
    pattern: /(hasn.?t|has not|not|stopped|refus\w*) (eating|eaten|drinking|drunk)|no appetite|anorexi/i,
    advice: 'A pet that stops eating or drinking can deteriorate quickly, especially cats, small birds and young animals. Contact a veterinarian the same day; do not force food or water.',
  },
];

export interface EmergencyMatch {
  ruleId: string;
  label: string;
  advice: string;
}

export function detectEmergency(text: string, speciesCode: string): EmergencyMatch | null {
  const normalized = text.toLowerCase();
  for (const rule of RULES) {
    if (!rule.species.includes(speciesCode)) continue;
    if (rule.pattern.test(normalized)) {
      return { ruleId: rule.id, label: rule.label, advice: rule.advice };
    }
  }
  return null;
}

export const emergencyRuleSummaries = RULES.map((r) => ({
  id: r.id,
  species: r.species,
  label: r.label,
}));
