import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Tests always run on the embedded engine, never the developer's .env database.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-nutrition';
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';
process.env.UPLOAD_DIR = '.data/test-uploads-nutrition';

fs.rmSync(path.join(root, '.data/test-pg-nutrition'), { recursive: true, force: true });
fs.rmSync(path.join(root, '.data/test-uploads-nutrition'), { recursive: true, force: true });

let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};

async function call(
  route: string,
  options: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  const { migrate } = await import('../src/migrate.js');
  const { seed } = await import('../src/seed.js');
  const { seedTestFixtures } = await import('./fixtures.js');
  const { createApp } = await import('../src/app.js');
  await migrate();
  await seed();
  await seedTestFixtures();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;

  for (const [role, email] of [
    ['owner', 'priya@petvetai.demo'],
    ['admin', 'admin@petvetai.demo'],
    ['vet', 'dr.arjun@petvetai.demo'],
  ] as const) {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email, password: 'Demo@1234' },
    });
    assert.equal(res.status, 200, `login ${role}`);
    tokens[role] = res.data.token;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

// ── Requirement 3/13: unreviewed records are never served ─────

test('pending nutrition records stay hidden until an administrator approves them', async () => {
  const res = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.equal(res.status, 200);

  const guidanceKeys = res.data.guidance.map((g: any) => g.recordKey);
  assert.ok(
    !guidanceKeys.includes('DEMO-PENDING-001'),
    'the seeded pending record must never appear in owner guidance',
  );
  assert.ok(
    guidanceKeys.includes('DEMO-demo_dog_adult_maintenance'),
    'approved guidance is served',
  );
  assert.match(res.data.knowledge.note, /approved by an administrator/i);

  // The admin queue can see it.
  const queue = await call('/admin/nutrition/queue', { token: tokens.admin });
  assert.equal(queue.status, 200);
  const guidanceQueue = queue.data.queue.find((q: any) => q.kind === 'guidance');
  assert.ok(guidanceQueue.pending >= 1, 'pending record is in the review queue');

  // Owners and vets cannot reach the review API at all.
  const denied = await call('/admin/nutrition/guidance', { token: tokens.owner });
  assert.equal(denied.status, 403);
  const deniedVet = await call('/admin/nutrition/queue', { token: tokens.vet });
  assert.equal(deniedVet.status, 403);
});

// ── Requirement 5: species / life-stage filtering ─────────────

test('guidance is filtered by species and life stage of the selected pet', async () => {
  const dog = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  const dogGoals = dog.data.guidance.map((g: any) => `${g.speciesCode}:${g.nutritionGoal}`);
  assert.ok(dogGoals.every((k: string) => k.startsWith('dog:')), 'no cat records leak into a dog profile');
  assert.ok(!dogGoals.some((k: string) => k.includes('Cat')), 'cat guidance excluded');
  assert.equal(dog.data.pet.speciesCode, 'dog');
  assert.equal(dog.data.pet.lifeStage, 'adult', 'Bruno (born 2022) is an adult dog');

  const cat = await call('/pets/pet_luna/nutrition', { token: tokens.owner });
  const catGoals = cat.data.guidance.map((g: any) => g.speciesCode);
  assert.ok(catGoals.every((s: string) => s === 'cat'), 'no dog records leak into a cat profile');
  assert.ok(cat.data.guidance.some((g: any) => g.nutritionGoal === 'Healthy maintenance'));
});

test('hazards are species-scoped and prioritise veterinary advice', async () => {
  const dog = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  const chocolate = dog.data.hazards.find((h: any) => h.foodOrSubstance.includes('Chocolate'));
  assert.ok(chocolate, 'chocolate hazard present for dogs');
  assert.equal(chocolate.severity, 'toxic');
  assert.match(chocolate.recommendedAction, /veterinarian promptly/i);
  // Requirement 12: urgent advice is surfaced up-front.
  assert.ok(dog.data.emergencyNotice, 'emergency notice shown when toxic entries exist');
  assert.match(dog.data.emergencyNotice.body, /do not wait for symptoms/i);

  // Cat profile must not show dog-only xylitol entry.
  const cat = await call('/pets/pet_luna/nutrition', { token: tokens.owner });
  const xylitol = cat.data.hazards.find((h: any) => h.foodOrSubstance.includes('Xylitol'));
  assert.equal(xylitol, undefined, 'dog-only hazard not shown for cats');
  const dogfood = cat.data.hazards.find((h: any) => /dog food/i.test(h.foodOrSubstance));
  assert.ok(dogfood, 'cat-specific hazard present');

  // Hazard lookup endpoint mirrors the same behaviour (authenticated).
  const lookup = await call('/nutrition/hazards?species=dog&q=chocolate', { token: tokens.owner });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.matches[0].severity, 'toxic');
  const anonymous = await call('/nutrition/hazards?species=dog&q=chocolate');
  assert.equal(anonymous.status, 401, 'hazard lookup requires a signed-in user');
  const unknown = await call('/nutrition/hazards?species=dog&q=starfruit', { token: tokens.owner });
  assert.equal(unknown.data.matches.length, 0);
  assert.match(unknown.data.note, /does not mean safe/i, 'requirement 11: unknown is stated, not guessed');
});

// ── Requirement 5: allergies + health rules ───────────────────

test('known allergies flag conflicting guidance and recipes', async () => {
  // Bruno has no recorded allergies yet — no warnings.
  const before = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.ok(before.data.guidance.every((g: any) => g.allergenWarnings.length === 0));

  const updated = await call('/pets/pet_bruno', {
    method: 'PATCH',
    token: tokens.owner,
    body: { allergies: 'Chicken, dairy', conditions: 'Early kidney stage', dietaryRestrictions: 'Low phosphorus diet' },
  });
  assert.equal(updated.status, 200);

  const after = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  const chickenFlagged = after.data.guidance.filter((g: any) =>
    g.allergenWarnings.includes('chicken'));
  assert.ok(chickenFlagged.length > 0, 'suitable-foods text mentioning chicken is flagged');

  const recipesWithChicken = after.data.recipes.filter((r: any) => r.allergenWarnings.includes('chicken'));
  assert.ok(recipesWithChicken.length > 0, 'chicken recipe flagged for allergic pet');
  for (const r of recipesWithChicken) {
    assert.match(r.completeDietWarning ?? '', /not a complete and balanced diet/i);
  }

  // Health rules matched on recorded conditions.
  const kidney = after.data.healthRules.find((r: any) => r.conditionOrGoal === 'Kidney disease');
  assert.ok(kidney, 'kidney rule matched via keywords');
  assert.ok(kidney.matchedOn.includes('kidney'));
  assert.match(kidney.safetyRule, /without the treating veterinarian/i);

  // Missing information is reported rather than guessed around.
  const partial = await call('/pets/pet_kiwi/nutrition', { token: tokens.owner });
  assert.ok(partial.data.missingInfo.some((m: string) => /weight/i.test(m)), 'missing weight is disclosed');

  // Restore Bruno's profile so later tests see the seeded state.
  await call('/pets/pet_bruno', {
    method: 'PATCH', token: tokens.owner,
    body: { allergies: null, conditions: null, dietaryRestrictions: null },
  });
});

// ── Requirement 13: incomplete data blocks personalization ────

test('incomplete pet data yields disclosed gaps instead of invented advice', async () => {
  const created = await call('/pets', {
    method: 'POST',
    token: tokens.owner,
    body: { name: 'Ageless', speciesCode: 'dog', sex: 'unknown' },
  });
  assert.equal(created.status, 201);
  const petId = created.data.pet.id;

  const res = await call(`/pets/${petId}/nutrition`, { token: tokens.owner });
  assert.equal(res.status, 200);
  assert.equal(res.data.pet.lifeStage, 'unknown', 'no birth date → life stage unknown');
  assert.ok(
    res.data.missingInfo.some((m: string) => /age|birth/i.test(m)),
    'the missing age is disclosed instead of assuming adult',
  );
  // Only the species-wide 'all' stage rows may match an unknown stage.
  assert.ok(res.data.guidance.every((g: any) => g.lifeStage === 'all'));

  await call(`/pets/${petId}`, { method: 'DELETE', token: tokens.owner });
});

// ── Requirements 7/8/9: recipes ───────────────────────────────

test('recipes expose ingredients, steps, storage status and treat-vs-complete framing', async () => {
  const dog = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  const recipe = dog.data.recipes.find((r: any) => r.recipeName === 'Plain cooked chicken treat');
  assert.ok(recipe, 'recipe present');
  assert.ok(recipe.ingredients.length >= 2, 'ingredients listed');
  assert.ok(recipe.steps.length >= 3, 'preparation steps listed');
  assert.equal(recipe.isSupplementary, true, 'treat is supplementary');
  assert.equal(recipe.isCompleteDiet, false);
  assert.match(recipe.completeDietWarning, /not a complete and balanced diet/i);
  // Requirement 11: storage is unknown, and the response says so.
  assert.equal(recipe.storageKnown, false);
  assert.match(recipe.storageNote, /not specified|fresh each time/i);
  assert.match(recipe.applicability, /allergy|restriction|suitable/i, 'applicability spelled out');

  const cat = await call('/pets/pet_luna/nutrition', { token: tokens.owner });
  const egg = cat.data.recipes.find((r: any) => r.recipeName === 'Fully cooked egg treat');
  assert.match(egg.completeDietWarning, /taurine|complete/i, 'cat recipe warns about feline completeness');
});

// ── Requirement 10: livestock feed plans ──────────────────────

test('cows and goats require a formulated feed plan with no universal quantities', async () => {
  for (const [petId, species] of [['pet_gauri', 'cow'], ['pet_chhotu', 'goat']] as const) {
    const res = await call(`/pets/${petId}/nutrition`, { token: tokens.owner });
    assert.equal(res.status, 200);
    assert.ok(res.data.livestock, `${species} profile requires a feed plan`);
    assert.equal(res.data.livestock.feedPlanRequired, true);
    assert.match(res.data.livestock.planNote, /formulated feed plan/i);
    assert.match(res.data.livestock.planNote, /does not generate universal feed quantities/i);

    for (const r of res.data.recipes) {
      assert.equal(r.isCompleteDiet, false);
      // No numeric quantities anywhere in the recipe payload.
      const serialized = JSON.stringify(r);
      assert.ok(!/\b\d+\s?(g|kg|grams|kilograms|oz|ml|cups?)\b/i.test(serialized),
        `${species} recipe must not contain universal quantities`);
    }
    const template = res.data.recipes.find((r: any) => r.recipeName.includes('ration planning'));
    assert.ok(template, 'ration planning template present');
    assert.equal(template.isSupplementary, true);
  }
});

// ── Requirement 6: breed is context only ──────────────────────

test('breed guidance appears only with approved evidence and its limitation', async () => {
  const dog = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.equal(dog.data.breedContext.applied, true, 'approved Labrador evidence exists');
  assert.equal(dog.data.breedContext.basis, 'approved_breed_evidence');
  assert.match(dog.data.breedContext.guidance.limitation, /Breed alone cannot determine/i);
  assert.match(dog.data.breedContext.note, /context/i);

  // A breed with no approved row gets an explicit no-evidence statement.
  const unknownBreed = await call('/pets', {
    method: 'POST', token: tokens.owner,
    body: { name: 'Rare', speciesCode: 'dog', customBreed: 'Kombai', sex: 'male' },
  });
  const res = await call(`/pets/${unknownBreed.data.pet.id}/nutrition`, { token: tokens.owner });
  assert.equal(res.data.breedContext.applied, false);
  assert.equal(res.data.breedContext.basis, 'no_approved_evidence');
  assert.match(res.data.breedContext.note, /No reviewed breed-specific evidence/i);
  await call(`/pets/${unknownBreed.data.pet.id}`, { method: 'DELETE', token: tokens.owner });
});

// ── Requirement 4: review, edit, approve, reject, version ─────

test('administrators can review, edit, version and reject records end to end', async () => {
  const pending = await call('/admin/nutrition/guidance?status=pending', { token: tokens.admin });
  assert.equal(pending.status, 200);
  const record = pending.data.records.find((r: any) => r.record_key === 'DEMO-PENDING-001');
  assert.ok(record, 'pending record listed for review');

  // Edit first (stays pending; records a version).
  const edited = await call(`/admin/nutrition/guidance/${record.id}`, {
    method: 'PATCH', token: tokens.admin,
    body: { generalDietGuidance: 'Reviewed candidate text for senior joint support demonstrations.' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.reviewStatus, 'pending');

  let versions = await call(`/admin/nutrition/guidance/${record.id}/versions`, { token: tokens.admin });
  assert.ok(versions.data.versions.some((v: any) => v.action === 'edited'));
  assert.ok(versions.data.versions.some((v: any) => v.action === 'imported'));

  // Approve → becomes visible to owners AND mirrors into the RAG index.
  const approved = await call(`/admin/nutrition/guidance/${record.id}/review`, {
    method: 'POST', token: tokens.admin,
    body: { status: 'approved', notes: 'Approved for the technical test fixture.' },
  });
  assert.equal(approved.status, 200);

  const approvedList = await call('/admin/nutrition/guidance?status=approved', { token: tokens.admin });
  assert.ok(approvedList.data.records.some((r: any) => r.record_key === 'DEMO-PENDING-001'));

  const knowledge = await call('/admin/knowledge', { token: tokens.admin });
  assert.ok(
    knowledge.data.documents.some((d: any) => d.id === `nut_guidance_${record.id}`),
    'approved record mirrored into the RAG knowledge index',
  );

  versions = await call(`/admin/nutrition/guidance/${record.id}/versions`, { token: tokens.admin });
  assert.ok(versions.data.versions.some((v: any) => v.action === 'approved'));

  // Editing an approved record re-queues it (owners never see unreviewed edits).
  const edit2 = await call(`/admin/nutrition/guidance/${record.id}`, {
    method: 'PATCH', token: tokens.admin,
    body: { goalSpecificGuidance: 'Edited after approval — must re-enter the queue.' },
  });
  assert.equal(edit2.data.reviewStatus, 'pending');

  // RAG mirror is removed while pending again.
  const knowledge2 = await call('/admin/knowledge', { token: tokens.admin });
  assert.ok(!knowledge2.data.documents.some((d: any) => d.id === `nut_guidance_${record.id}`),
    'pending record is not retrievable by the AI');

  // Reject with notes.
  const rejected = await call(`/admin/nutrition/guidance/${record.id}/review`, {
    method: 'POST', token: tokens.admin,
    body: { status: 'rejected', notes: 'Insufficient source evidence for approval.' },
  });
  assert.equal(rejected.data.reviewStatus, 'rejected');
  versions = await call(`/admin/nutrition/guidance/${record.id}/versions`, { token: tokens.admin });
  assert.ok(versions.data.versions.some((v: any) => v.action === 'rejected' && v.notes?.includes('source evidence')));

  // Re-reviewing the same status is refused.
  const again = await call(`/admin/nutrition/guidance/${record.id}/review`, {
    method: 'POST', token: tokens.admin, body: { status: 'rejected' },
  });
  assert.equal(again.status, 400);

  // The full dog profile never contained this record while it was pending.
  const dog = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.ok(!dog.data.guidance.some((g: any) => g.recordKey === 'DEMO-PENDING-001'));
});

test('recipe completeness cannot be flipped on through the admin API', async () => {
  const recipes = await call('/admin/nutrition/recipe?status=approved', { token: tokens.admin });
  const recipe = recipes.data.records[0];
  // The editable schema has no isCompleteDiet / nutritionalAdequacy field —
  // attempt to smuggle one in anyway.
  const smuggle = await call(`/admin/nutrition/recipe/${recipe.id}`, {
    method: 'PATCH', token: tokens.admin,
    body: { isCompleteDiet: true, nutritionalAdequacy: 'validated', safetyNotes: 'edited safety notes (test).' },
  });
  assert.equal(smuggle.status, 200, 'allowed fields still editable');

  const refreshed = await call('/admin/nutrition/recipe?status=pending', { token: tokens.admin });
  const target = refreshed.data.records.find((r: any) => r.id === recipe.id)
    ?? (await call('/admin/nutrition/recipe?status=approved', { token: tokens.admin }))
      .data.records.find((r: any) => r.id === recipe.id);
  assert.equal(target.is_complete_diet, false, 'completeness flag untouched by API smuggling');
  assert.equal(target.nutritional_adequacy, 'not_evaluated', 'adequacy flag untouched');
});

// ── Requirement 1/15: workbook import validation ──────────────

test('workbook import validates columns and records before writing anything', async () => {
  const { validateWorkbook, importWorkbook } = await import('../src/services/nutrition-import.js');

  // Structural: a missing required column is an error.
  const missingCol = validateWorkbook({
    Sources: [['source_name', 'url'], ['Example', 'https://example.org']],
    Master_1200_Rows: [['record_id', 'species'], ['PVF-00001', 'Dog']],
    Foods_to_Avoid: [['species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status']],
    Recipe_Guides: [['species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step', 'safety_notes', 'review_status']],
    Breed_LifeStage: [['species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule', 'review_status']],
    Health_Conditions: [['condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule']],
  });
  assert.ok(missingCol.some((e) => e.includes('missing required columns')));

  // Row validation: bad species, completeness claim, missing limitation.
  const badRows = validateWorkbook({
    Sources: [['source_name', 'url', 'usage_notes'], ['Ref', 'https://example.org', 'notes']],
    Master_1200_Rows: [[
      'record_id', 'species', 'breed_or_type', 'life_stage', 'nutrition_goal',
      'general_diet_guidance', 'potential_suitable_foods', 'foods_or_hazards_to_avoid',
      'recipe_or_preparation_guidance', 'goal_specific_guidance', 'safety_cautions',
      'individualization_factors', 'disclaimer', 'source_requirement', 'review_status', 'data_quality_note',
    ], [
      'PVF-99999', 'Dragon', '', 'Adult', 'Goal', 'Guidance text', 'Foods', 'Hazards',
      'Recipe', 'Goal specific', 'Cautions', 'Factors', 'Disclaimer', 'Source', 'PENDING_VETERINARY_REVIEW', 'note',
    ]],
    Foods_to_Avoid: [['species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status'],
      ['Dog', 'Chocolate', 'Toxic risk', 'Heart and nervous system.', 'Contact a vet.', 'PENDING_VETERINARY_REVIEW']],
    Recipe_Guides: [['species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step', 'safety_notes', 'review_status'],
      ['Dog', 'Magic complete food', 'Complete and balanced diet', 'All dogs', 'Water', '1. Mix.', 'Feeds as sole diet.', 'PENDING_VETERINARY_REVIEW']],
    Breed_LifeStage: [['species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule', 'review_status'],
      ['Dog', 'Beagle', 'Adult', 'Guidance without limitation', '', 'Refer.', 'PENDING_VETERINARY_REVIEW']],
    Health_Conditions: [['condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule'],
      ['Obesity', 'Individualized calorie plan.', 'No crash dieting.', 'Veterinarian.']],
  });
  assert.ok(badRows.some((e) => e.includes('must map to exactly one species')),
    'unknown species rejected');
  assert.ok(badRows.some((e) => e.includes('claims completeness without validated nutritional adequacy')),
    'requirement 9: completeness claim rejected at import');
  assert.ok(badRows.some((e) => e.includes('no limitation text')),
    'requirement 6: breed advice without limitation rejected');

  // A structurally valid workbook dry-runs cleanly and writes nothing.
  const good = {
    Sources: [['source_name', 'url', 'usage_notes'], ['Validated Ref', 'https://example.org/ref', 'Used for tests']],
    Master_1200_Rows: [[
      'record_id', 'species', 'breed_or_type', 'life_stage', 'nutrition_goal',
      'general_diet_guidance', 'potential_suitable_foods', 'foods_or_hazards_to_avoid',
      'recipe_or_preparation_guidance', 'goal_specific_guidance', 'safety_cautions',
      'individualization_factors', 'disclaimer', 'source_requirement', 'review_status', 'data_quality_note',
    ], [
      'PVF-00777', 'Dog', 'Beagle', 'Adult', 'Healthy maintenance',
      'Choose a complete and balanced adult diet.', 'Plain cooked chicken as treat only.',
      'Avoid chocolate.', 'Treats stay supplementary.', 'Monitor weight.',
      'Veterinary plan for disease.', 'Breed is context only.', 'Educational only.',
      'Validated Ref', 'PENDING_VETERINARY_REVIEW', 'generated',
    ]],
    Foods_to_Avoid: [['species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status'],
      ['Dog/Cat', 'Onion family', 'Avoid/toxic risk', 'Damages red blood cells.', 'Contact a vet.', 'PENDING_VETERINARY_REVIEW']],
    Recipe_Guides: [['species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step', 'safety_notes', 'review_status'],
      ['Dog', 'Plain carrot sticks', 'Treat only; not complete', 'Healthy dogs', 'Carrot', '1. Wash. 2. Cut. 3. Offer small piece.', 'Not a complete diet.', 'PENDING_VETERINARY_REVIEW']],
    Breed_LifeStage: [['species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule', 'review_status'],
      ['Dog', 'Beagle', 'Adult', 'Portion control matters.', 'Breed alone cannot determine portions.', 'Refer for disease.', 'PENDING_VETERINARY_REVIEW']],
    Health_Conditions: [['condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule'],
      ['Obesity', 'Individualized calorie plan.', 'No crash dieting.', 'Veterinarian.']],
  };

  const dry = await importWorkbook(good, { dryRun: true });
  assert.equal(dry.errors.length, 0, JSON.stringify(dry.errors));
  assert.equal(dry.dryRun, true);
  assert.ok(dry.imported.guidance >= 1 && dry.imported.hazard >= 1 && dry.imported.recipe >= 1);
  assert.ok(dry.imported.breed >= 1 && dry.imported.health_rule >= 1 && dry.imported.source >= 1);

  // Dry run must not have written: real import still inserts.
  const wet = await importWorkbook(good);
  assert.equal(wet.errors.length, 0);
  assert.ok(wet.imported.guidance >= 1);

  // Records land PENDING, preserving species + review status mapping.
  const list = await call('/admin/nutrition/guidance?status=pending', { token: tokens.admin });
  const row = list.data.records.find((r: any) => r.record_key === 'PVF-00777');
  assert.ok(row, 'imported record in pending queue');
  assert.equal(row.review_status, 'pending');
  assert.equal(row.species_code, 'dog');
  assert.equal(row.life_stage, 'adult');

  const hazards = await call('/admin/nutrition/hazard?status=pending', { token: tokens.admin });
  const onion = hazards.data.records.find((h: any) => h.food_or_substance === 'Onion family');
  assert.ok(onion, 'multi-species hazard row imported');
  assert.deepEqual(onion.species_codes, ['dog', 'cat'], 'Dog/Cat mapped to both species codes');
  assert.equal(onion.severity, 'potentially_toxic');

  const sources = await call('/admin/nutrition/source?status=pending', { token: tokens.admin });
  const src = sources.data.records.find((s: any) => s.source_name === 'Validated Ref');
  assert.ok(src, 'source with URL imported');
  assert.equal(src.url, 'https://example.org/ref', 'URL preserved verbatim');

  // Re-import is idempotent (upsert on conflict, still pending).
  const again = await importWorkbook(good);
  assert.equal(again.errors.length, 0);
  const total = await call('/admin/nutrition/guidance?status=pending&limit=200', { token: tokens.admin });
  const matches = total.data.records.filter((r: any) => r.record_key === 'PVF-00777');
  assert.equal(matches.length, 1, 're-import does not duplicate records');
});

test('an import cannot overwrite an administrator-approved record', async () => {
  const { importWorkbook } = await import('../src/services/nutrition-import.js');
  const { getDb, one } = await import('../src/db.js');

  // Approve the imported test record first.
  const list = await call('/admin/nutrition/guidance?status=pending&limit=200', { token: tokens.admin });
  const row = list.data.records.find((r: any) => r.record_key === 'PVF-00777');
  assert.ok(row);
  const approved = await call(`/admin/nutrition/guidance/${row.id}/review`, {
    method: 'POST', token: tokens.admin, body: { status: 'approved', notes: 'fixture approval' },
  });
  assert.equal(approved.status, 200);

  // Attempt to re-import with different content.
  const { stageWorkbook } = await import('../src/services/nutrition-import.js');
  const tampered = {
    Sources: [['source_name', 'url', 'usage_notes'], ['Validated Ref', 'https://example.org/ref', 'notes']],
    Master_1200_Rows: [[
      'record_id', 'species', 'breed_or_type', 'life_stage', 'nutrition_goal',
      'general_diet_guidance', 'potential_suitable_foods', 'foods_or_hazards_to_avoid',
      'recipe_or_preparation_guidance', 'goal_specific_guidance', 'safety_cautions',
      'individualization_factors', 'disclaimer', 'source_requirement', 'review_status', 'data_quality_note',
    ], [
      'PVF-00777', 'Dog', 'Beagle', 'Adult', 'TAMPERED GOAL',
      'TAMPERED GUIDANCE — this content must never replace an approved record.',
      'Foods', 'Hazards', 'Recipe', 'Goal', 'Cautions', 'Factors', 'Disclaimer',
      'Validated Ref', 'PENDING_VETERINARY_REVIEW', 'note',
    ]],
    Foods_to_Avoid: [['species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status'],
      ['Dog', 'Temp hazard row', 'Caution', 'risk', 'action', 'PENDING_VETERINARY_REVIEW']],
    Recipe_Guides: [['species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step', 'safety_notes', 'review_status'],
      ['Dog', 'Temp recipe', 'Treat only', 'ok', 'x', '1. y.', 'z', 'PENDING_VETERINARY_REVIEW']],
    Breed_LifeStage: [['species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule', 'review_status'],
      ['Dog', 'Temp breed', 'Adult', 'guidance', 'limitation text', 'referral', 'PENDING_VETERINARY_REVIEW']],
    Health_Conditions: [['condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule'],
      ['Temp condition', 'guidance', 'safety', 'referral']],
  };
  const report = await importWorkbook(tampered);
  assert.equal(report.errors.length, 0);
  assert.ok(report.skipped.guidance >= 1, 'approved guidance row skipped by the import');

  const db = await getDb();
  const current = await one<{ nutrition_goal: string }>(
    'SELECT nutrition_goal FROM nutrition_guidance WHERE record_key = $1', ['PVF-00777'],
  );
  assert.equal(current?.nutrition_goal, 'Healthy maintenance', 'approved record unchanged by re-import');

  // Cleanup: reject it so other tests keep a clean queue.
  await call(`/admin/nutrition/guidance/${row.id}/review`, {
    method: 'POST', token: tokens.admin, body: { status: 'rejected', notes: 'cleanup' },
  });
  await db.query('DELETE FROM nutrition_hazards WHERE food_or_substance = $1', ['Temp hazard row']);
  await db.query('DELETE FROM nutrition_recipes WHERE recipe_name = $1', ['Temp recipe']);
  await db.query('DELETE FROM nutrition_breed_guidance WHERE breed_or_type = $1', ['Temp breed']);
  await db.query('DELETE FROM nutrition_health_rules WHERE condition_or_goal = $1', ['Temp condition']);
});

// ── Requirement 14: RAG, not fine-tuning ──────────────────────

test('approved nutrition records are retrievable as RAG citations in AI chat', async () => {
  const res = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_bruno', message: 'Is chocolate safe for Bruno to eat?' },
  });
  assert.equal(res.status, 201);
  // The emergency rule fires first (safety priority), and the approved
  // nutrition hazard must be retrievable as a supporting citation.
  assert.ok(res.data.reply.emergency, 'chocolate triggers the emergency rule');
  const citations = res.data.reply.citations as any[];
  assert.ok(
    citations.length > 0,
    'approved nutrition knowledge is cited through retrieval (RAG), not fine-tuned weights',
  );
});

// ── Nutrition-aware retrieval (structured filters lexical search can't do) ──

test('nutrition retrieval filters by species and surfaces condition rules, not just token overlap', async () => {
  const { retrieveNutritionForChat } = await import('../src/services/nutrition-rag.js');

  // A bird-only hazard must never be returned for a dog, even if the word
  // "avocado" appears — this is the structured species filter lexical search
  // over mirrored chunks cannot enforce.
  const dog = await retrieveNutritionForChat(
    { speciesCode: 'dog', ageEstimateMonths: 48 },
    'can my dog eat avocado',
    5,
  );
  assert.ok(
    !dog.some((s) => s.title.toLowerCase().includes('avocado')),
    'bird-only avocado hazard is not returned for a dog',
  );

  // Species-scoped hazards for the right species are returned.
  const cat = await retrieveNutritionForChat(
    { speciesCode: 'cat', ageEstimateMonths: 48 },
    'is chocolate dangerous for my cat',
    5,
  );
  assert.ok(
    cat.some((s) => s.title.toLowerCase().includes('chocolate')),
    'approved cat/dog chocolate hazard is returned for a cat',
  );
  assert.ok(
    !cat.some((s) => s.title.toLowerCase().includes('xylitol')),
    'dog-only xylitol hazard is not returned for a cat',
  );

  // A recorded condition pulls its health rule with a boosted score even when
  // the question text never mentions the condition.
  const kidney = await retrieveNutritionForChat(
    { speciesCode: 'dog', ageEstimateMonths: 48, conditions: 'Kidney disease' },
    'what treats can I give my dog',
    5,
  );
  const rule = kidney.find((s) => s.documentId.startsWith('nut_health_rule_'));
  assert.ok(rule, 'a recorded condition surfaces its approved health rule');
  assert.ok(rule!.snippet.toLowerCase().includes('kidney'));
  assert.ok(
    rule!.score >= kidney.find((s) => s.category === 'nutrition' && !s.documentId.startsWith('nut_health_rule_'))!.score,
    'a condition rule outranks a coincidental lexical match',
  );

  // Unknown age falls back to all-life-stage guidance rather than guessing a stage.
  const noAge = await retrieveNutritionForChat(
    { speciesCode: 'dog', ageEstimateMonths: null },
    'healthy adult dog maintenance diet',
    5,
  );
  assert.ok(
    !noAge.some((s) => s.title.includes('senior')),
    'unknown age never returns life-stage-specific guidance',
  );
});

// ── Bulk review (scale gap: thousands of pending workbook rows) ─────────

test('bulk review approves many pending records at once and never re-decides reviewed ones', async () => {
  const { getDb } = await import('../src/db.js');
  const db = await getDb();

  // Stage three pending hazard records directly (import validation is covered
  // by its own test; here we only exercise the bulk endpoint's semantics).
  const staged: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `nh_test_bulk_${i}`;
    staged.push(id);
    await db.query(
      `INSERT INTO nutrition_hazards
         (id, species_codes, food_or_substance, classification, severity, risk,
          recommended_action, review_status, is_demo, version)
       VALUES ($1, '{dog}', $2, 'Test classification', 'caution', 'Test risk.',
               'Test action.', 'pending', true, 1)`,
      [id, `Bulk test food ${i}`],
    );
  }
  // One is already reviewed — bulk must skip it, never silently re-decide it.
  await db.query(
    `UPDATE nutrition_hazards SET review_status = 'rejected' WHERE id = $1`,
    [staged[2]],
  );

  // Owners must not see the staged pending rows before the bulk action.
  const before = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.ok(!before.data.hazards.some((h: any) => staged.includes(h.id)));

  const res = await call('/admin/nutrition/hazard/bulk-review', {
    method: 'POST', token: tokens.admin,
    body: { status: 'approved', ids: staged, notes: 'Bulk approval fixture.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.matched, 3);
  assert.equal(res.data.updated, 2, 'only pending records are changed');
  assert.equal(
    res.data.skippedAlreadyReviewed, 1,
    'an already-reviewed record is reported as skipped, not re-decided',
  );

  // Both pending records became approved and visible to the owner.
  const approved = await call('/admin/nutrition/hazard?status=approved&species=dog', {
    token: tokens.admin,
  });
  assert.ok(approved.data.records.some((r: any) => r.id === staged[0]));
  assert.ok(approved.data.records.some((r: any) => r.id === staged[1]));
  assert.ok(!approved.data.records.some((r: any) => r.id === staged[2]));

  // The pre-reviewed record kept its rejected status.
  const rejected = await call('/admin/nutrition/hazard?status=rejected', { token: tokens.admin });
  assert.ok(rejected.data.records.some((r: any) => r.id === staged[2]));

  // Each newly approved record got a version entry and reached the owner.
  for (const id of [staged[0], staged[1]]) {
    const versions = await call(`/admin/nutrition/hazard/${id}/versions`, { token: tokens.admin });
    assert.ok(
      versions.data.versions.some((v: any) => v.action === 'approved'),
      'bulk approval is versioned like a single review',
    );
  }
  const after = await call('/pets/pet_bruno/nutrition', { token: tokens.owner });
  assert.ok(after.data.hazards.some((h: any) => h.id === staged[0]));

  // The species filter on the list endpoint scopes correctly.
  const catOnly = await call('/admin/nutrition/hazard?status=approved&species=cat', {
    token: tokens.admin,
  });
  assert.ok(!catOnly.data.records.some((r: any) => r.id === staged[0]),
    'species filter excludes dog records from a cat query');

  // Owners and vets cannot bulk-review.
  const deniedOwner = await call('/admin/nutrition/hazard/bulk-review', {
    method: 'POST', token: tokens.owner, body: { status: 'approved', ids: [staged[0]] },
  });
  assert.equal(deniedOwner.status, 403);

  // Cleanup so the rest of the suite (and future runs) are not polluted.
  for (const id of staged) {
    await db.query('DELETE FROM nutrition_record_versions WHERE record_id = $1', [id]);
    await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [`nut_hazard_${id}`]);
    await db.query('DELETE FROM knowledge_documents WHERE id = $1', [`nut_hazard_${id}`]);
    await db.query('DELETE FROM nutrition_hazards WHERE id = $1', [id]);
  }
});

test('bulk review with allPending only ever touches pending rows', async () => {
  const { getDb } = await import('../src/db.js');
  const db = await getDb();

  // allPending scoped to a species with no pending rows reports zero and
  // changes nothing (bird has no staged pending rows in this suite).
  const noop = await call('/admin/nutrition/hazard/bulk-review', {
    method: 'POST', token: tokens.admin,
    body: { status: 'approved', allPending: true, species: 'bird' },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.data.updated, 0);

  // A request with neither ids nor allPending is a 400, not a silent no-op.
  const bad = await call('/admin/nutrition/hazard/bulk-review', {
    method: 'POST', token: tokens.admin, body: { status: 'approved' },
  });
  assert.equal(bad.status, 400);

  // allPending on a real pending row approves exactly that row and versions it.
  const id = 'nh_test_allpending';
  await db.query(
    `INSERT INTO nutrition_hazards
       (id, species_codes, food_or_substance, classification, severity, risk,
        recommended_action, review_status, is_demo, version)
     VALUES ($1, '{bird}', 'Bulk all-pending probe', 'Test', 'caution', 'Risk.',
             'Action.', 'pending', true, 1)`,
    [id],
  );
  const res = await call('/admin/nutrition/hazard/bulk-review', {
    method: 'POST', token: tokens.admin,
    body: { status: 'approved', allPending: true, species: 'bird' },
  });
  assert.equal(res.data.updated, 1);
  const versions = await call(`/admin/nutrition/hazard/${id}/versions`, { token: tokens.admin });
  assert.ok(versions.data.versions.some((v: any) => v.action === 'approved'));

  await db.query('DELETE FROM nutrition_record_versions WHERE record_id = $1', [id]);
  await db.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [`nut_hazard_${id}`]);
  await db.query('DELETE FROM knowledge_documents WHERE id = $1', [`nut_hazard_${id}`]);
  await db.query('DELETE FROM nutrition_hazards WHERE id = $1', [id]);
});
