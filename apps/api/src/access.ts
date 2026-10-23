import type { AuthUser } from './auth.js';
import { forbidden, notFound } from './errors.js';
import { one } from './db.js';

export interface PetRow {
  id: string;
  ownerId: string;
  name: string;
  speciesCode: string;
  speciesName: string;
  speciesIcon: string;
  breedName?: string | null;
  ageEstimateMonths?: number | null;
  weightKg?: number | string | null;
  conditions?: string | null;
  allergies?: string | null;
  dietaryRestrictions?: string | null;
  medications?: string | null;
  breedId?: string | null;
  customBreed?: string | null;
}

export const PET_COLUMNS = `
  p.id, p.owner_id AS "ownerId", p.name, p.species_code AS "speciesCode",
  s.name AS "speciesName", s.icon AS "speciesIcon", s.category AS "speciesCategory",
  p.breed_id AS "breedId", b.name AS "breedName", p.custom_breed AS "customBreed",
  p.birth_date AS "birthDate", p.age_estimate_months AS "ageEstimateMonths", p.sex,
  p.weight_kg AS "weightKg", p.weight_measured_on AS "weightMeasuredOn",
  p.activity_level AS "activityLevel", p.living_environment AS "livingEnvironment",
  p.lifestyle, p.feeding_notes AS "feedingNotes", p.food_preferences AS "foodPreferences",
  p.dietary_restrictions AS "dietaryRestrictions", p.allergies, p.conditions, p.medications,
  p.last_grooming_on AS "lastGroomingOn", p.current_vet_name AS "currentVetName",
  p.current_vet_clinic AS "currentVetClinic", p.photo_file_id AS "photoFileId",
  p.is_household_pet AS "isHouseholdPet", p.created_at AS "createdAt", p.updated_at AS "updatedAt"
`;

export async function loadPet(petId: string, user: AuthUser): Promise<PetRow> {
  const pet = await one<PetRow>(
    `SELECT ${PET_COLUMNS} FROM pets p
     JOIN species s ON s.code = p.species_code
     LEFT JOIN breeds b ON b.id = p.breed_id
     WHERE p.id = $1`,
    [petId],
  );
  if (!pet) throw notFound('Pet not found');

  if (user.role === 'admin' || pet.ownerId === user.id) return pet;

  if (user.role === 'vet') {
    const shared = await one<{ ok: number }>(
      `SELECT 1 AS ok FROM appointments
       WHERE pet_id = $1 AND vet_id = $2 AND status IN ('accepted', 'completed')
       LIMIT 1`,
      [petId, user.id],
    );
    if (shared) return pet;
    const thread = await one<{ ok: number }>(
      'SELECT 1 AS ok FROM threads WHERE pet_id = $1 AND vet_id = $2 LIMIT 1',
      [petId, user.id],
    );
    if (thread) return pet;
  }
  throw forbidden('This pet record has not been shared with you');
}

export async function assertPetOwner(petId: string, user: AuthUser): Promise<PetRow> {
  const pet = await loadPet(petId, user);
  if (user.role !== 'admin' && pet.ownerId !== user.id) {
    throw forbidden('Only the pet owner can make this change');
  }
  return pet;
}

export function requireOwnerOrAdmin(user: AuthUser | undefined): AuthUser {
  if (!user) throw forbidden();
  if (user.role !== 'owner' && user.role !== 'admin') {
    throw forbidden('This action is available to pet owners');
  }
  return user;
}
