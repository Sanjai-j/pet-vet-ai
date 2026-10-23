/**
 * One-off dev repair: an earlier version of the slot-claim UPDATE reported zero
 * affected rows, so a booking was rolled back while its slot stayed `booked`
 * pointing at a now-deleted appointment. Re-open any such orphaned slots.
 *
 * Run with: npx tsx scripts/fix-orphan-slots.ts
 * Safe to re-run.
 */
import { closeDb, getDb } from '../src/db.js';

async function main(): Promise<void> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `UPDATE vet_slots s SET status = 'available', appointment_id = NULL
     WHERE s.status = 'booked'
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = s.appointment_id)
     RETURNING s.id`,
  );
  console.log(`[fix] re-opened ${rows.length} orphaned slot(s)`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
