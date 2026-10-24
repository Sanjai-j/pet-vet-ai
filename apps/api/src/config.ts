import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');

for (const file of ['.env.local', '.env']) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) dotenv.config({ path: full, override: false });
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** True when a connection string asks for TLS (Neon's include sslmode=require). */
function requiresTls(url: string | undefined): boolean {
  if (!url) return false;
  if (/[?&]sslmode=(require|verify-ca|verify-full)\b/i.test(url)) return true;
  try {
    return /(^|\.)neon\.tech$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4000,
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:4200',
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me-please-32-bytes-minimum',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  databaseUrl: process.env.DATABASE_URL ?? '',
  // Neon hands out a direct (unpooled) URL next to the pooled one. Migrations
  // use the direct connection: the pooler is transaction-scoped and does not
  // carry session state between statements. Falls back to DATABASE_URL.
  databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED ?? '',
  // Neon and Supabase require TLS; a self-hosted Postgres may not support it.
  // TLS is on in production, and also whenever the connection string asks for
  // it (Neon's carry sslmode=require), so local runs against Neon work too.
  databaseSsl: bool(
    process.env.DATABASE_SSL,
    process.env.NODE_ENV === 'production' ||
      requiresTls(process.env.DATABASE_URL) ||
      requiresTls(process.env.DATABASE_URL_UNPOOLED),
  ),
  pgliteDir: path.resolve(ROOT, process.env.PGLITE_DIR ?? '.data/pg'),
  // When using the embedded PGlite engine, expose it over the PostgreSQL
  // wire protocol so desktop tools (pgAdmin 4, DBeaver, psql) can connect.
  pgliteAdminSocket: {
    enabled: bool(process.env.PGLITE_ADMIN_SOCKET_ENABLED, true),
    port: Number(process.env.PGLITE_ADMIN_SOCKET_PORT) > 0 ? Number(process.env.PGLITE_ADMIN_SOCKET_PORT) : 5544,
    host: process.env.PGLITE_ADMIN_SOCKET_HOST ?? '127.0.0.1',
  },
  uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR ?? 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024,
  // Seeds the reference catalogs (species, breeds, food safety, approved
  // vaccine schedules, knowledge base, nutrition). It never creates accounts,
  // pets or clinics — run `npm run create-admin` for the first administrator.
  seedCatalog: bool(process.env.SEED_CATALOG, true),
  // Nearby vet hospital search. OpenStreetMap needs no key; Google Places is
  // used instead when a Maps key is configured.
  nearby: {
    enabled: bool(process.env.OVERPASS_ENABLED, true),
    // Ordered list of public Overpass mirrors. The primary is often saturated,
    // so the query fails over to the next mirror instead of erroring out.
    // A single OVERPASS_URL overrides the whole list (useful for a self-hosted
    // instance).
    overpassUrls: (process.env.OVERPASS_URL
      ? [process.env.OVERPASS_URL]
      : [
          // Global mirrors only: regional instances (overpass.osm.ch serves
          // Switzerland alone) answer instantly with zero Indian rows, which
          // used to look like "nothing is mapped here".
          'https://overpass-api.de/api/interpreter',
          'https://overpass.kumi.systems/api/interpreter',
        ]
    ).map((u) => u.trim()).filter(Boolean),
    nominatimUrl: (process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    userAgent: process.env.NOMINATIM_USER_AGENT ?? 'PetVetAI/1.0 (veterinary care directory)',
    // How long the Overpass lookup may take before the (much faster) Nominatim
    // listing search answers instead. Public Overpass mirrors are frequently
    // saturated and can need 15-20s for a dense area, which is too long to make
    // an owner wait for a hospital list.
    timeoutMs: Number(process.env.OVERPASS_TIMEOUT_MS ?? 6_000),
  },
  // Render's free service has no persistent disk, so uploads can be kept in
  // Postgres instead. 'disk' is the local-development default.
  fileStorage: (process.env.FILE_STORAGE === 'db' ? 'db' : 'disk') as 'disk' | 'db',
  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'none') as 'none' | 'openai-compatible',
    baseUrl: (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4.1-mini',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
  },
  aiMaxMessagesPerDay: Number(process.env.AI_MAX_MESSAGES_PER_DAY ?? 80),
  exa: {
    // Server-side key for the live web search shown next to Pet Vet AI.
    // Never sent to the browser.
    apiKey: process.env.EXA_API_KEY ?? '',
  },
  // Outbound email. EMAIL_PROVIDER picks the transport: 'brevo' or 'resend'
  // send over HTTPS (the only option on Render free, which blocks SMTP ports),
  // 'smtp' uses the settings below. Empty falls back to SMTP when SMTP_HOST is
  // set, so existing local setups keep working unchanged.
  email: {
    provider: (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase(),
    apiKey: process.env.EMAIL_API_KEY ?? '',
    // The verified sender. Brevo and Resend both accept "Name <address>".
    from: process.env.EMAIL_FROM ?? 'Pet Vet AI <no-reply@petvet.local>',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    // The sender address lives in `email.from` — one place for both transports.
  },
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@petvet.local',
  },
  maps: {
    // Server-side key: Places + Geocoding. Never sent to the browser.
    apiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
    // Browser key: safe to expose because it should be restricted to your
    // site's HTTP referrer in Google Cloud Console (Maps JavaScript API only).
    browserKey: process.env.GOOGLE_MAPS_BROWSER_KEY ?? '',
    mapId: process.env.GOOGLE_MAPS_MAP_ID ?? '',
    placesEnabled: process.env.GOOGLE_PLACES_API_ENABLED !== 'false',
  },
  webrtc: {
    stun: (process.env.WEBRTC_STUN_URLS ?? 'stun:stun.l.google.com:19302')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnUrl: process.env.TURN_URL ?? '',
    turnUsername: process.env.TURN_USERNAME ?? '',
    turnCredential: process.env.TURN_CREDENTIAL ?? '',
  },
  migrationsDir: path.join(ROOT, 'db', 'migrations'),
};

if (config.isProd) {
  if (!process.env.JWT_SECRET || config.jwtSecret.includes('dev-only')) {
    throw new Error('JWT_SECRET must be set to a strong secret in production.');
  }
  if (!config.databaseUrl) {
    console.warn('[config] DATABASE_URL is not set; using PGlite file storage. Use PostgreSQL in production.');
  }
  if (config.fileStorage === 'disk') {
    console.warn(
      `[config] FILE_STORAGE=disk writes uploads to ${config.uploadDir}. Hosts with an ephemeral filesystem (Render free, Cloud Run, serverless) lose them on restart — set FILE_STORAGE=db there.`,
    );
  }
}
