import { many } from '../db.js';
import { config } from '../config.js';
import { parseJson, todayInTz, weekdayInTz } from '../util.js';

export interface CareTaskRow {
  id: string;
  petId: string;
  type: string;
  title: string;
  instructions: string | null;
  frequency: 'daily' | 'weekly' | 'monthly' | 'once';
  times: string[];
  dueDate: string | null;
  isActive: boolean;
}

export function taskDueOn(task: Pick<CareTaskRow, 'frequency' | 'dueDate'>, date: string): boolean {
  if (task.frequency === 'daily') return true;
  if (task.frequency === 'once') return task.dueDate === date;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (task.frequency === 'weekly') {
    if (task.dueDate) {
      const target = new Date(`${task.dueDate}T00:00:00Z`).getUTCDay();
      return d.getUTCDay() === target;
    }
    return d.getUTCDay() === 0;
  }
  if (task.frequency === 'monthly') {
    if (task.dueDate) return d.getUTCDate() === new Date(`${task.dueDate}T00:00:00Z`).getUTCDate();
    return d.getUTCDate() === 1;
  }
  return false;
}

export async function loadCareTasks(petId: string): Promise<CareTaskRow[]> {
  const rows = await many<CareTaskRow>(
    `SELECT id, pet_id AS "petId", type, title, instructions, frequency, times,
            due_date AS "dueDate", is_active AS "isActive"
     FROM care_tasks WHERE pet_id = $1 ORDER BY title`,
    [petId],
  );
  return rows.map((r) => ({ ...r, times: parseJson<string[]>(r.times, []) }));
}

export async function careForPet(petId: string, date: string) {
  const tasks = await loadCareTasks(petId);
  const logs = await many<Record<string, unknown>>(
    `SELECT l.id, l.task_id AS "taskId", l.type, l.value, l.notes, l.logged_at AS "loggedAt",
            u.full_name AS "loggedByName"
     FROM care_logs l LEFT JOIN users u ON u.id = l.logged_by
     WHERE l.pet_id = $1 AND (l.logged_at AT TIME ZONE $2)::date = $3::date
     ORDER BY l.logged_at DESC`,
    [petId, config.timezone, date],
  );
  const checklist = tasks
    .filter((t) => t.isActive && taskDueOn(t, date))
    .map((t) => {
      const taskLogs = logs.filter((l) => l.taskId === t.id);
      return {
        ...t,
        dueToday: true,
        completed: taskLogs.length > 0,
        completedAt: taskLogs[0]?.loggedAt ?? null,
        logs: taskLogs,
      };
    });
  return {
    date,
    timezone: config.timezone,
    tasks: checklist,
    logs,
    summary: {
      due: checklist.length,
      completed: checklist.filter((t) => t.completed).length,
    },
  };
}

export function isToday(date: string): boolean {
  return date === todayInTz();
}

export function currentWeekday(): number {
  return weekdayInTz();
}
