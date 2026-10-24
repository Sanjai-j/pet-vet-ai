import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { ApiError, asyncHandler, badRequest, conflict, forbidden, notFound, parse, unauthorized } from '../errors.js';
import { getDb, one } from '../db.js';
import { audit } from '../audit.js';
import { hashPassword, requireAuth, signToken, verifyPassword, type AuthUser } from '../auth.js';
import { parseJson } from '../util.js';
import {
  requestPasswordReset,
  resetPasswordWithToken,
  verifyResetToken,
} from '../services/password-reset.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email('Enter a valid email address').max(200),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
  fullName: z.string().min(2, 'Enter your name').max(120),
  role: z.enum(['owner', 'vet']).default('owner'),
  phone: z.string().max(30).optional(),
  city: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  vet: z
    .object({
      licenseNumber: z.string().min(3).max(60),
      council: z.string().min(2).max(120),
      experienceYears: z.number().int().min(0).max(70).optional(),
      clinicName: z.string().max(160).optional(),
      clinicAddress: z.string().max(300).optional(),
      specialties: z.array(z.string().max(80)).max(12).optional(),
      species: z.array(z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other'])).max(6).optional(),
    })
    .optional(),
});

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: 'owner' | 'vet' | 'admin';
  phone: string | null;
  city: string | null;
  state: string | null;
  notification_prefs: unknown;
  privacy: unknown;
  created_at: string;
}

export async function userPayload(userId: string) {
  const row = await one<UserRow>(
    `SELECT id, email, full_name, role, phone, city, state, notification_prefs, privacy, created_at
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw notFound('Account not found');
  const vet = await one<Record<string, unknown>>(
    `SELECT user_id AS "userId", license_number AS "licenseNumber", council,
            experience_years AS "experienceYears", bio, clinic_name AS "clinicName",
            clinic_address AS "clinicAddress", city, state, pincode, latitude, longitude,
            specialties, species, availability, consultation_fee_inr AS "consultationFeeInr",
            verification_status AS "verificationStatus", verification_notes AS "verificationNotes",
            verified_at AS "verifiedAt"
     FROM vet_profiles WHERE user_id = $1`,
    [userId],
  );
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    phone: row.phone,
    city: row.city,
    state: row.state,
    notificationPrefs: parseJson(row.notification_prefs, {}),
    privacy: parseJson(row.privacy, {}),
    vetProfile: vet,
    createdAt: row.created_at,
  };
}

// Simple in-memory throttle for credential stuffing on a single instance.
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW = 15 * 60_000;
const MAX_ATTEMPTS = 12;

function throttle(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW) {
    attempts.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    throw new ApiError(429, 'rate_limited', 'Too many attempts. Please wait 15 minutes.');
  }
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const db = await getDb();
    const email = body.email.trim().toLowerCase();

    const existing = await one('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (existing) throw conflict('An account with this email already exists');

    if (body.role === 'vet' && !body.vet) {
      throw badRequest('Veterinarian registration requires a license number and council');
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);

    await db.query(
      `INSERT INTO users (id, email, password_hash, full_name, role, phone, city, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, email, passwordHash, body.fullName.trim(), body.role, body.phone ?? null, body.city ?? null, body.state ?? null],
    );

    if (body.role === 'vet' && body.vet) {
      const speciesList = body.vet.species?.length ? body.vet.species : ['dog', 'cat'];
      await db.query(
        `INSERT INTO vet_profiles
          (user_id, license_number, council, experience_years, clinic_name, clinic_address,
           city, state, specialties, species, verification_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], 'pending')`,
        [
          userId, body.vet.licenseNumber, body.vet.council, body.vet.experienceYears ?? null,
          body.vet.clinicName ?? null, body.vet.clinicAddress ?? null, body.city ?? null,
          body.state ?? null, `{${(body.vet.specialties ?? []).map((s) => `"${s.replace(/"/g, '')}"`).join(',')}}`,
          `{${speciesList.join(',')}}`,
        ],
      );
    }

    await audit(userId, 'auth.register', 'user', userId, { role: body.role });
    const user: AuthUser = { id: userId, email, fullName: body.fullName.trim(), role: body.role ?? 'owner' };
    res.status(201).json({ token: signToken(user), user: await userPayload(userId) });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ email: z.string().email(), password: z.string().min(1).max(128) }),
      req.body,
    );
    const key = `${req.ip}:${body.email.toLowerCase()}`;
    throttle(key);
    const db = await getDb();
    const rows = await db.query<{ id: string; password_hash: string; role: AuthUser['role']; full_name: string; email: string; disabled: boolean }>(
      `SELECT id, password_hash, role, full_name, email, disabled FROM users WHERE lower(email) = $1`,
      [body.email.trim().toLowerCase()],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw unauthorized('Email or password is incorrect');
    }
    if (user.disabled) throw forbidden('This account has been disabled. Contact support.');
    attempts.delete(key);
    const payload: AuthUser = { id: user.id, email: user.email, fullName: user.full_name, role: user.role };
    await audit(user.id, 'auth.login', 'user', user.id);
    res.json({ token: signToken(payload), user: await userPayload(user.id) });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await userPayload(req.user!.id) });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        fullName: z.string().min(2).max(120).optional(),
        phone: z.string().max(30).nullable().optional(),
        city: z.string().max(80).nullable().optional(),
        state: z.string().max(80).nullable().optional(),
        privacy: z
          .object({
            shareRecordsWithVet: z.boolean().optional(),
            allowAiTraining: z.boolean().optional(),
          })
          .optional(),
      }),
      req.body,
    );
    const db = await getDb();
    const current = await one<{ privacy: unknown }>('SELECT privacy FROM users WHERE id = $1', [req.user!.id]);
    const privacy = { ...parseJson<Record<string, unknown>>(current?.privacy, {}), ...(body.privacy ?? {}) };
    await db.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         phone = COALESCE($2, phone),
         city = COALESCE($3, city),
         state = COALESCE($4, state),
         privacy = $5
       WHERE id = $6`,
      [body.fullName ?? null, body.phone ?? null, body.city ?? null, body.state ?? null, JSON.stringify(privacy), req.user!.id],
    );
    await audit(req.user!.id, 'profile.update', 'user', req.user!.id);
    res.json({ user: await userPayload(req.user!.id) });
  }),
);

authRouter.patch(
  '/me/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      feeding: z.boolean().optional(),
      grooming: z.boolean().optional(),
      vaccination: z.boolean().optional(),
      email: z.boolean().optional(),
      push: z.boolean().optional(),
      inApp: z.boolean().optional(),
    });
    const body = parse(schema, req.body);
    const db = await getDb();
    const current = await one<{ notification_prefs: unknown }>(
      'SELECT notification_prefs FROM users WHERE id = $1',
      [req.user!.id],
    );
    const prefs = { ...parseJson<Record<string, boolean>>(current?.notification_prefs, {}), ...body };
    await db.query('UPDATE users SET notification_prefs = $1 WHERE id = $2', [
      JSON.stringify(prefs),
      req.user!.id,
    ]);
    await audit(req.user!.id, 'notifications.prefs', 'user', req.user!.id, body);
    res.json({ notificationPrefs: prefs });
  }),
);

/**
 * Password reset, step 1: ask for a link.
 *
 * The response never says whether the address has an account. `delivery`
 * describes the server's email setup, not the account: 'skipped' means this
 * deployment has no email transport, 'failed' means the provider refused it.
 */
authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().email('Enter a valid email address').max(200) }), req.body);
    const result = await requestPasswordReset(body.email, req.ip ?? null);
    res.json({ ok: true, delivery: result.delivery });
  }),
);

/** Whether a reset link is still usable — the reset screen calls this on load. */
authRouter.get(
  '/reset-password/:token',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token ?? '');
    res.json(await verifyResetToken(token));
  }),
);

/** Password reset, step 2: spend the token and set a new password. */
authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        token: z.string().min(10).max(200),
        newPassword: z.string().min(8, 'Use at least 8 characters').max(128),
      }),
      req.body,
    );
    // A valid token cannot be guessed, but this keeps a stuck client from
    // hammering the endpoint.
    throttle(`reset:${req.ip}`);
    await resetPasswordWithToken(body.token, body.newPassword);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/me/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
      req.body,
    );
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!row || !(await bcrypt.compare(body.currentPassword, row.password_hash))) {
      throw unauthorized('Current password is incorrect');
    }
    await (await getDb()).query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(body.newPassword),
      req.user!.id,
    ]);
    await audit(req.user!.id, 'auth.password_change', 'user', req.user!.id);
    res.json({ ok: true });
  }),
);
