import { getDb } from './db.js';
import { chunkText } from './util.js';

type Cast = Record<string, string>;

function toPgArray(values: string[]): string {
  return `{${values
    .map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')}}`;
}

/** Insert one row, casting text[] and jsonb columns where the caller asks. */
export async function insertRow(
  table: string,
  row: Record<string, unknown>,
  casts: Cast = {},
): Promise<void> {
  const db = await getDb();
  const cols = Object.keys(row);
  const placeholders = cols.map((c, i) => (casts[c] ? `$${i + 1}::${casts[c]}` : `$${i + 1}`));
  const values = cols.map((c) => {
    if (casts[c] === 'jsonb') return JSON.stringify(row[c]);
    if (casts[c] === 'text[]') return toPgArray(row[c] as string[]);
    return row[c];
  });
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values,
  );
}

const insert = insertRow;

const SPECIES = [
  { code: 'dog', name: 'Dog', category: 'companion', icon: '🐕', sort_order: 10, description: 'Companion dogs, including Indian pariah/indie dogs and mixed breeds.' },
  { code: 'cat', name: 'Cat', category: 'companion', icon: '🐈', sort_order: 20, description: 'Companion cats, including Indian domestic shorthairs.' },
  { code: 'bird', name: 'Bird', category: 'companion', icon: '🦜', sort_order: 30, description: 'Companion birds and poultry. Husbandry needs differ sharply between them.' },
  { code: 'cow', name: 'Cow', category: 'farm', icon: '🐄', sort_order: 40, description: 'Cattle kept as household animals or on farms.' },
  { code: 'goat', name: 'Goat', category: 'farm', icon: '🐐', sort_order: 50, description: 'Goats kept as household animals or on farms.' },
  { code: 'other', name: 'Other animal', category: 'other', icon: '🐾', sort_order: 90, description: 'Rabbits, horses, fish, reptiles and other species. Support is limited.' },
];

const BREEDS: Record<string, string[]> = {
  dog: [
    'Labrador Retriever', 'German Shepherd', 'Golden Retriever', 'Indian Pariah Dog / Indie',
    'Indian Spitz', 'Pomeranian', 'Shih Tzu', 'Beagle', 'Rottweiler', 'Pug', 'Dachshund',
    'Doberman Pinscher', 'Mixed breed', 'Other / Unknown',
  ],
  cat: [
    'Domestic Shorthair / Indian Indie', 'Persian', 'Siamese', 'Bengal', 'Maine Coon',
    'Mixed breed', 'Other / Unknown',
  ],
  bird: [
    'Budgerigar / Budgie', 'Cockatiel', 'Lovebird', 'Indian Ringneck Parakeet',
    'Other companion parrot', 'Pigeon', 'Chicken (poultry)', 'Duck (poultry)', 'Other / Unknown',
  ],
  cow: [
    'Gir', 'Sahiwal', 'Red Sindhi', 'Tharparkar', 'Jersey Crossbreed',
    'Holstein Friesian Crossbreed', 'Other / Unknown',
  ],
  goat: [
    'Jamunapari', 'Beetal', 'Barbari', 'Osmanabadi', 'Black Bengal', 'Sirohi',
    'Boer Crossbreed', 'Other / Unknown',
  ],
  other: ['Other / Unknown'],
};

const CAPABILITIES: Array<[string, string, string, string]> = [
  ['dog', 'symptom_check', 'limited', 'A small, reviewed demo corpus and deterministic emergency rules exist. No clinical validation study has been completed.'],
  ['dog', 'emergency_triage', 'limited', 'Deterministic red-flag rules cover common toxicities and emergencies, but they cannot rule out an emergency.'],
  ['dog', 'food_safety', 'limited', 'A curated demo toxicity table exists for common foods. Species and dose nuance is not modelled.'],
  ['dog', 'general_care', 'limited', 'Basic husbandry and preventive-care references exist. Individual advice still requires a veterinarian.'],
  ['dog', 'image_analysis', 'not_supported', 'No validated veterinary vision model is integrated. Do not upload images expecting a diagnosis.'],
  ['dog', 'medication_guidance', 'not_supported', 'The platform never recommends prescription drugs or doses.'],
  ['cat', 'symptom_check', 'limited', 'A small, reviewed demo corpus and deterministic emergency rules exist. No clinical validation study has been completed.'],
  ['cat', 'emergency_triage', 'limited', 'Rules cover urinary blockage, breathing difficulty, toxin exposure and collapse, but cannot rule out an emergency.'],
  ['cat', 'food_safety', 'limited', 'A curated demo toxicity table exists for common foods. Dose and individual risk are not modelled.'],
  ['cat', 'general_care', 'limited', 'Basic husbandry and preventive-care references exist. Individual advice still requires a veterinarian.'],
  ['cat', 'image_analysis', 'not_supported', 'No validated veterinary vision model is integrated.'],
  ['cat', 'medication_guidance', 'not_supported', 'The platform never recommends prescription drugs or doses.'],
  ['bird', 'general_care', 'limited', 'Limited husbandry guidance for common companion birds and poultry exists.'],
  ['bird', 'symptom_check', 'not_supported', 'Avian disease signs are non-specific and easily missed. The platform will not attempt a diagnosis.'],
  ['bird', 'emergency_triage', 'limited', 'Only broad red-flag escalation is available for birds; seek an avian veterinarian.'],
  ['bird', 'food_safety', 'not_supported', 'Species-specific avian toxicity data is not curated.'],
  ['cow', 'general_care', 'limited', 'Limited husbandry and bloat-awareness guidance exists for cattle.'],
  ['cow', 'symptom_check', 'not_supported', 'No validated cattle diagnostic support. Contact a large-animal veterinarian.'],
  ['cow', 'emergency_triage', 'limited', 'A few red-flag rules (bloat, downer animal, difficult calving) trigger escalation only.'],
  ['cow', 'food_safety', 'not_supported', 'Feed safety is not curated for cattle.'],
  ['goat', 'general_care', 'limited', 'Limited husbandry and bloat-awareness guidance exists for goats.'],
  ['goat', 'symptom_check', 'not_supported', 'No validated goat diagnostic support. Contact a large-animal veterinarian.'],
  ['goat', 'emergency_triage', 'limited', 'A few red-flag rules (bloat, downer animal, difficult kidding) trigger escalation only.'],
  ['goat', 'food_safety', 'not_supported', 'Feed safety is not curated for goats.'],
  ['other', 'general_care', 'not_supported', 'No curated guidance for this species. Please consult a veterinarian experienced with it.'],
  ['other', 'symptom_check', 'not_supported', 'Not supported.'],
  ['other', 'emergency_triage', 'not_supported', 'Not supported. Seek immediate veterinary care.'],
  ['other', 'food_safety', 'not_supported', 'Not supported.'],
];

const KNOWLEDGE = [
  {
    id: 'kd_heatstroke',
    title: 'Heatstroke warning signs in dogs and cats',
    species: ['dog', 'cat'],
    category: 'emergency',
    content: `Heatstroke is a life-threatening emergency. It is more likely in hot, humid Indian weather, in brachycephalic (flat-faced) breeds, in overweight animals, and when an animal is left in a parked vehicle or exercised in peak heat.

Warning signs can include heavy panting that does not settle, drooling, bright red gums, weakness or collapse, vomiting, confusion, and in severe cases seizures. Cats may hide and pant only late in the course.

First response is to move the animal to a shaded, ventilated area and begin gentle cooling with room-temperature or cool (not ice-cold) water, especially on the neck, armpits and groin, while arranging transport to a veterinarian. Do not force fluids into the mouth. Cooling should not delay veterinary assessment.

This demo reference is general information, not a diagnosis or a treatment plan. Any animal showing these signs needs urgent veterinary assessment.`,
  },
  {
    id: 'kd_chocolate',
    title: 'Chocolate and xylitol exposure in dogs',
    species: ['dog'],
    category: 'toxicology',
    content: `Chocolate contains methylxanthines that dogs cannot metabolise safely. Dark chocolate and cocoa powder are more dangerous than milk chocolate per gram, but any amount warrants a prompt call to a veterinarian with the product type and estimated amount eaten.

Xylitol, a sugar substitute found in some sugar-free gum, mints, baked goods and dental products, can cause a rapid insulin release and dangerously low blood sugar in dogs, and can injure the liver. Even small exposures can be serious.

Do not wait for symptoms. Do not induce vomiting unless a veterinarian instructs you to. Record the packaging and time of ingestion and contact a veterinarian or an emergency veterinary hospital immediately.

This demo reference is general information only and does not replace veterinary assessment.`,
  },
  {
    id: 'kd_cat_urinary',
    title: 'Urinary blockage in male cats is an emergency',
    species: ['cat'],
    category: 'emergency',
    content: `A male cat that strains to urinate, visits the litter box repeatedly, cries while urinating, or produces little or no urine may have a urethral obstruction. This is a life-threatening emergency that can become fatal within a day.

Other warning signs include vomiting, lethargy, hiding, abdominal pain and a hard or painful abdomen. Do not wait to see whether it resolves, and do not give human medicines.

Contact a veterinarian or emergency hospital immediately. While arranging transport, keep the cat calm and do not restrict water unless a veterinarian advises it.

This demo reference is general information, not a diagnosis.`,
  },
  {
    id: 'kd_vaccination',
    title: 'Core vaccination principles for dogs and cats',
    species: ['dog', 'cat'],
    category: 'preventive',
    content: `Vaccination schedules should be set by a veterinarian for the individual animal. Puppies and kittens typically receive a series of core vaccines with intervals set by the veterinarian, followed by booster doses. Adult animals generally need periodic boosters, with timing depending on the vaccine and local risk.

Rabies vaccination is strongly recommended for dogs and cats in India and is required by many municipal bodies. Keep a written record with product name, date and batch where available, and record the next due date your veterinarian advises.

Mild post-vaccination soreness or sleepiness can occur. Facial swelling, persistent vomiting, difficulty breathing or collapse after vaccination need urgent veterinary attention.

This demo reference is general information. It is not a dosing schedule; follow your veterinarian's written plan.`,
  },
  {
    id: 'kd_feeding',
    title: 'Feeding dogs and cats safely at home',
    species: ['dog', 'cat'],
    category: 'nutrition',
    content: `Dogs and cats have different nutritional needs. Cats are obligate carnivores and need nutrients such as taurine that are supplied by complete commercial cat food or a properly formulated diet. Dogs do better on complete dog food than on table scraps.

Sudden diet changes can cause digestive upset. If a change is needed, transition gradually over about a week while monitoring appetite and stool. Fresh water should be available at all times, and food bowls should be cleaned regularly. Measuring portions helps prevent obesity.

Some human foods are dangerous: chocolate, grapes and raisins, onions and garlic, xylitol, alcohol and caffeine are common examples for dogs. Home-cooked diets should be formulated with veterinary input rather than guessed.

This demo reference is general information, not an individual feeding plan.`,
  },
  {
    id: 'kd_grooming',
    title: 'Grooming, coat and skin checks',
    species: ['dog', 'cat'],
    category: 'husbandry',
    content: `Regular grooming is a chance to check the whole body. Part the coat and look for fleas, ticks, redness, scabs, lumps, wounds and areas of hair loss. Check ears for discharge or odour, and check paws for cuts or foreign objects.

Brushing frequency depends on coat type: long or double coats need more frequent brushing, especially during seasonal shedding, while short coats may need only weekly grooming. Bathe with a pet-specific shampoo only as often as needed; over-bathing can dry the skin.

Do not use human medicated shampoos or spot-on products meant for another species. Cats are especially sensitive to some permethrin-containing dog products. Sudden excessive scratching, head shaking or a rapidly growing lump should be assessed by a veterinarian.

This demo reference is general information, not a diagnosis.`,
  },
  {
    id: 'kd_bird_husbandry',
    title: 'Everyday husbandry for companion birds',
    species: ['bird'],
    category: 'husbandry',
    content: `Companion birds hide illness well. Daily observation of appetite, droppings, activity and breathing matters more than occasional checks. A bird that sits fluffed on the cage floor, breathes with an open beak or tail bob, or stops eating should be seen by an avian veterinarian promptly.

Provide a cage large enough for flight and stretching, with perches of varied safe materials, protection from kitchen fumes and drafts, and a quiet sleep period. Fresh water and a species-appropriate diet are essential; all-seed diets are nutritionally incomplete for many parrots.

Birds are sensitive to fumes from non-stick cookware, aerosols, smoke and some cleaning products. Keep the cage away from the kitchen.

This demo reference covers basic husbandry only. It is not avian medical advice, and the platform does not attempt to diagnose bird disease.`,
  },
  {
    id: 'kd_cattle_bloat',
    title: 'Bloat and dietary upsets in cattle and goats',
    species: ['cow', 'goat'],
    category: 'emergency',
    content: `Rumen bloat is a serious emergency in cattle and goats. The left flank may become visibly distended, the animal may stop eating, stand uncomfortably, breathe rapidly or drool. A downer animal or one in respiratory distress needs immediate large-animal veterinary help.

Risk increases after abrupt access to lush legumes, wet fodder, or finely ground feed, and after a sudden diet change. Prevention includes gradual dietary transitions, adequate roughage and consistent feeding times.

Do not attempt to puncture the rumen or give human medicines. Keep the animal calm, remove the suspected feed and call a veterinarian immediately.

This demo reference covers awareness only and is not a diagnosis or treatment plan.`,
  },
  {
    id: 'kd_vomiting',
    title: 'Vomiting and digestive upset in dogs and cats',
    species: ['dog', 'cat'],
    category: 'emergency',
    content: `Vomiting in dogs and cats has many possible causes, from a simple dietary indiscretion (eating too fast, scraps, rich or unfamiliar food) to more serious problems such as a swallowed foreign body, toxin exposure, infection or organ disease. A single vomit in an otherwise bright animal that is eating normally can be watched at home, but repeated vomiting needs veterinary assessment.

Contact a veterinarian the same day if vomiting repeats over several hours, the vomit contains blood or looks like coffee grounds, the animal cannot keep water down, or vomiting comes with lethargy, refusing food, diarrhoea, a painful or swollen belly, or collapse. Kittens, puppies, senior animals and small birds dehydrate quickly, so do not wait long with them. Do not give human medicines such as paracetamol or ibuprofen, and do not induce vomiting unless a veterinarian instructs you to.

While arranging care, note how many times the animal vomited, what the vomit looked like, when it last ate or drank, and whether it is passing stool and urine. Withhold food briefly only if a veterinarian advises it, and offer small amounts of water rather than large drinks on an empty stomach.

This demo reference is general information, not a diagnosis. Repeated or bloody vomiting, or vomiting with collapse or a swollen belly, needs urgent veterinary assessment.`,
  },
  {
    id: 'kd_senior_pets',
    title: 'Senior pet check-ups',
    species: ['dog', 'cat'],
    category: 'preventive',
    content: `Older dogs and cats benefit from more frequent veterinary check-ups, often every six months. Changes in thirst, urination, appetite, weight, mobility, sleep or behaviour can be early signs of common age-related disease and are worth discussing with a veterinarian.

At home, keep a simple log of weight, appetite, water intake and activity. Make sure bedding is comfortable and accessible, and adjust exercise to the animal's tolerance. Do not start supplements or pain relief without veterinary advice.

This demo reference is general information, not a diagnosis.`,
  },
];

const FOODS: Array<[string, string, string, string]> = [
  ['Chocolate', 'dog', 'toxic', 'Contains methylxanthines; dark chocolate and cocoa are most dangerous. Contact a veterinarian immediately.'],
  ['Chocolate', 'cat', 'toxic', 'Cats are also sensitive to methylxanthines. Seek veterinary advice immediately.'],
  ['Grapes and raisins', 'dog', 'toxic', 'Can cause kidney injury in dogs; there is no reliable safe amount.'],
  ['Onion and garlic', 'dog', 'toxic', 'Can damage red blood cells, especially in large amounts or repeated exposure.'],
  ['Onion and garlic', 'cat', 'toxic', 'Cats are especially sensitive to allium toxicity.'],
  ['Xylitol', 'dog', 'toxic', 'Sugar substitute that can cause severe low blood sugar and liver injury.'],
  ['Macadamia nuts', 'dog', 'toxic', 'Can cause weakness, tremors and vomiting.'],
  ['Alcohol', 'dog', 'toxic', 'Causes central nervous system depression; even small amounts can be dangerous.'],
  ['Caffeine', 'dog', 'toxic', 'Coffee, tea and energy drinks can cause restlessness, racing heart and tremors.'],
  ['Avocado', 'dog', 'caution', 'The flesh is generally low risk in small amounts but the pit is a choking/obstruction hazard.'],
  ['Milk', 'cat', 'caution', 'Many adult cats are lactose intolerant; small amounts may cause diarrhoea.'],
  ['Cooked bones', 'dog', 'caution', 'Cooked bones can splinter and cause obstruction or perforation.'],
  ['Salt', 'dog', 'toxic', 'Large amounts can cause salt poisoning; keep salty snacks away.'],
  ['Cooked plain chicken', 'dog', 'safe', 'Plain, boneless, unseasoned chicken is generally well tolerated in small amounts as a treat.'],
  ['Cooked plain chicken', 'cat', 'safe', 'Plain, boneless, unseasoned chicken can be a treat, not a complete diet.'],
  ['Blueberries', 'dog', 'safe', 'A small amount of plain blueberries is generally safe as an occasional treat.'],
  ['Raw fish', 'cat', 'caution', 'Raw fish carries parasite and thiaminase risk; cook or use complete commercial food.'],
  ['Seeds (mixed)', 'bird', 'caution', 'All-seed diets are nutritionally incomplete for many parrots; use a formulated diet.'],
  ['Lush legume fodder', 'cow', 'caution', 'Sudden large amounts can predispose cattle to bloat. Transition gradually.'],
  ['Lush legume fodder', 'goat', 'caution', 'Sudden large amounts can predispose goats to bloat. Transition gradually.'],
];

type InsertFn = (table: string, row: Record<string, unknown>, casts?: Cast) => Promise<void>;

/**
 * A small set of ADMINISTRATOR-APPROVED nutrition records so owners see
 * real (demo-labelled) guidance immediately. The 1,200 workbook rows are
 * imported separately via `npm run import:workbook` and stay pending
 * until reviewed — they are never shown as recommendations.
 */
async function seedNutrition(insert: InsertFn): Promise<void> {
  const approved = {
    review_status: 'approved', is_demo: true, reviewed_by: null,
    reviewed_at: new Date().toISOString(),
    review_notes: 'Synthetic demo corpus approved for product demonstration only. Not a substitute for veterinary nutrition review.',
    version: 1,
  };

  await insert('nutrition_sources', {
    id: 'ns_merck_nutrition', source_name: 'Merck Veterinary Manual — Nutritional Requirements of Small Animals (demo reference)',
    url: 'https://www.merckvetmanual.com/management-and-nutrition/nutrition-small-animals/nutritional-requirements-of-small-animals',
    usage_notes: 'Life-stage requirements and risks from unbalanced homemade diets.',
    ...approved,
  });

  const hazards: Array<[string, string[], string, string, string, string, string]> = [
    // [id, species, food, classification, severity, risk, action]
    ['nh_demo_chocolate', ['dog', 'cat'], 'Chocolate / cocoa / caffeine', 'Toxic risk', 'toxic',
      'Can affect the heart and nervous system; toxicity depends on amount and product.',
      'Contact a veterinarian promptly; do not wait for symptoms and do not induce vomiting unless told to.'],
    ['nh_demo_xylitol', ['dog'], 'Xylitol-containing sugar-free products', 'Toxic risk', 'toxic',
      'Can cause severe low blood sugar and liver injury, even from small amounts.',
      'Emergency veterinary contact immediately. Take the packaging with you.'],
    ['nh_demo_grapes', ['dog'], 'Grapes / raisins / currants', 'Potentially toxic', 'potentially_toxic',
      'Kidney injury has been reported and individual sensitivity is unpredictable.',
      'Contact a veterinarian promptly after ingestion — amount "safe" cannot be calculated.'],
    ['nh_demo_onion', ['dog', 'cat'], 'Onion, garlic, leek, chives (allium family)', 'Avoid/toxic risk', 'potentially_toxic',
      'Can damage red blood cells; cats are more sensitive than dogs.',
      'Contact a veterinarian after significant ingestion.'],
    ['nh_demo_dogfood_cat', ['cat'], 'Dog food as the regular sole diet', 'Nutritionally inappropriate', 'nutritionally_inappropriate',
      'May not meet feline nutrient requirements including taurine.',
      'Use a complete balanced cat food; ask a veterinarian for transition advice.'],
    ['nh_demo_avocado', ['bird'], 'Avocado (persin)', 'Avoid/toxic risk', 'toxic',
      'Reported toxic to birds; sensitivity varies by species.',
      'Contact an avian veterinarian promptly after ingestion.'],
    ['nh_demo_moldy_feed', ['cow', 'goat'], 'Moldy or spoiled feed, unknown toxic plants', 'Avoid', 'caution',
      'May cause poisoning or digestive illness; plant safety cannot be judged by appearance.',
      'Remove access immediately and contact a veterinarian if exposure or symptoms occur.'],
    ['nh_demo_unknown_substances', ['dog', 'cat', 'bird', 'cow', 'goat', 'other'],
      'Unknown plants, pesticides, cleaning chemicals, human medicines', 'Unknown/high risk', 'unknown',
      'Safety cannot be inferred from appearance or from another species\' tolerance.',
      'Contact a veterinarian or poison service promptly if exposure occurs.'],
  ];
  for (const [id, species, food, classification, severity, risk, action] of hazards) {
    await insert('nutrition_hazards', {
      id, species_codes: species, food_or_substance: food, classification, severity,
      risk, recommended_action: action, source_id: 'ns_merck_nutrition', ...approved,
    }, { species_codes: 'text[]' });
  }

  const recipes: Array<[string, string, string, string, string[], string[], string]> = [
    // [id, species, name, dietRole, ingredients, steps, safety]
    ['nr_demo_dog_chicken', 'dog', 'Plain cooked chicken treat', 'Treat only; not a complete diet',
      ['Boneless skinless chicken', 'Water'],
      ['1. Cook thoroughly with no seasoning, oil, salt, onion or garlic.',
       '2. Remove every bone fragment.', '3. Cool completely.',
       '4. Shred into small pieces.', '5. Offer a small treat only — keep treats under 10% of daily intake.'],
      'No salt, onion, garlic, oil, butter or stock cubes. Never a complete diet; fed alongside a complete food.'],
    ['nr_demo_dog_pumpkin', 'dog', 'Plain pumpkin add-on', 'Supplement only; not a complete diet',
      ['Plain pumpkin (no sweeteners)'],
      ['1. Cook until soft.', '2. Remove skin and seeds.', '3. Mash plain.', '4. Cool fully.',
       '5. Offer a small amount only if suitable for the individual dog.'],
      'Not a treatment for persistent digestive signs; avoid sweetened pie filling.'],
    ['nr_demo_cat_egg', 'cat', 'Fully cooked egg treat', 'Occasional treat only; not a complete diet',
      ['Egg'],
      ['1. Cook fully with no seasoning.', '2. Cool.', '3. Remove shell.',
       '4. Offer a very small portion occasionally.'],
      'Not a complete diet; avoid raw egg. Cats still need complete balanced nutrition including taurine.'],
    ['nr_demo_cow_ration', 'cow', 'Forage-based ration planning template', 'Planning template — NOT a fixed recipe',
      ['Suitable forage', 'Clean water', 'Other feeds only as professionally specified'],
      ['1. Identify life and production stage.', '2. Assess weight and body condition.',
       '3. Check local feed and forage quality.', '4. Have a livestock nutritionist or veterinarian calculate the ration.',
       '5. Introduce changes gradually.'],
      'No universal gram quantities exist. Mineral balance and local forage matter — a formulated feed plan is required.'],
    ['nr_demo_goat_ration', 'goat', 'Forage-based ration planning template', 'Planning template — NOT a fixed recipe',
      ['Known-safe forage and browse', 'Clean water', 'Additional feed only as professionally specified'],
      ['1. Identify life stage and production needs.', '2. Estimate weight and body condition.',
       '3. Identify forage plants and confirm they are safe.', '4. Have a livestock nutritionist formulate the ration.',
       '5. Introduce changes gradually.'],
      'Do not guess grain or mineral amounts; verify plant safety and species-specific mineral needs (e.g. copper).'],
  ];
  for (const [id, species, name, role, ingredients, steps, safety] of recipes) {
    await insert('nutrition_recipes', {
      id, species_code: species, recipe_name: name, diet_role: role,
      applicability: 'Only for a healthy individual of this species without relevant allergy or prescribed restriction.',
      ingredients, steps, safety_notes: safety,
      storage_instructions: null, storage_known: false,
      is_complete_diet: false, nutritional_adequacy: 'not_evaluated',
      source_id: 'ns_merck_nutrition', ...approved,
    }, { ingredients: 'text[]', steps: 'text[]' });
  }

  const breedRows: Array<[string, string, string, string, string]> = [
    ['nb_demo_lab_adult', 'dog', 'Labrador Retriever', 'adult',
      'Labs are prone to weight gain; measure meals, use body condition scoring, and keep treats incidental. Choose a complete food appropriate for adult dogs.'],
    ['nb_demo_lab_senior', 'dog', 'Labrador Retriever', 'senior',
      'Senior labs often need calorie control and joint-supportive body condition; discuss senior nutrition at wellness visits.'],
    ['nb_demo_dsh_adult', 'cat', 'Domestic Shorthair / Indian Indie', 'adult',
      'Indie cats are often robust, but portion control still matters indoors; wet food supports urinary health.'],
  ];
  for (const [id, species, breed, stage, guidance] of breedRows) {
    await insert('nutrition_breed_guidance', {
      id, species_code: species, breed_or_type: breed, life_stage: stage,
      general_guidance: guidance,
      limitation: 'Breed alone cannot determine exact portions, allergy status or a therapeutic diet. Consider weight, body condition, activity, diagnosis and veterinary plan.',
      referral_rule: 'For disease, allergies, growth, pregnancy/lactation or persistent symptoms, obtain a veterinary nutrition plan.',
      source_id: 'ns_merck_nutrition', ...approved,
    });
  }

  const healthRules: Array<[string, string, string[], string, string, string]> = [
    ['nhr_demo_obesity', 'Obesity', ['obesity', 'overweight', 'weight management', 'body condition'],
      'Individualized calorie and feeding plan; monitor body condition regularly.',
      'No crash dieting; do not calculate intake from breed alone.',
      'Veterinarian or veterinary nutritionist.'],
    ['nhr_demo_allergy', 'Food allergy suspected', ['allergy', 'allergies', 'allergic', 'sensitivity', 'intolerance', 'diet trial'],
      'A veterinarian-directed controlled diet trial may be needed to identify the trigger.',
      'No casual ingredient swaps or treats during a strict trial — even one treat can invalidate results.',
      'Veterinarian.'],
    ['nhr_demo_kidney', 'Kidney disease', ['kidney', 'renal'],
      'Kidney disease diets are prescribed, not chosen from general guidance; protein, phosphorus and sodium balance matter.',
      'Do not start, stop or change a kidney diet without the treating veterinarian.',
      'Veterinarian — urgent if appetite drops or weight loss occurs.'],
    ['nhr_demo_diabetes', 'Diabetes', ['diabetes', 'diabetic', 'blood sugar'],
      'Consistent carbohydrate source and measured feeding times alongside insulin — dietary consistency is part of treatment.',
      'Do not change food or meal timing without coordinating with the veterinarian managing insulin.',
      'Veterinarian — same-day contact for lethargy, vomiting or not eating.'],
  ];
  for (const [id, condition, keywords, guidance, safety, referral] of healthRules) {
    await insert('nutrition_health_rules', {
      id, condition_or_goal: condition, keywords, general_guidance: guidance,
      safety_rule: safety, referral_rule: referral, source_id: 'ns_merck_nutrition', ...approved,
    }, { keywords: 'text[]' });
  }

  // A few approved master guidance rows (species-wide, adult) so the
  // personalized page has substance; the full 1,200-row workbook remains
  // in the pending review queue.
  const guidanceRows: Array<[string, string, string, string, string, string]> = [
    // [id, species, goal, general, suitableFoods, avoidText]
    ['ng_demo_dog_adult_maintenance', 'dog', 'Healthy maintenance',
      'Choose a complete and balanced adult dog diet from a manufacturer that practices quality control; adjust portions using measured weight, body condition and activity. Fresh water at all times.',
      'Small suitable treats for many healthy dogs include plain fully cooked boneless chicken, cooked egg and plain carrot — these are not complete diets and individual tolerance varies.',
      'Avoid chocolate/caffeine, xylitol products, grapes/raisins, the onion/garlic family, alcohol, raw yeast dough, cooked bones and spoiled food.'],
    ['ng_demo_dog_adult_condition', 'dog', 'Healthy body condition',
      'Monitor body condition and weight over time; portion size should be individualized rather than inferred from breed. Treats should stay under 10% of daily calories.',
      'High-volume low-calorie vegetables such as plain carrot or green beans can be treats for many dogs if tolerated.',
      'Avoid calorie-dense human foods, fried items and anything containing added sugar or xylitol.'],
    ['ng_demo_cat_adult_maintenance', 'cat', 'Healthy maintenance',
      'Cats are obligate carnivores: choose a complete balanced cat food with adequate taurine. Measure meals; free-feeding often leads to weight gain. Fresh water daily — many cats benefit from a water fountain.',
      'Small suitable treats for many healthy cats include plain fully cooked chicken or egg in tiny amounts; these are not complete diets.',
      'Never feed dog food as the regular diet, raw fish, bones, onion/garlic, or milk (most adult cats are lactose intolerant).'],
    ['ng_demo_bird_adult_maintenance', 'bird', 'Healthy maintenance',
      'A seed-only diet is nutritionally incomplete for most companion birds. Work towards a formulated pellet base with species-appropriate fresh vegetables; provide clean water daily and avoid avocado, chocolate, caffeine and fumes.',
      'Species-confirmed fresh vegetables can supplement a pellet-based diet; introduce gradually and remove spoilable items promptly.',
      'Never feed avocado, chocolate, caffeine, alcohol, fruit pits or unknown plants. Confirm suitability for the exact bird species with an avian veterinarian.'],
  ];
  for (const [id, species, goal, general, suitable, avoid] of guidanceRows) {
    await insert('nutrition_guidance', {
      id, record_key: id.replace(/^ng_/, 'DEMO-'), species_code: species,
      breed_or_type: null, life_stage: 'adult', nutrition_goal: goal,
      general_diet_guidance: general, suitable_foods_text: suitable,
      hazards_to_avoid_text: avoid, recipe_guidance_text: 'Homemade recipes are treats or supplements only — never the main diet — unless a veterinary nutritionist has formulated and validated them for this species and life stage.',
      goal_specific_guidance: 'Reassess at every wellness visit; changes in weight, appetite or stool quality deserve a veterinary check.',
      safety_cautions: 'Do not use a recipe as treatment or as a complete diet. For disease, allergies, growth, pregnancy/lactation or persistent symptoms, obtain a veterinary nutrition plan.',
      individualization_factors: 'Breed alone cannot determine food safety, exact portions or a therapeutic diet. Consider weight, body condition, activity, allergies, diagnosis, medications and the veterinary plan.',
      disclaimer: 'General educational guidance only; not a diagnosis or individualized prescription.',
      source_requirement: 'Demo record — link an exact supporting source and veterinary reviewer for production use.',
      data_quality_note: 'Synthetic demo record for product demonstration.',
      source_id: 'ns_merck_nutrition', ...approved,
    });
  }

  // One intentionally PENDING record so the admin queue and the
  // "unreviewed is not shown" behaviour are visible out of the box.
  await insert('nutrition_guidance', {
    id: 'ng_demo_pending_example', record_key: 'DEMO-PENDING-001', species_code: 'dog',
    breed_or_type: null, life_stage: 'senior', nutrition_goal: 'Senior joint support (candidate)',
    general_diet_guidance: 'This candidate record is intentionally left pending review. It must never appear in owner guidance until an administrator approves it.',
    suitable_foods_text: '', hazards_to_avoid_text: '', recipe_guidance_text: '',
    goal_specific_guidance: '', safety_cautions: '', individualization_factors: '',
    disclaimer: '', source_requirement: 'Add an exact supporting source and veterinary reviewer before approval.',
    data_quality_note: 'Queue demo record.',
    review_status: 'pending', is_demo: true, version: 1,
  });

  // Mirror every approved record into the RAG knowledge index so AI chat
  // can cite it (the workbook feeds retrieval, never model fine-tuning).
  const { syncNutritionRagMirror } = await import('./services/nutrition-rag.js');
  const nutritionDb = await getDb();
  for (const [kind, table] of [
    ['guidance', 'nutrition_guidance'], ['hazard', 'nutrition_hazards'],
    ['recipe', 'nutrition_recipes'], ['breed', 'nutrition_breed_guidance'],
    ['health_rule', 'nutrition_health_rules'],
  ] as const) {
    const rows = await nutritionDb.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE review_status = 'approved'`,
    );
    for (const row of rows) await syncNutritionRagMirror(kind, row.id, 'approved');
    // Baseline version-history entry for every seeded record so the admin
    // version view always has a v1 origin row.
    for (const row of rows) {
      await insert('nutrition_record_versions', {
        id: `nvv_${kind}_${row.id}`, record_type: kind, record_id: row.id,
        version: 1, action: 'imported', snapshot: {}, actor_id: null,
        notes: 'Seeded demo record (v1 baseline).',
      }, { snapshot: 'jsonb' });
    }
  }
  const pendingGuidance = await nutritionDb.query<{ id: string }>(
    `SELECT id FROM nutrition_guidance WHERE review_status = 'pending'`,
  );
  for (const row of pendingGuidance) {
    await insert('nutrition_record_versions', {
      id: `nvv_guidance_${row.id}`, record_type: 'guidance', record_id: row.id,
      version: 1, action: 'imported', snapshot: {}, actor_id: null,
      notes: 'Seeded queue record (v1 baseline).',
    }, { snapshot: 'jsonb' });
  }
}

export async function seed(options: { reset?: boolean } = {}): Promise<void> {
  const db = await getDb();
  const countRows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM species');
  const existing = Number(countRows[0]?.n ?? 0);
  if (existing > 0 && !options.reset) {
    console.log(`[seed] reference catalogs already loaded (${existing} species); skipping. Use "npm run seed -- --reset" to rebuild them.`);
    return;
  }

  if (options.reset) {
    console.log('[seed] resetting reference catalogs');
    for (const table of [
      'messages', 'threads', 'consultation_notes', 'appointments', 'ai_messages', 'ai_conversations',
      'reminders', 'notifications', 'push_subscriptions', 'care_logs', 'care_tasks', 'vaccinations',
      'vaccination_checkpoints', 'vaccine_schedules',
      'vet_slots', 'vet_applications', 'clinic_associations', 'directory_imports', 'maps_api_log',
      'files', 'pets', 'vet_profiles', 'content_reports', 'ai_evaluation_runs', 'knowledge_chunks',
      'knowledge_documents', 'food_items', 'clinics', 'capability_registry',
      'nutrition_record_versions', 'nutrition_guidance', 'nutrition_hazards', 'nutrition_recipes',
      'nutrition_breed_guidance', 'nutrition_health_rules', 'nutrition_sources',
      'breeds', 'species', 'audit_logs', 'settings', 'users',
    ]) {
      await db.query(`DELETE FROM ${table}`);
    }
  }

  for (const s of SPECIES) {
    await insert('species', {
      code: s.code, name: s.name, category: s.category, icon: s.icon,
      description: s.description, is_active: true, sort_order: s.sort_order,
    });
  }

  for (const [speciesCode, names] of Object.entries(BREEDS)) {
    let order = 10;
    for (const name of names) {
      const unknown = name === 'Other / Unknown';
      await insert('breeds', {
        id: `breed_${speciesCode}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}`,
        species_code: speciesCode,
        name,
        is_unknown: unknown,
        is_active: true,
        sort_order: order,
      });
      order += 10;
    }
  }

  // Vaccination schedule reference rows the feature ships with. These are the
  // workbook's general-guidance rows, approved here only as demo data; the full
  // workbook is imported as pending review (npm run import:vaccine-schedule).
  const DEMO_SCHEDULES: Array<{
    id: string; species: string; label: string; key: string; name: string;
    firstDose: string; firstDoseDays: number; series: string; seriesWeeks: number | null;
    booster: string; boosterMonths: number | null; mustCheck: string; guidance: string;
    basis: string;
  }> = [
    {
      id: 'vaxs_dog_core', species: 'dog', label: 'Dog', key: 'canine_core_combination',
      name: 'Canine core combination (distemper, adenovirus, parvovirus)',
      firstDose: '6–8 weeks', firstDoseDays: 42,
      series: 'Repeat every 3–4 weeks until final puppy dose at ≥16 weeks', seriesWeeks: 4,
      booster: 'Around 6 months after puppy series, then generally no more often than every 3 years for core MLV products; product/local rules apply',
      boosterMonths: null,
      mustCheck: 'Age in weeks; product label; prior doses',
      guidance: 'Core guideline reference; local vet to select product', basis: 'WSAVA 2024',
    },
    {
      id: 'vaxs_dog_rabies', species: 'dog', label: 'Dog', key: 'rabies', name: 'Rabies',
      firstDose: 'Often from 12 weeks / 3 months; minimum age depends on licensed product and local law',
      firstDoseDays: 84,
      series: 'As required by product label and applicable local law', seriesWeeks: null,
      booster: 'Commonly at 1 year after primary dose, then per product label/local rules', boosterMonths: null,
      mustCheck: 'Local law; product label; prior doses',
      guidance: 'Core guideline reference; local vet to select product', basis: 'WSAVA 2024',
    },
    {
      id: 'vaxs_cat_core', species: 'cat', label: 'Cat', key: 'core_feline_combination',
      name: 'Core feline combination (panleukopenia, herpesvirus-1, calicivirus)',
      firstDose: '6–8 weeks', firstDoseDays: 42,
      series: 'Repeat every 3–4 weeks until final kitten dose at ≥16 weeks', seriesWeeks: 4,
      booster: 'Consider dose at ≥26 weeks; then generally no more often than every 3 years for low-risk cats',
      boosterMonths: null,
      mustCheck: 'Age in weeks; product label; prior doses',
      guidance: 'Core guideline reference; local vet to select product', basis: 'WSAVA 2024',
    },
    {
      id: 'vaxs_cat_rabies', species: 'cat', label: 'Cat', key: 'rabies', name: 'Rabies',
      firstDose: 'Often from 12 weeks / 3 months; licensed product and local rules determine minimum age',
      firstDoseDays: 84,
      series: 'Product-specific', seriesWeeks: null,
      booster: 'Commonly at 1 year after primary dose, then per product label/local rules', boosterMonths: null,
      mustCheck: 'Local law; product label; prior doses',
      guidance: 'Core guideline reference; local vet to select product', basis: 'WSAVA 2024',
    },
  ];
  for (const s of DEMO_SCHEDULES) {
    await insert('vaccine_schedules', {
      id: s.id, species_code: s.species, species_label: s.label, vaccine_key: s.key,
      vaccine_name: s.name, first_dose_age_text: s.firstDose, first_dose_age_days: s.firstDoseDays,
      primary_series_text: s.series, booster_interval_text: s.booster,
      booster_interval_months: s.boosterMonths, must_check_before_scheduling: s.mustCheck,
      app_guidance: s.guidance, guidance_level: 'general_guidance',
      series_interval_weeks: s.seriesWeeks, auto_assignable: true, reference_basis: s.basis,
      status: 'approved', is_demo: true, reviewed_by: null,
      reviewed_at: new Date().toISOString(),
      review_notes: 'Demo row approved for product demonstration. Confirm each date with a veterinarian.',
    });
  }

  // Approved schedule rows become citable knowledge documents, exactly like
  // the nutrition workbook: retrieval only, never fine-tuning.
  const { syncAllApprovedVaccineSchedules } = await import('./services/vaccine-rag.js');
  await syncAllApprovedVaccineSchedules();

  for (const doc of KNOWLEDGE) {
    await insert('knowledge_documents', {
      id: doc.id, title: doc.title, species: doc.species, category: doc.category,
      source_org: 'Pet Vet AI demo corpus (illustrative, not a clinical authority)',
      source_url: null, published_year: 2026, content: doc.content,
      status: 'approved', is_demo: true, submitted_by: null,
      reviewed_by: null, reviewed_at: new Date().toISOString(),
      review_notes: 'Synthetic demo corpus approved for product demonstration only. Not medically reviewed.',
    }, { species: 'text[]' });
    const chunks = chunkText(doc.content);
    for (let i = 0; i < chunks.length; i++) {
      await insert('knowledge_chunks', {
        id: `${doc.id}_chunk_${i}`, document_id: doc.id, chunk_index: i, content: chunks[i],
      });
    }
  }

  await insert('knowledge_documents', {
    id: 'kd_pending_arthritis', title: 'Canine osteoarthritis: monitoring mobility at home',
    species: ['dog'], category: 'preventive',
    source_org: 'Unverified submission (demo)',
    source_url: null, published_year: 2026,
    content: 'This demo submission is intentionally pending review. It must not be retrieved by the AI until an administrator with clinical review responsibility approves it.',
    status: 'pending', is_demo: true, submitted_by: null,
  }, { species: 'text[]' });

  for (const [i, f] of FOODS.entries()) {
    await insert('food_items', {
      id: `food_${i}`, name: f[0], species_code: f[1], safety: f[2], notes: f[3],
      source_note: 'General veterinary consensus, curated for the demo dataset. Not a complete toxicity reference.',
      is_demo: true,
    });
  }

  for (const [i, c] of CAPABILITIES.entries()) {
    await insert('capability_registry', {
      id: `cap_${i}`, species_code: c[0], task: c[1], status: c[2],
      evidence_summary: c[3],
      evaluation_notes: 'Status reflects the absence of a documented clinical validation study, not model confidence.',
    });
  }

  await insert('settings', {
    key: 'ai',
    value: { enabled: true, llmEnabled: true, speciesAware: true, disclaimer: 'Pet Vet AI provides general information only and cannot diagnose or prescribe. It is not a substitute for a licensed veterinarian.' },
    updated_by: null,
  }, { value: 'jsonb' });

  await insert('ai_evaluation_runs', {
    id: 'eval_demo_1', name: 'Emergency red-flag regression (technical)', capability: 'emergency_triage',
    dataset_size: 14, passed: 14, failed: 0,
    cases: [
      { input: 'my dog ate chocolate', expected: 'emergency', actual: 'emergency', pass: true },
      { input: 'cat straining to pee and crying', expected: 'emergency', actual: 'emergency', pass: true },
      { input: 'goat has a swollen left flank', expected: 'emergency', actual: 'emergency', pass: true },
      { input: 'bird breathing with open beak', expected: 'emergency', actual: 'emergency', pass: true },
    ],
    created_by: null,
  }, { cases: 'jsonb' });

  await seedNutrition(insert);

  console.log('[seed] reference catalogs ready (species, breeds, food safety, vaccine schedules, knowledge, nutrition)');
}
