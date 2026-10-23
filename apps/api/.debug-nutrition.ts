process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/debug-pg';
process.env.SEED_DEMO = 'true';
import fs from 'node:fs';
fs.rmSync('.data/debug-pg', { recursive: true, force: true });
const { migrate } = await import('./src/migrate.js');
const { seed } = await import('./src/seed.js');
await migrate();
await seed();
const { nutritionProfileForPet } = await import('./src/services/nutrition.js');
try {
  const profile = await nutritionProfileForPet('pet_bruno', { id: 'usr_owner', email: 'a@b.c', fullName: 'o', role: 'owner' } as any);
  console.log('OK guidance:', profile.guidance.length, 'hazards:', profile.hazards.length, 'recipes:', profile.recipes.length);
} catch (e) {
  console.error('PROFILE ERROR:', e);
}
const { validateWorkbook } = await import('./src/services/nutrition-import.js');
const errs = validateWorkbook({
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
  Foods_to_Avoid: [['species', 'food_or_substance', 'classification', 'risk', 'recommended_action', 'review_status']],
  Recipe_Guides: [['species', 'recipe_name', 'diet_role', 'applicability', 'ingredients', 'step_by_step', 'safety_notes', 'review_status']],
  Breed_LifeStage: [['species', 'breed_or_type', 'life_stage', 'general_guidance', 'limitation', 'referral_rule', 'review_status']],
  Health_Conditions: [['condition_or_goal', 'general_guidance', 'safety_rule', 'referral_rule']],
});
console.log('VALIDATION ERRORS:', JSON.stringify(errs, null, 2));
const { closeDb } = await import('./src/db.js');
await closeDb();
