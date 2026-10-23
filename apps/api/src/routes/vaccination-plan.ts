import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound, parse } from '../errors.js';
import { one } from '../db.js';
import { requireAuth } from '../auth.js';
import { assertPetOwner, loadPet } from '../access.js';
import { audit } from '../audit.js';
import { todayInTz } from '../util.js';
import {
  checkpointsForPet,
  completeCheckpoint,
  createCheckpoint,
  generateCheckpoints,
  loadPetForPlan,
  planForPet,
  removeCheckpoint,
  rescheduleCheckpoint,
} from '../services/vaccine-schedule.js';

export const vaccinationPlanRouter = Router();
vaccinationPlanRouter.use(requireAuth);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');

async function loadCheckpoint(checkpointId: string) {
  const checkpoint = await one<{
    id: string;
    petId: string;
    scheduleId: string | null;
    vaccineName: string;
    dueOn: string;
    status: string;
  }>(
    `SELECT id, pet_id AS "petId", schedule_id AS "scheduleId", vaccine_name AS "vaccineName",
            due_on::text AS "dueOn", status
     FROM vaccination_checkpoints WHERE id = $1`,
    [checkpointId],
  );
  if (!checkpoint) throw notFound('Vaccination checkpoint not found');
  return checkpoint;
}

vaccinationPlanRouter.get(
  '/pets/:petId/vaccination-plan',
  asyncHandler(async (req, res) => {
    const pet = await loadPet(req.params.petId, req.user!);
    const plan = await planForPet(pet.id);
    if (!plan) throw notFound('Pet not found');
    res.json(plan);
  }),
);

vaccinationPlanRouter.post(
  '/pets/:petId/vaccination-plan/generate',
  asyncHandler(async (req, res) => {
    const pet = await assertPetOwner(req.params.petId, req.user!);
    const planPet = await loadPetForPlan(pet.id);
    if (!planPet) throw notFound('Pet not found');
    const result = await generateCheckpoints(planPet, req.user!.id);
    if (result.created) {
      await audit(req.user!.id, 'vaccination.checkpoints_generate', 'pet', pet.id, { created: result.created });
    }
    res.json({ ...result, checkpoints: await checkpointsForPet(pet.id) });
  }),
);

vaccinationPlanRouter.post(
  '/pets/:petId/vaccination-checkpoints',
  asyncHandler(async (req, res) => {
    const pet = await assertPetOwner(req.params.petId, req.user!);
    const body = parse(
      z.object({
        vaccineName: z.string().min(1).max(120),
        dueOn: dateSchema,
        notes: z.string().max(1000).nullable().optional(),
      }),
      req.body,
    );
    const checkpoint = await createCheckpoint({
      petId: pet.id,
      userId: req.user!.id,
      vaccineName: body.vaccineName,
      dueOn: body.dueOn,
      notes: body.notes ?? null,
    });
    await audit(req.user!.id, 'vaccination.checkpoint_create', 'vaccination_checkpoint', checkpoint.id, {
      petId: pet.id,
      dueOn: body.dueOn,
    });
    res.status(201).json({ checkpoint });
  }),
);

vaccinationPlanRouter.patch(
  '/vaccination-checkpoints/:checkpointId',
  asyncHandler(async (req, res) => {
    const checkpoint = await loadCheckpoint(req.params.checkpointId);
    await assertPetOwner(checkpoint.petId, req.user!);
    if (checkpoint.status !== 'pending') {
      throw badRequest('Only a pending checkpoint can be moved. Add a new date instead.');
    }
    const body = parse(
      z.object({
        dueOn: dateSchema,
        notes: z.string().max(1000).nullable().optional(),
      }),
      req.body,
    );
    await rescheduleCheckpoint(checkpoint, body.dueOn, body.notes ?? null);
    await audit(req.user!.id, 'vaccination.checkpoint_reschedule', 'vaccination_checkpoint', checkpoint.id, {
      from: checkpoint.dueOn,
      to: body.dueOn,
    });
    res.json({ checkpoint: await loadCheckpoint(checkpoint.id) });
  }),
);

vaccinationPlanRouter.post(
  '/vaccination-checkpoints/:checkpointId/done',
  asyncHandler(async (req, res) => {
    const checkpoint = await loadCheckpoint(req.params.checkpointId);
    const pet = await loadPet(checkpoint.petId, req.user!);
    const isOwnerOrAdmin = req.user!.role === 'admin' || pet.ownerId === req.user!.id;
    if (!isOwnerOrAdmin && req.user!.role !== 'vet') {
      throw forbidden('Only the pet owner or a veterinarian with access can mark this done');
    }
    if (checkpoint.status !== 'pending') {
      throw badRequest('This checkpoint is no longer pending.');
    }
    const body = parse(
      z.object({
        completedOn: dateSchema.optional(),
        notes: z.string().max(1000).nullable().optional(),
      }),
      req.body ?? {},
    );
    if (body.completedOn && body.completedOn > todayInTz()) {
      throw badRequest('A vaccination date cannot be in the future. Use “Set date” to schedule it.');
    }
    const result = await completeCheckpoint({
      checkpoint,
      userId: req.user!.id,
      source: req.user!.role === 'vet' ? 'vet_recorded' : 'owner_reported',
      completedOn: body.completedOn,
      notes: body.notes ?? null,
    });
    await audit(req.user!.id, 'vaccination.checkpoint_done', 'vaccination_checkpoint', checkpoint.id, {
      petId: checkpoint.petId,
      completedOn: result.completedOn,
      vaccinationId: result.vaccinationId,
      nextDueOn: result.next?.dueOn ?? null,
    });
    res.json({
      ...result,
      checkpoints: await checkpointsForPet(checkpoint.petId),
    });
  }),
);

vaccinationPlanRouter.delete(
  '/vaccination-checkpoints/:checkpointId',
  asyncHandler(async (req, res) => {
    const checkpoint = await loadCheckpoint(req.params.checkpointId);
    await assertPetOwner(checkpoint.petId, req.user!);
    await removeCheckpoint(checkpoint.id);
    await audit(req.user!.id, 'vaccination.checkpoint_remove', 'vaccination_checkpoint', checkpoint.id, {
      petId: checkpoint.petId,
    });
    res.status(204).send();
  }),
);
