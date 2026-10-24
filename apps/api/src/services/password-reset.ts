/**
 * Password reset by email.
 *
 * The flow is deliberately the boring, safe one:
 *
 *  1. `POST /api/auth/forgot-password` — the owner submits an address. The
 *     answer is identical whether or not an account exists, so the endpoint
 *     cannot be used to find out who has signed up.
 *  2. A 32-byte random token is stored as a SHA-256 hash with a 30-minute
 *     expiry, and only one link is live per account: asking again invalidates
 *     the previous email.
 *  3. `POST /api/auth/reset-password` — the token plus a new password. Using a
 *     token burns it and deletes every other outstanding link for the account.
 *
 * Sessions are JWTs with a 12-hour lifetime, so a reset does not sign out an
 * already-open device; that device keeps working until its token expires.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb, id, one } from '../db.js';
import { hashPassword } from '../auth.js';
import { audit } from '../audit.js';
import { ApiError, forbidden } from '../errors.js';
import { emailConfigured, sendEmail } from './email.js';

export const RESET_TTL_MINUTES = 30;

/** What the API can honestly say happened, without revealing account existence. */
export type ResetDelivery = 'sent' | 'skipped' | 'failed';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function resetUrl(token: string): string {
  const base = (config.webOrigin || 'http://localhost:4200').replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Sliding-window throttle per address and per IP, held in memory: a single
 * instance is all this deployment has, and a restart clearing it is harmless.
 */
const hits = new Map<string, number[]>();

function allow(key: string, max: number, windowMs = 60 * 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((seen) => now - seen < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  }
  return true;
}

/**
 * Create a reset token and return the raw value. It is never stored — only its
 * hash is — so the caller must put it in the email straight away. Exported for
 * the test suite, which needs a token it can present to the API.
 */
export async function issueResetToken(userId: string, ip: string | null): Promise<string> {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString();
  await db.query(
    'DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  await db.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [id(), userId, hashToken(token), expiresAt, ip],
  );
  return token;
}

export async function requestPasswordReset(
  rawEmail: string,
  ip: string | null,
): Promise<{ delivery: ResetDelivery }> {
  const email = rawEmail.trim().toLowerCase();

  if (!allow(`reset:ip:${ip ?? 'unknown'}`, 10) || !allow(`reset:email:${email}`, 3)) {
    throw new ApiError(429, 'rate_limited', 'Too many reset requests. Please wait an hour.');
  }

  const configured = emailConfigured();
  if (!configured) {
    // Nothing was sent, and saying otherwise would send the owner hunting
    // through a spam folder for a message that does not exist.
    console.warn('[reset] no email transport configured (set EMAIL_PROVIDER + EMAIL_API_KEY)');
    return { delivery: 'skipped' };
  }

  const user = await one<{ id: string; full_name: string }>(
    'SELECT id, full_name FROM users WHERE lower(email) = $1 AND disabled = false',
    [email],
  );
  // An unknown address must look exactly like a delivered one.
  if (!user) return { delivery: 'sent' };

  const token = await issueResetToken(user.id, ip);
  const link = resetUrl(token);
  const name = user.full_name.split(/\s+/)[0] || 'there';
  const text = [
    `Hello ${name},`,
    '',
    `Someone asked to reset the password for your Pet Vet AI account (${email}).`,
    `Open this link within ${RESET_TTL_MINUTES} minutes to choose a new password:`,
    '',
    link,
    '',
    "If you did not ask for this, ignore this email — your current password still works. Only request a new link if you are sure.",
    '',
    'Pet Vet AI never asks for your password by email or phone.',
  ].join('\n');
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#FBF6EF;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2B1D14">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #EADCC8;border-radius:16px;padding:28px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#A9683A;font-weight:700">Pet Vet AI</p>
    <h1 style="margin:0 0 12px;font-size:22px">Reset your password</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55">Hello ${escapeHtml(name)}, someone asked to reset the password for <b>${escapeHtml(email)}</b>.</p>
    <p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#4A2C18;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">Choose a new password</a></p>
    <p style="margin:0 0 8px;font-size:13px;color:#6B5B4B;line-height:1.55">This link works once and expires in ${RESET_TTL_MINUTES} minutes.</p>
    <p style="margin:0;font-size:13px;color:#6B5B4B;line-height:1.55">If you did not ask for this, ignore this email — your current password still works.</p>
  </div>
</body></html>`;

  const result = await sendEmail(email, 'Reset your Pet Vet AI password', text, html);
  if (!result.delivered) {
    console.warn(`[reset] reset email was not delivered (${result.reason})`);
    return { delivery: 'failed' };
  }
  await audit(user.id, 'auth.password_reset_request', 'user', user.id, { ip });
  return { delivery: 'sent' };
}

/** Used by the reset screen to show "this link has expired" before typing. */
export async function verifyResetToken(
  token: string,
): Promise<{ valid: boolean; expiresAt?: string }> {
  if (!token || token.length > 200) return { valid: false };
  const row = await one<{ expires_at: string; used_at: string | null }>(
    'SELECT expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1',
    [hashToken(token)],
  );
  if (!row || row.used_at) return { valid: false };
  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) return { valid: false };
  return { valid: true, expiresAt: expiresAt.toISOString() };
}

function invalidToken(): ApiError {
  return new ApiError(
    400,
    'invalid_reset_token',
    'This reset link is invalid or has expired. Request a new one.',
  );
}

export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  if (!token || token.length > 200) throw invalidToken();
  const db = await getDb();
  const row = await one<{
    id: string;
    user_id: string;
    expires_at: string;
    used_at: string | null;
    disabled: boolean;
  }>(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.disabled
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1`,
    [hashToken(token)],
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) throw invalidToken();
  if (row.disabled) throw forbidden('This account has been disabled. Contact support.');

  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    await hashPassword(newPassword),
    row.user_id,
  ]);
  await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
  await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND id <> $2', [
    row.user_id,
    row.id,
  ]);
  await audit(row.user_id, 'auth.password_reset', 'user', row.user_id);
}
