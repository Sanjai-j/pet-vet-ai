import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound, parse } from '../errors.js';
import { getDb, many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { PET_COLUMNS, assertPetOwner, loadPet } from '../access.js';
import { audit } from '../audit.js';

export const petsRouter = Router();
petsRouter.use(requireAuth);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const petBody = z.object({
  name: z.string().min(1, 'Name is required').max(60),
  speciesCode: z.enum(['dog', 'cat', 'bird', 'cow', 'goat', 'other']),
  breedId: z.string().max(120).nullable().optional(),
  customBreed: z.string().max(120).nullable().optional(),
  birthDate: dateString.nullable().optional(),
  ageEstimateMonths: z.number().int().min(0).max(600).nullable().optional(),
  sex: z.enum(['male', 'female', 'unknown']).nullable().optional(),
  weightKg: z.number().positive().max(1500).nullable().optional(),
  weightMeasuredOn: dateString.nullable().optional(),
  activityLevel: z.enum(['low', 'moderate', 'high', 'unknown']).nullable().optional(),
  livingEnvironment: z.string().max(200).nullable().optional(),
  lifestyle: z.string().max(120).nullable().optional(),
  feedingNotes: z.string().max(2000).nullable().optional(),
  foodPreferences: z.string().max(1000).nullable().optional(),
  dietaryRestrictions: z.string().max(1000).nullable().optional(),
  allergies: z.string().max(1000).nullable().optional(),
  conditions: z.string().max(2000).nullable().optional(),
  medications: z.string().max(1000).nullable().optional(),
  lastGroomingOn: dateString.nullable().optional(),
  currentVetName: z.string().max(120).nullable().optional(),
  currentVetClinic: z.string().max(200).nullable().optional(),
  photoFileId: z.string().max(80).nullable().optional(),
  isHouseholdPet: z.boolean().nullable().optional(),
});

async function validateSpeciesAndBreed(speciesCode: string, breedId?: string | null) {
  const species = await one<{ code: string; category: string; is_active: boolean }>(
    'SELECT code, category, is_active FROM species WHERE code = $1',
    [speciesCode],
  );
  if (!species || !species.is_active) throw badRequest('Choose a supported species');
  if (breedId) {
    const breed = await one<{ id: string; species_code: string }>(
      'SELECT id, species_code FROM breeds WHERE id = $1 AND is_active = true',
      [breedId],
    );
    if (!breed) throw badRequest('That breed is not in the catalog');
    if (breed.species_code !== speciesCode) throw badRequest('Breed does not belong to the selected species');
  }
  return species;
}

petsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    let where = 'p.owner_id = $1';
    const params: unknown[] = [user.id];
    if (user.role === 'admin') {
      where = '1 = 1';
      params.length = 0;
    }
    if (user.role === 'vet') {
      where =
        `EXISTS (SELECT 1 FROM appointments a WHERE a.pet_id = p.id AND a.vet_id = $1 AND a.status IN ('accepted','completed'))
         OR EXISTS (SELECT 1 FROM threads t WHERE t.pet_id = p.id AND t.vet_id = $1)`;
    }
    const pets = await many(
      `SELECT ${PET_COLUMNS}, u.full_name AS "ownerName",
        (SELECT count(*)::int FROM care_tasks ct WHERE ct.pet_id = p.id AND ct.is_active) AS "careTaskCount",
        (SELECT count(*)::int FROM vaccinations v WHERE v.pet_id = p.id AND v.next_due_on IS NOT NULL AND v.next_due_on <= current_date + 30) AS "upcomingVaccinations"
       FROM pets p
       JOIN species s ON s.code = p.species_code
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN breeds b ON b.id = p.breed_id
       WHERE ${where}
       ORDER BY p.created_at`,
      params,
    );
    res.json({ pets });
  }),
);

petsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if (user.role !== 'owner' && user.role !== 'admin') throw badRequest('Only pet owners can add pets');
    const body = parse(petBody, req.body);
    await validateSpeciesAndBreed(body.speciesCode, body.breedId);

    if (body.photoFileId) {
      const file = await one('SELECT id, owner_id FROM files WHERE id = $1', [body.photoFileId]);
      if (!file || (file.owner_id !== user.id && user.role !== 'admin')) {
        throw badRequest('Profile photo not found');
      }
    }

    const petId = crypto.randomUUID();
    await (await getDb()).query(
      `INSERT INTO pets (
        id, owner_id, name, species_code, breed_id, custom_breed, birth_date, age_estimate_months,
        sex, weight_kg, weight_measured_on, activity_level, living_environment, lifestyle,
        feeding_notes, food_preferences, dietary_restrictions, allergies, conditions, medications,
        last_grooming_on, current_vet_name, current_vet_clinic, photo_file_id, is_household_pet
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        petId, user.id, body.name.trim(), body.speciesCode, body.breedId ?? null,
        body.customBreed ?? null, body.birthDate ?? null, body.ageEstimateMonths ?? null,
        body.sex ?? 'unknown', body.weightKg ?? null, body.weightMeasuredOn ?? null,
        body.activityLevel ?? 'unknown', body.livingEnvironment ?? null, body.lifestyle ?? null,
        body.feedingNotes ?? null, body.foodPreferences ?? null, body.dietaryRestrictions ?? null,
        body.allergies ?? null, body.conditions ?? null, body.medications ?? null,
        body.lastGroomingOn ?? null, body.currentVetName ?? null, body.currentVetClinic ?? null,
        body.photoFileId ?? null, body.isHouseholdPet ?? null,
      ],
    );
    if (body.photoFileId) {
      await (await getDb()).query('UPDATE files SET pet_id = $1, purpose = $2 WHERE id = $3', [petId, 'pet_photo', body.photoFileId]);
    }
    await audit(user.id, 'pet.create', 'pet', petId, { species: body.speciesCode });
    const pet = await one(
      `SELECT ${PET_COLUMNS} FROM pets p JOIN species s ON s.code = p.species_code
       LEFT JOIN breeds b ON b.id = p.breed_id WHERE p.id = $1`,
      [petId],
    );
    res.status(201).json({ pet });
  }),
);

petsRouter.get(
  '/:petId',
  asyncHandler(async (req, res) => {
    const pet = await loadPet(req.params.petId, req.user!);
    const vaccinations = await many(
      `SELECT id, vaccine_name AS "vaccineName", administered_on AS "administeredOn",
              next_due_on AS "nextDueOn", batch_number AS "batchNumber", notes,
              source, recorded_by AS "recordedBy", created_at AS "createdAt"
       FROM vaccinations WHERE pet_id = $1 ORDER BY administered_on DESC NULLS LAST`,
      [pet.id],
    );
    const careTasks = await many(
      `SELECT id, type, title, instructions, frequency, times, due_date AS "dueDate",
              is_active AS "isActive"
       FROM care_tasks WHERE pet_id = $1 ORDER BY type, title`,
      [pet.id],
    );
    const recentLogs = await many(
      `SELECT l.id, l.type, l.value, l.notes, l.logged_at AS "loggedAt", l.task_id AS "taskId",
              u.full_name AS "loggedByName"
       FROM care_logs l LEFT JOIN users u ON u.id = l.logged_by
       WHERE l.pet_id = $1 ORDER BY l.logged_at DESC LIMIT 30`,
      [pet.id],
    );
    const sharedWith = await many(
      `SELECT DISTINCT u.id, u.full_name AS "fullName", v.clinic_name AS "clinicName"
       FROM appointments a JOIN users u ON u.id = a.vet_id
       LEFT JOIN vet_profiles v ON v.user_id = u.id
       WHERE a.pet_id = $1 AND a.status IN ('accepted','completed')`,
      [pet.id],
    );
    res.json({ pet, vaccinations, careTasks, recentLogs, sharedWith });
  }),
);

petsRouter.patch(
  '/:petId',
  asyncHandler(async (req, res) => {
    await assertPetOwner(req.params.petId, req.user!);
    const body = parse(petBody.partial(), req.body);
    const current = await one<Record<string, unknown>>('SELECT * FROM pets WHERE id = $1', [req.params.petId]);
    if (!current) throw notFound('Pet not found');
    const speciesCode = (body.speciesCode ?? current.species_code) as string;
    const breedId = body.breedId !== undefined ? body.breedId : (current.breed_id as string | null);
    await validateSpeciesAndBreed(speciesCode, breedId);

    const merged: Record<string, unknown> = {
      name: body.name?.trim() ?? current.name,
      species_code: speciesCode,
      breed_id: breedId,
      custom_breed: body.customBreed !== undefined ? body.customBreed : current.custom_breed,
      birth_date: body.birthDate !== undefined ? body.birthDate : current.birth_date,
      age_estimate_months: body.ageEstimateMonths !== undefined ? body.ageEstimateMonths : current.age_estimate_months,
      sex: body.sex !== undefined ? body.sex : current.sex,
      weight_kg: body.weightKg !== undefined ? body.weightKg : current.weight_kg,
      weight_measured_on: body.weightMeasuredOn !== undefined ? body.weightMeasuredOn : current.weight_measured_on,
      activity_level: body.activityLevel !== undefined ? body.activityLevel : current.activity_level,
      living_environment: body.livingEnvironment !== undefined ? body.livingEnvironment : current.living_environment,
      lifestyle: body.lifestyle !== undefined ? body.lifestyle : current.lifestyle,
      feeding_notes: body.feedingNotes !== undefined ? body.feedingNotes : current.feeding_notes,
      food_preferences: body.foodPreferences !== undefined ? body.foodPreferences : current.food_preferences,
      dietary_restrictions: body.dietaryRestrictions !== undefined ? body.dietaryRestrictions : current.dietary_restrictions,
      allergies: body.allergies !== undefined ? body.allergies : current.allergies,
      conditions: body.conditions !== undefined ? body.conditions : current.conditions,
      medications: body.medications !== undefined ? body.medications : current.medications,
      last_grooming_on: body.lastGroomingOn !== undefined ? body.lastGroomingOn : current.last_grooming_on,
      current_vet_name: body.currentVetName !== undefined ? body.currentVetName : current.current_vet_name,
      current_vet_clinic: body.currentVetClinic !== undefined ? body.currentVetClinic : current.current_vet_clinic,
      photo_file_id: body.photoFileId !== undefined ? body.photoFileId : current.photo_file_id,
      is_household_pet: body.isHouseholdPet !== undefined ? body.isHouseholdPet : current.is_household_pet,
    };

    await (await getDb()).query(
      `UPDATE pets SET name=$1, species_code=$2, breed_id=$3, custom_breed=$4, birth_date=$5,
        age_estimate_months=$6, sex=$7, weight_kg=$8, weight_measured_on=$9, activity_level=$10,
        living_environment=$11, lifestyle=$12, feeding_notes=$13, food_preferences=$14,
        dietary_restrictions=$15, allergies=$16, conditions=$17, medications=$18, last_grooming_on=$19,
        current_vet_name=$20, current_vet_clinic=$21, photo_file_id=$22, is_household_pet=$23,
        updated_at=now()
       WHERE id=$24`,
      [
        merged.name, merged.species_code, merged.breed_id, merged.custom_breed, merged.birth_date,
        merged.age_estimate_months, merged.sex, merged.weight_kg, merged.weight_measured_on,
        merged.activity_level, merged.living_environment, merged.lifestyle, merged.feeding_notes,
        merged.food_preferences, merged.dietary_restrictions, merged.allergies, merged.conditions,
        merged.medications, merged.last_grooming_on, merged.current_vet_name, merged.current_vet_clinic,
        merged.photo_file_id, merged.is_household_pet, req.params.petId,
      ],
    );
    await audit(req.user!.id, 'pet.update', 'pet', req.params.petId);
    const pet = await one(
      `SELECT ${PET_COLUMNS} FROM pets p JOIN species s ON s.code = p.species_code
       LEFT JOIN breeds b ON b.id = p.breed_id WHERE p.id = $1`,
      [req.params.petId],
    );
    res.json({ pet });
  }),
);

petsRouter.delete(
  '/:petId',
  asyncHandler(async (req, res) => {
    await assertPetOwner(req.params.petId, req.user!);
    await (await getDb()).query('DELETE FROM pets WHERE id = $1', [req.params.petId]);
    await audit(req.user!.id, 'pet.delete', 'pet', req.params.petId);
    res.status(204).send();
  }),
);

const vaccinationBody = z.object({
  vaccineName: z.string().min(1).max(120),
  administeredOn: dateString.nullable().optional(),
  nextDueOn: dateString.nullable().optional(),
  batchNumber: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

petsRouter.post(
  '/:petId/vaccinations',
  asyncHandler(async (req, res) => {
    const pet = await loadPet(req.params.petId, req.user!);
    const body = parse(vaccinationBody, req.body);
    if (body.administeredOn && body.nextDueOn && body.nextDueOn < body.administeredOn) {
      throw badRequest('Next due date cannot be before the administered date');
    }
    const id = crypto.randomUUID();
    const source = req.user!.role === 'vet' ? 'vet_recorded' : 'owner_reported';
    await (await getDb()).query(
      `INSERT INTO vaccinations (id, pet_id, vaccine_name, administered_on, next_due_on, batch_number, notes, source, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, pet.id, body.vaccineName, body.administeredOn ?? null, body.nextDueOn ?? null, body.batchNumber ?? null, body.notes ?? null, source, req.user!.id],
    );
    await audit(req.user!.id, 'vaccination.create', 'vaccination', id, { petId: pet.id, source });
    const vaccination = await one(
      `SELECT id, vaccine_name AS "vaccineName", administered_on AS "administeredOn", next_due_on AS "nextDueOn",
              batch_number AS "batchNumber", notes, source, recorded_by AS "recordedBy"
       FROM vaccinations WHERE id = $1`,
      [id],
    );
    res.status(201).json({ vaccination });
  }),
);

petsRouter.delete(
  '/:petId/vaccinations/:vaccinationId',
  asyncHandler(async (req, res) => {
    await loadPet(req.params.petId, req.user!);
    const vax = await one<{ pet_id: string; source: string }>(
      'SELECT pet_id, source FROM vaccinations WHERE id = $1',
      [req.params.vaccinationId],
    );
    if (!vax || vax.pet_id !== req.params.petId) throw notFound('Vaccination record not found');
    if (req.user!.role === 'owner' && vax.source === 'vet_recorded') {
      throw badRequest('Vaccination records added by a veterinarian cannot be removed by an owner');
    }
    await (await getDb()).query('DELETE FROM vaccinations WHERE id = $1', [req.params.vaccinationId]);
    res.status(204).send();
  }),
);
