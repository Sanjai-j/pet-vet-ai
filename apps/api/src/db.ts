import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { config } from './config.js';

type Row = Record<string, unknown>;

export interface Database {
  kind: 'pglite' | 'postgres';
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

let database: Database | null = null;
let adminSocket: PGLiteSocketServer | null = null;

class PgliteDatabase implements Database {
  kind = 'pglite' as const;
  constructor(private client: PGlite) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query<T>(sql, params as any[]);
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDatabase implements Database {
  kind = 'postgres' as const;
  constructor(private pool: pg.Pool) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as any[]);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function getDb(): Promise<Database> {
  if (database) return database;

  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query('SELECT 1');
    database = new PostgresDatabase(pool);
    console.log(`[db] connected to PostgreSQL (${config.databaseUrl.replace(/\/\/[^@]*@/, '//***@')})`);
  } else {
    fs.mkdirSync(config.pgliteDir, { recursive: true });
    const client = new PGlite(config.pgliteDir);
    await client.waitReady;
    database = new PgliteDatabase(client);
    console.log(`[db] using embedded PostgreSQL engine at ${config.pgliteDir}`);
    if (config.pgliteAdminSocket.enabled) {
      try {
        adminSocket = new PGLiteSocketServer({
          db: client,
          host: config.pgliteAdminSocket.host,
          port: config.pgliteAdminSocket.port,
        });
        await adminSocket.start();
        console.log(
          `[db] pgAdmin/DBeaver connection: host=${config.pgliteAdminSocket.host} port=${config.pgliteAdminSocket.port} db=postgres user=postgres (no password)`,
        );
      } catch (err) {
        console.warn(`[db] could not start admin socket (port in use?): ${(err as Error).message}`);
      }
    }
  }
  return database;
}

export async function closeDb(): Promise<void> {
  if (adminSocket) {
    await adminSocket.stop().catch(() => {});
    adminSocket = null;
  }
  if (database) {
    await database.close();
    database = null;
  }
}

export async function one<T = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await (await getDb()).query<T>(sql, params);
  return rows[0] ?? null;
}

export async function many<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getDb()).query<T>(sql, params);
}

export async function run(sql: string, params: unknown[] = []): Promise<void> {
  await (await getDb()).query(sql, params);
}

export function id(): string {
  return crypto.randomUUID();
}
