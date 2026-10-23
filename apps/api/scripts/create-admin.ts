import { closeDb, getDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { isEmail } from '../src/util.js';

/**
 * Create the first administrator, or promote an existing account.
 *
 * The seed only loads reference catalogs, so a fresh deployment has no
 * accounts at all. Run this once after the database is migrated:
 *
 *   npm run create-admin --prefix apps/api -- you@example.com "A-strong-password" "Your Name"
 *
 * An existing account is promoted to admin without touching its password.
 */
async function main(): Promise<void> {
  const [emailArg, passwordArg, ...nameParts] = process.argv.slice(2);
  const email = (emailArg ?? '').trim().toLowerCase();
  const password = passwordArg ?? '';
  const fullName = nameParts.join(' ').trim() || 'Administrator';

  if (!isEmail(email)) {
    console.error('[create-admin] usage: npm run create-admin -- <email> "<password>" ["Full name"]');
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error('[create-admin] the password must be at least 8 characters');
    process.exitCode = 1;
    return;
  }

  const db = await getDb();
  const existing = await db.query<{ id: string; role: string; disabled: boolean }>(
    'SELECT id, role, disabled FROM users WHERE lower(email) = $1',
    [email],
  );
  const found = existing[0];

  if (found) {
    await db.query('UPDATE users SET role = $1, disabled = false WHERE id = $2', ['admin', found.id]);
    console.log(`[create-admin] ${email} already existed (${found.role}) and is now an administrator.`);
    console.log('[create-admin] its password was left unchanged.');
    await closeDb();
    return;
  }

  await db.query(
    `INSERT INTO users (id, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, 'admin')`,
    [crypto.randomUUID(), email, await hashPassword(password), fullName],
  );
  console.log(`[create-admin] administrator created: ${email}`);
  console.log('[create-admin] sign in at /login and change the password from Settings if you shared it.');
  await closeDb();
}

main().catch(async (err) => {
  console.error('[create-admin] failed:', err);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
