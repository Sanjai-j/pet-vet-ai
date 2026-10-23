import { many, one } from '../db.js';
import { config } from '../config.js';
import { daysBetween, parseJson, todayInTz } from '../util.js';
import { careForPet } from './care.js';
import { monthsBetween } from './vaccine-schedule.js';

/**
 * Everything the owner has recorded about one pet, as short factual lines.
 *
 * The AI needs this for questions it can only answer from the record —
 * "when is Bruno's rabies booster due?", "what did we weigh Luna last month?",
 * "which care tasks are done today?". It is deliberately *facts only*: no
 * interpretation, no diagnosis, no clinical claim. Clinical answers still have
 * to come from approved reference sources (see services/ai.ts).
 */

export interface PetRecordFacts {
  petId: string;
  name: string;
  speciesCode: string;
  /** species, breed, age, sex, weight, vet of record */
  profile: string[];
  /** conditions, allergies, medications, diet restrictions */
  medical: string[];
  /** vaccination records on file */
  vaccinations: string[];
  /** pending and recently completed checkpoints */
  checkpoints: string[];
  /** today's care plan */
  care: string[];
  /** recent logged weights */
  weight: string[];
  /** next/recent appointments */
  appointments: string[];
  hasRecords: boolean;
}

interface PetRecordRow {
  name: string;
  speciesCode: string;
  speciesName: string;
  breedName: string | null;
  customBreed: string | null;
  birthDate: string | null;
  ageEstimateMonths: number | null;
  sex: string | null;
  weightKg: string | null;
  weightMeasuredOn: string | null;
  conditions: string | null;
  allergies: string | null;
  medications: string | null;
  dietaryRestrictions: string | null;
  feedingNotes: string | null;
  activityLevel: string | null;
  currentVetName: string | null;
  currentVetClinic: string | null;
}

function clean(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text ? text : null;
}

function ageLabel(birthDate: string | null, estimatedMonths: number | null): string {
  if (birthDate) {
    const months = monthsBetween(birthDate, todayInTz());
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const age = years >= 1
      ? `${years} year${years === 1 ? '' : 's'}${rest ? ` ${rest} month${rest === 1 ? '' : 's'}` : ''}`
      : `${months} month${months === 1 ? '' : 's'}`;
    return `about ${age} old (born ${birthDate})`;
  }
  if (estimatedMonths != null) {
    const years = Math.floor(estimatedMonths / 12);
    return years >= 1
      ? `about ${years} year${years === 1 ? '' : 's'} (owner estimate, no birth date on file)`
      : `about ${estimatedMonths} months (owner estimate, no birth date on file)`;
  }
  return 'age not recorded';
}

function dueLabel(dueOn: string, today: string): string {
  const days = daysBetween(today, dueOn);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
}

export async function loadPetRecordFacts(petId: string): Promise<PetRecordFacts | null> {
  const today = todayInTz();
  const pet = await one<PetRecordRow>(
    `SELECT p.name, p.species_code AS "speciesCode", s.name AS "speciesName",
            b.name AS "breedName", p.custom_breed AS "customBreed",
            p.birth_date::text AS "birthDate", p.age_estimate_months AS "ageEstimateMonths",
            p.sex, p.weight_kg::text AS "weightKg", p.weight_measured_on::text AS "weightMeasuredOn",
            p.conditions, p.allergies, p.medications,
            p.dietary_restrictions AS "dietaryRestrictions",
            p.feeding_notes AS "feedingNotes", p.activity_level AS "activityLevel",
            p.current_vet_name AS "currentVetName", p.current_vet_clinic AS "currentVetClinic"
     FROM pets p
     JOIN species s ON s.code = p.species_code
     LEFT JOIN breeds b ON b.id = p.breed_id
     WHERE p.id = $1`,
    [petId],
  );
  if (!pet) return null;

  const [vaccinations, checkpoints, weights, appointments, care] = await Promise.all([
    many<{ vaccineName: string; administeredOn: string | null; nextDueOn: string | null; source: string }>(
      `SELECT vaccine_name AS "vaccineName", administered_on::text AS "administeredOn",
              next_due_on::text AS "nextDueOn", source
       FROM vaccinations WHERE pet_id = $1
       ORDER BY administered_on DESC NULLS LAST, created_at DESC LIMIT 8`,
      [petId],
    ),
    many<{ vaccineName: string; dueOn: string; status: string; completedOn: string | null }>(
      `SELECT vaccine_name AS "vaccineName", due_on::text AS "dueOn", status,
              completed_on::text AS "completedOn"
       FROM vaccination_checkpoints
       WHERE pet_id = $1 AND status IN ('pending', 'done')
       ORDER BY (status = 'pending') DESC, due_on LIMIT 10`,
      [petId],
    ),
    many<{ value: unknown; on: string }>(
      `SELECT value, (logged_at AT TIME ZONE $2)::date::text AS on
       FROM care_logs WHERE pet_id = $1 AND type = 'weight'
       ORDER BY logged_at DESC LIMIT 3`,
      [petId, config.timezone],
    ),
    many<{ scheduledFor: string; status: string; mode: string; vetName: string }>(
      `SELECT to_char(a.scheduled_for AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS "scheduledFor",
              a.status, a.mode, u.full_name AS "vetName"
       FROM appointments a JOIN users u ON u.id = a.vet_id
       WHERE a.pet_id = $1 AND a.scheduled_for > now() - interval '30 days'
       ORDER BY a.scheduled_for LIMIT 3`,
      [petId, config.timezone],
    ),
    careForPet(petId, today),
  ]);

  const todayCare = care.tasks;

  const facts: PetRecordFacts = {
    petId,
    name: pet.name,
    speciesCode: pet.speciesCode,
    profile: [],
    medical: [],
    vaccinations: [],
    checkpoints: [],
    care: [],
    weight: [],
    appointments: [],
    hasRecords: false,
  };

  const breed = clean(pet.breedName) ?? clean(pet.customBreed);
  facts.profile.push(
    `${pet.speciesName}${breed ? ` · ${breed}` : ''}${pet.sex && pet.sex !== 'unknown' ? ` · ${pet.sex}` : ''} · ${ageLabel(pet.birthDate, pet.ageEstimateMonths)}`,
  );
  if (pet.weightKg) {
    facts.profile.push(
      `Weight ${Number(pet.weightKg).toFixed(1)} kg${pet.weightMeasuredOn ? ` (measured ${pet.weightMeasuredOn})` : ''}`,
    );
  }
  if (clean(pet.activityLevel)) facts.profile.push(`Activity level: ${pet.activityLevel}`);
  if (clean(pet.currentVetName) || clean(pet.currentVetClinic)) {
    facts.profile.push(
      `Veterinarian of record: ${[clean(pet.currentVetName), clean(pet.currentVetClinic)].filter(Boolean).join(', ')}`,
    );
  }

  if (clean(pet.conditions)) facts.medical.push(`Recorded conditions: ${clean(pet.conditions)}`);
  if (clean(pet.allergies)) facts.medical.push(`Allergies: ${clean(pet.allergies)}`);
  if (clean(pet.medications)) facts.medical.push(`Current medications: ${clean(pet.medications)}`);
  if (clean(pet.dietaryRestrictions)) facts.medical.push(`Dietary restrictions: ${clean(pet.dietaryRestrictions)}`);
  if (clean(pet.feedingNotes)) facts.medical.push(`Feeding notes: ${clean(pet.feedingNotes)}`);

  for (const v of vaccinations) {
    const who = v.source === 'vet_recorded' ? 'vet-recorded' : v.source === 'demo' ? 'demo record' : 'owner-reported';
    const given = v.administeredOn ? `given ${v.administeredOn}` : 'date not recorded';
    const next = v.nextDueOn ? `, next due ${v.nextDueOn}` : '';
    facts.vaccinations.push(`${v.vaccineName} — ${given}${next} (${who})`);
  }

  for (const c of checkpoints) {
    if (c.status === 'pending') {
      facts.checkpoints.push(`${c.vaccineName} — ${c.dueOn} (${dueLabel(c.dueOn, today)}, pending)`);
    } else if (c.completedOn) {
      facts.checkpoints.push(`${c.vaccineName} — done ${c.completedOn}`);
    }
  }

  if (todayCare.length) {
    const done = todayCare.filter((t) => t.completed).length;
    const list = todayCare.slice(0, 5).map((t) => {
      const times = (t.times ?? []).join('/');
      return `${t.title}${times ? ` ${times}` : ''}${t.completed ? ' ✓' : ''}`;
    });
    facts.care.push(`Today (${today}): ${done} of ${todayCare.length} care task(s) done — ${list.join(', ')}`);
  } else {
    facts.care.push(`Today (${today}): no care tasks scheduled`);
  }

  for (const w of weights) {
    const value = parseJson<{ weightKg?: number }>(w.value, {});
    if (typeof value.weightKg === 'number') {
      facts.weight.push(`${value.weightKg.toFixed(1)} kg on ${w.on}`);
    }
  }

  for (const a of appointments) {
    facts.appointments.push(`${a.scheduledFor} — ${a.mode === 'video' ? 'video consult' : 'in-person visit'}, ${a.status}, with ${a.vetName}`);
  }

  facts.hasRecords = Boolean(
    facts.vaccinations.length ||
      facts.checkpoints.length ||
      facts.weight.length ||
      facts.appointments.length ||
      todayCare.length ||
      facts.medical.length,
  );
  return facts;
}

/** Compact record block for the LLM system prompt. */
export function recordPromptBlock(facts: PetRecordFacts): string {
  const section = (heading: string, lines: string[]) => (lines.length ? `${heading}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '');
  return [
    `Pet record from the owner's account (${facts.name}) — factual data, not clinical evidence:`,
    section('Profile', facts.profile),
    section('Medical notes recorded by the owner', facts.medical),
    section('Vaccination records', facts.vaccinations),
    section('Vaccination checkpoints', facts.checkpoints),
    section('Care plan', facts.care),
    section('Weight log', facts.weight),
    section('Appointments', facts.appointments),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2400);
}

const TOPICS: Array<{ test: RegExp; pick: Array<keyof PetRecordFacts> }> = [
  { test: /vaccin|booster|jab|shot|rabies|dose|due\b|schedul|record/i, pick: ['vaccinations', 'checkpoints'] },
  { test: /weight|weigh|\bkg\b|thin|obese|overweight|underweight|gain|lost|lose/i, pick: ['weight', 'profile'] },
  { test: /appointment|visit|consult|book|slot/i, pick: ['appointments'] },
  { test: /care|walk|groom|routine|remind|task|plan today/i, pick: ['care'] },
  { test: /eat|food|diet|meal|appetite|feed|allerg/i, pick: ['medical', 'care'] },
  { test: /condition|medic|tablet|health history|diagnos/i, pick: ['medical'] },
];

/**
 * The record lines that are actually relevant to the question. Returning
 * nothing for an unrelated symptom question keeps the answer focused on the
 * approved reference material.
 */
export function relevantRecordLines(facts: PetRecordFacts, message: string): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const topic of TOPICS) {
    if (!topic.test.test(message)) continue;
    for (const key of topic.pick) {
      for (const line of facts[key] as string[]) {
        if (seen.has(line)) continue;
        seen.add(line);
        picked.push(line);
      }
    }
  }
  return picked.slice(0, 6);
}
