import { migrate } from './migrate.js';
import { closeDb } from './db.js';
import { seed } from './seed.js';

const reset = process.argv.includes('--reset');

try {
  await migrate();
  await seed({ reset });
} catch (err) {
  console.error('[seed] failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
