import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { connectDatabase, getDb, type Database } from './db.js';

async function applyMigrations(db: Database): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(config.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    ran.push(file);
  }
  if (!ran.length) console.log('[migrate] database is up to date');
  return ran;
}

export async function migrate(): Promise<string[]> {
  // Neon's pooled endpoint (PgBouncer, transaction mode) does not keep session
  // state, so schema changes go over the direct connection when one is given.
  const directUrl = config.databaseUrlUnpooled;
  // Only a PostgreSQL deployment has a second URL; the embedded PGlite engine
  // (used by the test suite) has nothing to switch to.
  if (config.databaseUrl && directUrl && directUrl !== config.databaseUrl) {
    const db = await connectDatabase(directUrl);
    try {
      return await applyMigrations(db);
    } finally {
      await db.close();
    }
  }
  return applyMigrations(await getDb());
}
