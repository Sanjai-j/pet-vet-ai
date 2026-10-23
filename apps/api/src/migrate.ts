import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';

export async function migrate(): Promise<string[]> {
  const db = await getDb();
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
