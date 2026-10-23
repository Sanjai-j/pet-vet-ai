import { getDb, id, many } from '../db.js';
import { config } from '../config.js';
import { addDays, daysBetween, parseJson, timeInTz, todayInTz } from '../util.js';
import { taskDueOn } from './care.js';
import { createNotification, sendEmail, sendPush } from './notifications.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

async function createReminderOnce(input: {
  userId: string;
  petId: string;
  taskId: string | null;
  kind: string;
  title: string;
  scheduledFor: string;
  dedupeKey: string;
  body: string;
  petName: string;
}): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO reminders (id, user_id, pet_id, task_id, kind, title, scheduled_for, status, channel, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','in_app',$8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [id(), input.userId, input.petId, input.taskId, input.kind, input.title, input.scheduledFor, input.dedupeKey],
  );
  if (!rows.length) return false;

  await createNotification({
    userId: input.userId,
    title: input.title,
    body: input.body,
    kind: input.kind,
    link: `/pets/${input.petId}`,
  });
  await db.query(`UPDATE reminders SET status = 'sent', sent_at = now() WHERE dedupe_key = $1`, [input.dedupeKey]);
  return true;
}

/** Exported for tests: one deterministic scheduler pass. */
export async function runReminderTick(now = new Date()): Promise<{ care: number; vaccinations: number; checkpoints: number }> {
  if (running) return { care: 0, vaccinations: 0, checkpoints: 0 };
  running = true;
  let care = 0;
  let vaccinations = 0;
  let checkpoints = 0;
  try {
    const db = await getDb();
    const date = todayInTz(now);
    const nowTime = timeInTz(now);
    const nowMinutes = minutes(nowTime);

    const tasks = await many<{
      id: string; petId: string; petName: string; ownerId: string; type: string;
      title: string; frequency: string; times: unknown; dueDate: string | null;
      prefs: unknown; email: string; checkedToday: boolean;
    }>(
      `SELECT ct.id, ct.pet_id AS "petId", p.name AS "petName", p.owner_id AS "ownerId",
              ct.type, ct.title, ct.frequency, ct.times, ct.due_date AS "dueDate",
              u.notification_prefs AS prefs, u.email
       FROM care_tasks ct
       JOIN pets p ON p.id = ct.pet_id
       JOIN users u ON u.id = p.owner_id
       WHERE ct.is_active = true
         AND ct.type IN ('feeding', 'grooming', 'vaccination')
         AND u.disabled = false`,
    );

    for (const task of tasks) {
      const prefs = parseJson<Record<string, boolean>>(task.prefs, {});
      if (prefs[task.type] !== true) continue;
      if (prefs.inApp === false && prefs.email !== true && prefs.push !== true) continue;
      if (!taskDueOn({ frequency: task.frequency as any, dueDate: task.dueDate }, date)) continue;
      const slots = parseJson<string[]>(task.times, []);
      for (const slot of slots) {
        const diff = nowMinutes - minutes(slot);
        if (diff < 0 || diff > 4) continue;
        const when = `${date} ${slot}`;
        const sent = await createReminderOnce({
          userId: task.ownerId,
          petId: task.petId,
          taskId: task.id,
          kind: task.type,
          title: `${task.title} — ${task.petName}`,
          body: `Scheduled care reminder for ${when} (${config.timezone}).`,
          scheduledFor: now.toISOString(),
          dedupeKey: `task:${task.id}:${date}:${slot}`,
          petName: task.petName,
        });
        if (!sent) continue;
        care += 1;

        if (prefs.email === true) {
          const result = await sendEmail(
            task.email,
            `Pet Vet AI reminder: ${task.petName}`,
            `${task.title} for ${task.petName} is due at ${slot} on ${date}.`,
          );
          if (!result.delivered) console.log(`[scheduler] email not delivered (${result.reason})`);
        }
        if (prefs.push === true) {
          const result = await sendPush(task.ownerId, {
            title: `${task.title} — ${task.petName}`,
            body: `Due at ${slot}.`,
            link: `/pets/${task.petId}`,
          });
          if (!result.delivered) console.log(`[scheduler] push not delivered (${result.reason})`);
        }
      }
    }

    // Vaccination reminders once per day at 09:00 local time.
    if (nowMinutes >= 540 && nowMinutes <= 544) {
      const dueVax = await many<{
        id: string; vaccineName: string; nextDueOn: string; petId: string; petName: string;
        ownerId: string; prefs: unknown;
      }>(
        `SELECT v.id, v.vaccine_name AS "vaccineName", v.next_due_on AS "nextDueOn",
                p.id AS "petId", p.name AS "petName", p.owner_id AS "ownerId",
                u.notification_prefs AS prefs
         FROM vaccinations v
         JOIN pets p ON p.id = v.pet_id
         JOIN users u ON u.id = p.owner_id
         WHERE v.next_due_on IS NOT NULL
           AND v.next_due_on >= $1::date AND v.next_due_on <= $2::date
           AND u.disabled = false`,
        [date, addDays(date, 7)],
      );
      for (const vax of dueVax) {
        const prefs = parseJson<Record<string, boolean>>(vax.prefs, {});
        if (prefs.vaccination !== true) continue;
        const left = daysBetween(date, vax.nextDueOn);
        await createReminderOnce({
          userId: vax.ownerId,
          petId: vax.petId,
          taskId: null,
          kind: 'vaccination',
          title: `Vaccination follow-up — ${vax.petName}`,
          body: `${vax.vaccineName} is recorded as due ${vax.nextDueOn} (${left === 0 ? 'today' : `in ${left} day(s)`}). Confirm the schedule with your veterinarian.`,
          scheduledFor: now.toISOString(),
          dedupeKey: `vax:${vax.id}:${date}`,
          petName: vax.petName,
        });
        vaccinations += 1;
      }

      // Vaccination checkpoints the owner scheduled (or that were generated
      // from an approved schedule). The reminder follows the checkpoint's
      // current due date, so moving a date moves its notification too.
      const dueCheckpoints = await many<{
        id: string; vaccineName: string; dueOn: string; petId: string; petName: string;
        ownerId: string; prefs: unknown; email: string;
      }>(
        `SELECT vc.id, vc.vaccine_name AS "vaccineName", vc.due_on::text AS "dueOn",
                p.id AS "petId", p.name AS "petName", p.owner_id AS "ownerId",
                u.notification_prefs AS prefs, u.email
         FROM vaccination_checkpoints vc
         JOIN pets p ON p.id = vc.pet_id
         JOIN users u ON u.id = p.owner_id
         WHERE vc.status = 'pending'
           AND vc.due_on >= $1::date AND vc.due_on <= $2::date
           AND u.disabled = false`,
        [date, addDays(date, 7)],
      );
      for (const checkpoint of dueCheckpoints) {
        const prefs = parseJson<Record<string, boolean>>(checkpoint.prefs, {});
        if (prefs.vaccination !== true) continue;
        const left = daysBetween(date, checkpoint.dueOn);
        const sent = await createReminderOnce({
          userId: checkpoint.ownerId,
          petId: checkpoint.petId,
          taskId: null,
          kind: 'vaccination',
          title: `Vaccination due — ${checkpoint.petName}`,
          body:
            `${checkpoint.vaccineName} is planned for ${checkpoint.dueOn} ` +
            `(${left === 0 ? 'today' : `in ${left} day(s)`}). ` +
            'Mark it done or move the date, and confirm the schedule with your veterinarian.',
          scheduledFor: now.toISOString(),
          dedupeKey: `vaxcp:${checkpoint.id}:${date}`,
          petName: checkpoint.petName,
        });
        if (!sent) continue;
        checkpoints += 1;
        if (prefs.email === true) {
          const result = await sendEmail(
            checkpoint.email,
            `Pet Vet AI vaccination reminder: ${checkpoint.petName}`,
            `${checkpoint.vaccineName} is planned for ${checkpoint.dueOn}. ` +
              `Open the pet's vaccination plan to confirm, mark it done or move the date.`,
          );
          if (!result.delivered) console.log(`[scheduler] email not delivered (${result.reason})`);
        }
        if (prefs.push === true) {
          const result = await sendPush(checkpoint.ownerId, {
            title: `Vaccination due — ${checkpoint.petName}`,
            body: `${checkpoint.vaccineName} on ${checkpoint.dueOn}.`,
            link: `/pets/${checkpoint.petId}`,
          });
          if (!result.delivered) console.log(`[scheduler] push not delivered (${result.reason})`);
        }
      }
    }
    return { care, vaccinations, checkpoints };
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  const intervalMs = 30_000;
  timer = setInterval(() => {
    runReminderTick().catch((err) => console.error('[scheduler] tick failed', err));
  }, intervalMs);
  runReminderTick().catch((err) => console.error('[scheduler] initial tick failed', err));
  console.log(`[scheduler] reminder worker started (${config.timezone}, every ${intervalMs / 1000}s)`);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
