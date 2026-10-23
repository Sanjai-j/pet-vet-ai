import { closeDb } from '../src/db.js';
import { syncAllApprovedVaccineSchedules } from '../src/services/vaccine-rag.js';

/**
 * Backfill the AI knowledge index from already-approved vaccination schedule
 * rows. New approvals mirror automatically; this script exists for databases
 * whose rows were approved before the mirror was introduced.
 *
 *   npm run backfill:vaccine-rag --prefix apps/api
 */
async function main(): Promise<void> {
  const count = await syncAllApprovedVaccineSchedules();
  console.log(`[vaccine-rag] mirrored ${count} approved schedule row(s) into the knowledge index`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('[vaccine-rag] backfill failed:', err);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
