import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-catalog';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

fs.rmSync(path.join(root, '.data/test-pg-catalog'), { recursive: true, force: true });

let query: (sql: string, params?: unknown[]) => Promise<any[]>;

before(async () => {
  const { migrate } = await import('../src/migrate.js');
  const { seed } = await import('../src/seed.js');
  const { getDb } = await import('../src/db.js');
  await migrate();
  await seed();
  const db = await getDb();
  query = (sql, params) => db.query(sql, params);
});

after(async () => {
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

/** The delivered requirement: a fresh deployment has no demo doctors or patients. */
test('the seed creates reference catalogs, never demo people, pets or clinics', async () => {
  const users = await query('SELECT count(*)::int AS n FROM users');
  assert.equal(users[0].n, 0, 'no accounts are seeded');

  const pets = await query('SELECT count(*)::int AS n FROM pets');
  assert.equal(pets[0].n, 0, 'no patient records are seeded');

  const clinics = await query('SELECT count(*)::int AS n FROM clinics');
  assert.equal(clinics[0].n, 0, 'no demo hospitals are seeded');

  const vets = await query('SELECT count(*)::int AS n FROM vet_profiles');
  assert.equal(vets[0].n, 0, 'no demo veterinarians are seeded');

  const appointments = await query('SELECT count(*)::int AS n FROM appointments');
  assert.equal(appointments[0].n, 0, 'no demo appointments are seeded');
});

test('the reference catalogs the features read from are present', async () => {
  const species = await query('SELECT count(*)::int AS n FROM species');
  assert.equal(species[0].n, 6);

  const breeds = await query('SELECT count(*)::int AS n FROM breeds');
  assert.ok(breeds[0].n > 20, 'breed catalog loaded');

  const foods = await query('SELECT count(*)::int AS n FROM food_items');
  assert.ok(foods[0].n > 0, 'food-safety catalog loaded');

  const schedules = await query("SELECT count(*)::int AS n FROM vaccine_schedules WHERE status = 'approved'");
  assert.ok(schedules[0].n > 0, 'approved vaccine schedules loaded');

  const knowledge = await query("SELECT count(*)::int AS n FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.document_id WHERE d.status = 'approved'");
  assert.ok(knowledge[0].n > 0, 'approved knowledge is chunked for retrieval');

  const nutrition = await query("SELECT count(*)::int AS n FROM nutrition_guidance WHERE review_status = 'approved'");
  assert.ok(nutrition[0].n > 0, 'approved nutrition guidance loaded');
});

test('a second seed run leaves the catalogs untouched', async () => {
  const { seed } = await import('../src/seed.js');
  const before = await query('SELECT count(*)::int AS n FROM species');
  await seed();
  const after = await query('SELECT count(*)::int AS n FROM species');
  assert.equal(after[0].n, before[0].n);
});
