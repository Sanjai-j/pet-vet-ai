import { migrate } from './migrate.js';
import { closeDb } from './db.js';

try {
  await migrate();
} catch (err) {
  console.error('[migrate] failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
