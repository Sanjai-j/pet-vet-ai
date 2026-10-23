import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { assertPetOwner, loadPet } from '../access.js';
import { careForPet } from '../services/care.js';
import { audit } from '../audit.js';
import { todayInTz } from '../util.js';

export const careRouter = Router();
careRouter.use(requireAuth);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const taskTypes = ['feeding', 'water', 'grooming', 'medication', 'walk', 'vaccination', 'observation', 'other'] as const;
const logTypes = [...taskTypes, 'weight'] as const;

const taskBody = z.object({
  type: z.enum(taskTypes),
  title: z.string().min(1).max(120),
  instructions: z.string().max(1000).nullable().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'once']).default('daily'),
  times: z.array(timeSchema).max(6).default([]),
  dueDate: dateSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

careRouter.get(
  '/care/today',
  asyncHandler(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : todayInTz();
    parse(dateSchema, date);
    const pets = await many<{ id: string; name: string; speciesCode: string; speciesIcon: string }>(
      `SELECT p.id, p.name, p.species_code AS "speciesCode", s.icon AS "speciesIcon"
       FROM pets p JOIN species s ON s.code = p.species_code
       WHERE p.owner_id = $1 ORDER BY p.created_at`,
      [req.user!.id],
    );
    const result = [];
    for (const pet of pets) {
      const care = await careForPet(pet.id, date);
      result.push({ pet, ...care });
    }
    res.json({ date, pets: result });
  }),
);

careRouter.get(
  '/pets/:petId/care',
  asyncHandler(async (req, res) => {
    await loadPet(req.params.petId, req.user!);
    const date = typeof req.query.date === 'string' ? req.query.date : todayInTz();
    parse(dateSchema, date);
    res.json(await careForPet(req.params.petId, date));
  }),
);

careRouter.post(
  '/pets/:petId/care/tasks',
  asyncHandler(async (req, res) => {
    await assertPetOwner(req.params.petId, req.user!);
    const body = parse(taskBody, req.body);
    if (body.frequency === 'once' && !body.dueDate) throw badRequest('A one-time task needs a due date');
    const taskId = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO care_tasks (id, pet_id, type, title, instructions, frequency, times, due_date, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        taskId, req.params.petId, body.type, body.title, body.instructions ?? null,
        body.frequency, JSON.stringify(body.times), body.dueDate ?? null,
        body.isActive ?? true, req.user!.id,
      ],
    );
    await audit(req.user!.id, 'care.task_create', 'care_task', taskId, { petId: req.params.petId });
    res.status(201).json({ task: await one('SELECT * FROM care_tasks WHERE id = $1', [taskId]) });
  }),
);

careRouter.patch(
  '/care/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const task = await one<{ id: string; pet_id: string }>('SELECT id, pet_id FROM care_tasks WHERE id = $1', [req.params.taskId]);
    if (!task) throw notFound('Care task not found');
    await assertPetOwner(task.pet_id, req.user!);
    const body = parse(taskBody.partial(), req.body);
    await (await getDb()).query(
      `UPDATE care_tasks SET
        type = COALESCE($1, type), title = COALESCE($2, title),
        instructions = COALESCE($3, instructions), frequency = COALESCE($4, frequency),
        times = COALESCE($5::jsonb, times), due_date = COALESCE($6, due_date),
        is_active = COALESCE($7, is_active)
       WHERE id = $8`,
      [
        body.type ?? null, body.title ?? null, body.instructions ?? null,
        body.frequency ?? null, body.times ? JSON.stringify(body.times) : null,
        body.dueDate ?? null, body.isActive ?? null, req.params.taskId,
      ],
    );
    res.json({ task: await one('SELECT * FROM care_tasks WHERE id = $1', [req.params.taskId]) });
  }),
);

careRouter.delete(
  '/care/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const task = await one<{ pet_id: string }>('SELECT pet_id FROM care_tasks WHERE id = $1', [req.params.taskId]);
    if (!task) throw notFound('Care task not found');
    await assertPetOwner(task.pet_id, req.user!);
    await (await getDb()).query('DELETE FROM care_tasks WHERE id = $1', [req.params.taskId]);
    res.status(204).send();
  }),
);

careRouter.post(
  '/pets/:petId/care/logs',
  asyncHandler(async (req, res) => {
    const pet = await loadPet(req.params.petId, req.user!);
    if (req.user!.role === 'vet') {
      throw badRequest('Care logs are recorded by the pet owner');
    }
    const body = parse(
      z.object({
        type: z.enum(logTypes),
        taskId: z.string().max(80).nullable().optional(),
        value: z.record(z.unknown()).optional(),
        notes: z.string().max(2000).nullable().optional(),
        loggedAt: z.string().datetime().optional(),
      }),
      req.body,
    );
    if (body.taskId) {
      const task = await one<{ id: string; pet_id: string }>('SELECT id, pet_id FROM care_tasks WHERE id = $1', [body.taskId]);
      if (!task || task.pet_id !== pet.id) throw badRequest('Care task does not belong to this pet');
    }
    const logId = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO care_logs (id, pet_id, task_id, type, value, notes, logged_by, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))`,
      [
        logId, pet.id, body.taskId ?? null, body.type, JSON.stringify(body.value ?? {}),
        body.notes ?? null, req.user!.id, body.loggedAt ?? null,
      ],
    );

    if (body.type === 'weight' && body.value && typeof body.value.weightKg === 'number') {
      const weight = Number(body.value.weightKg);
      if (weight > 0 && weight < 1500) {
        await (await getDb()).query(
          'UPDATE pets SET weight_kg = $1, weight_measured_on = $2, updated_at = now() WHERE id = $3',
          [weight, todayInTz(), pet.id],
        );
      }
    }
    const log = await one('SELECT id, type, value, notes, logged_at AS "loggedAt" FROM care_logs WHERE id = $1', [logId]);
    res.status(201).json({ log });
  }),
);

careRouter.delete(
  '/care/logs/:logId',
  asyncHandler(async (req, res) => {
    const log = await one<{ pet_id: string; logged_by: string }>('SELECT pet_id, logged_by FROM care_logs WHERE id = $1', [req.params.logId]);
    if (!log) throw notFound('Care log not found');
    const pet = await loadPet(log.pet_id, req.user!);
    if (req.user!.role !== 'admin' && pet.ownerId !== req.user!.id && log.logged_by !== req.user!.id) {
      throw badRequest('You cannot remove this log');
    }
    await (await getDb()).query('DELETE FROM care_logs WHERE id = $1', [req.params.logId]);
    res.status(204).send();
  }),
);
