import { hashPassword } from '../src/auth.js';
import { insertRow as insert } from '../src/seed.js';
import { addDays, todayInTz } from '../src/util.js';

/**
 * Test-only fixtures: the synthetic people, pets, clinics and records the API
 * tests exercise. This is deliberately NOT part of the production seed — a real
 * deployment starts with reference catalogs only, so no demo doctor, patient
 * or clinic ever reaches a live site.
 *
 * Load it after `seed()` in a test's `before` hook.
 */
const DEMO_PASSWORD = 'Demo@1234';
export const DEMO_LOGIN_PASSWORD = DEMO_PASSWORD;

// [id, name, address, city, state, pincode, lat, lng, services, hours, isDemo, is24x7]
const CLINICS = [
  ['clinic_blr_indiranagar', 'Demo — Indiranagar 24×7 Pet Hospital', '100 Feet Road, Indiranagar (synthetic demo address)', 'Bengaluru', 'Karnataka', '560038', 12.9719, 77.6412, ['Emergency', 'Surgery', 'Diagnostics', 'Dentistry'], 'Open 24 hours (demo)', true, true],
  ['clinic_blr_koramangala', 'Demo — Koramangala Veterinary Centre', '80 Feet Road, Koramangala (synthetic demo address)', 'Bengaluru', 'Karnataka', '560034', 12.9352, 77.6245, ['General practice', 'Vaccination', 'Grooming'], 'Mon–Sat 09:00–20:00 (demo)', true, false],
  ['clinic_del_south', 'Demo — South Delhi Pet Care', 'Synthetic demo address, Greater Kailash', 'New Delhi', 'Delhi', '110048', 28.5494, 77.2424, ['General practice', 'Dermatology', 'Diagnostics'], 'Mon–Sun 10:00–19:00 (demo)', true, false],
  ['clinic_mum_bandra', 'Demo — Bandra Animal Clinic', 'Synthetic demo address, Bandra West', 'Mumbai', 'Maharashtra', '400050', 19.0596, 72.8295, ['General practice', 'Emergency', 'Surgery'], 'Open 24 hours (demo)', true, true],
  ['clinic_pune_kothrud', 'Demo — Kothrud Vet Polyclinic', 'Synthetic demo address, Kothrud', 'Pune', 'Maharashtra', '411038', 18.5074, 73.8077, ['General practice', 'Vaccination', 'Nutrition'], 'Mon–Sat 09:30–20:30 (demo)', true, false],
];

export async function seedTestFixtures(): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const commonUser = {
    password_hash: passwordHash,
    role: 'owner',
    state: 'Karnataka',
    city: 'Bengaluru',
    notification_prefs: { feeding: false, grooming: false, vaccination: false, email: false, push: false, inApp: true },
    privacy: { shareRecordsWithVet: true, allowAiTraining: false },
  };

  await insert('users', { id: 'usr_admin', email: 'admin@petvetai.demo', full_name: 'Demo Administrator', ...commonUser, role: 'admin' });
  await insert('users', { id: 'usr_owner', email: 'priya@petvetai.demo', full_name: 'Priya Sharma', phone: '+91 90000 00000 (demo)', ...commonUser });
  await insert('users', { id: 'usr_vet_verified', email: 'dr.arjun@petvetai.demo', full_name: 'Dr. Arjun Rao', role: 'vet', state: 'Karnataka', city: 'Bengaluru', password_hash: passwordHash });
  await insert('users', { id: 'usr_vet_pending', email: 'dr.meera@petvetai.demo', full_name: 'Dr. Meera Nair', role: 'vet', state: 'Maharashtra', city: 'Mumbai', password_hash: passwordHash });

  await insert('vet_profiles', {
    user_id: 'usr_vet_verified',
    license_number: 'DEMO-KA-VET-0001',
    council: 'Demo State Veterinary Council (synthetic)',
    experience_years: 9,
    bio: 'Demo veterinarian profile. Small-animal medicine and dermatology. Synthetic profile used for product demonstration.',
    clinic_name: 'Demo — Indiranagar 24×7 Pet Hospital',
    clinic_address: '100 Feet Road, Indiranagar (synthetic demo address)',
    city: 'Bengaluru', state: 'Karnataka', pincode: '560038',
    latitude: 12.9719, longitude: 77.6412,
    specialties: ['Dermatology', 'Internal medicine', 'Preventive care'],
    species: ['dog', 'cat'],
    availability: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], slots: ['10:00', '11:00', '12:00', '17:00', '18:00', '19:00'] },
    consultation_fee_inr: 600,
    verification_status: 'verified',
    verification_notes: 'Synthetic demo verification. Not a real credential.',
    verified_at: new Date().toISOString(),
  }, { species: 'text[]', specialties: 'text[]', availability: 'jsonb' });

  await insert('vet_profiles', {
    user_id: 'usr_vet_pending',
    license_number: 'DEMO-MH-VET-0002',
    council: 'Demo State Veterinary Council (synthetic)',
    experience_years: 5,
    bio: 'Demo veterinarian profile awaiting verification. Synthetic profile used to demonstrate the admin review workflow.',
    clinic_name: 'Demo — Bandra Animal Clinic',
    clinic_address: 'Synthetic demo address, Bandra West',
    city: 'Mumbai', state: 'Maharashtra', pincode: '400050',
    latitude: 19.0596, longitude: 72.8295,
    specialties: ['General practice', 'Emergency care'],
    species: ['dog', 'cat'],
    availability: { days: ['Mon', 'Wed', 'Fri'], slots: ['10:00', '16:00', '18:00'] },
    consultation_fee_inr: 500,
    verification_status: 'pending',
    profile_status: 'submitted',
  }, { species: 'text[]', specialties: 'text[]', availability: 'jsonb' });

  // ── Directory demo data ───────────────────────────────────────
  // One application waiting for review, so the admin queue is not empty.
  await insert('vet_applications', {
    id: 'app_demo_pending',
    vet_user_id: 'usr_vet_pending',
    status: 'submitted',
    summary: 'BVSc & AH · 5 years experience (synthetic demo credential pack)',
    document_ids: [],
  }, { document_ids: 'jsonb' });

  // A clinic link a veterinarian asked for; nothing is linked until reviewed.
  await insert('clinic_associations', {
    id: 'assoc_demo_indiranagar',
    vet_user_id: 'usr_vet_verified',
    place_id: 'demo_clinic_blr_indiranagar',
    clinic_name: 'Demo — Indiranagar 24×7 Pet Hospital',
    evidence: 'Synthetic demo request used to show the association review workflow.',
    status: 'pending',
  });

  // Bookable availability for the verified veterinarian: weekday mornings and
  // early evenings for the next three weeks.
  const demoSlotTimes = ['10:00', '11:00', '17:00'];
  const slotStart = todayInTz();
  let slotSeq = 0;
  for (let offset = 1; offset <= 21; offset += 1) {
    const date = addDays(slotStart, offset);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0) continue; // Sunday off
    for (const start of demoSlotTimes) {
      const [h, m] = start.split(':').map(Number);
      const end = `${String(h).padStart(2, '0')}:${String(m + 30).padStart(2, '0')}`;
      slotSeq += 1;
      await insert('vet_slots', {
        id: `slot_demo_${slotSeq}`,
        vet_user_id: 'usr_vet_verified',
        slot_date: date,
        start_time: start,
        end_time: end,
        consultation_type: h < 12 ? 'video' : 'in_person',
        status: 'available',
      });
    }
  }

  const pets = [
    { id: 'pet_bruno', name: 'Bruno', species: 'dog', breed: 'breed_dog_labrador_retriever', birth: '2022-03-15', age: 52, sex: 'male', weight: 28.5, activity: 'moderate', environment: 'Apartment in Bengaluru', lifestyle: 'indoor_outdoor', feeding: 'Two measured meals a day; occasional plain chicken treat.', preferences: 'Chicken, rice', restrictions: 'No known food allergies', conditions: 'No known conditions', medications: '', grooming: todayInTz(), household: true, vet: 'Dr. Arjun Rao (demo)', clinic: 'Demo — Indiranagar 24×7 Pet Hospital' },
    { id: 'pet_luna', name: 'Luna', species: 'cat', breed: 'breed_cat_domestic_shorthair_indian_indie', birth: '2023-01-10', age: 44, sex: 'female', weight: 4.2, activity: 'moderate', environment: 'Apartment in Bengaluru', lifestyle: 'indoor', feeding: 'Two small meals and fresh water; no milk.', preferences: 'Wet food', restrictions: 'Lactose intolerant', conditions: '', medications: '', grooming: null, household: true, vet: 'Dr. Arjun Rao (demo)', clinic: 'Demo — Indiranagar 24×7 Pet Hospital' },
    { id: 'pet_kiwi', name: 'Kiwi', species: 'bird', breed: 'breed_bird_budgerigar_budgie', birth: null, age: 24, sex: 'male', weight: null, activity: 'high', environment: 'Indoor aviary corner, Bengaluru', lifestyle: 'indoor', feeding: 'Seed mix plus sprouted grains; working towards formulated pellets.', preferences: 'Millet spray', restrictions: '', conditions: '', medications: '', grooming: null, household: true, vet: null, clinic: null },
    { id: 'pet_gauri', name: 'Gauri', species: 'cow', breed: 'breed_cow_gir', birth: '2021-07-01', age: 62, sex: 'female', weight: 320, activity: 'moderate', environment: 'Family farm near Mysuru', lifestyle: 'outdoor', feeding: 'Green fodder and dry fodder twice daily; gradual seasonal transitions.', preferences: 'Green fodder', restrictions: '', conditions: '', medications: '', grooming: null, household: false, vet: 'Local large-animal veterinarian (demo)', clinic: null },
    { id: 'pet_chhotu', name: 'Chhotu', species: 'goat', breed: 'breed_goat_jamunapari', birth: '2024-02-20', age: 30, sex: 'male', weight: 38, activity: 'high', environment: 'Family farm near Mysuru', lifestyle: 'outdoor', feeding: 'Fodder and clean water twice daily.', preferences: 'Fodder, leaves', restrictions: '', conditions: '', medications: '', grooming: null, household: false, vet: 'Local large-animal veterinarian (demo)', clinic: null },
  ];

  for (const p of pets) {
    await insert('pets', {
      id: p.id, owner_id: 'usr_owner', name: p.name, species_code: p.species, breed_id: p.breed,
      custom_breed: null, birth_date: p.birth, age_estimate_months: p.age, sex: p.sex,
      weight_kg: p.weight, weight_measured_on: p.weight != null ? todayInTz() : null,
      activity_level: p.activity, living_environment: p.environment, lifestyle: p.lifestyle,
      feeding_notes: p.feeding, food_preferences: p.preferences, dietary_restrictions: p.restrictions,
      conditions: p.conditions, medications: p.medications, last_grooming_on: p.grooming,
      is_household_pet: p.household, current_vet_name: p.vet, current_vet_clinic: p.clinic,
    });
  }

  const today = todayInTz();
  const yesterday = addDays(today, -1);

  const careTasks: Array<[string, string, string, string, string, string, string[], number]> = [
    ['task_bruno_walk', 'pet_bruno', 'walk', 'Morning walk', '20–30 minutes at a comfortable pace; avoid peak heat.', 'daily', ['06:30'], 20],
    ['task_bruno_breakfast', 'pet_bruno', 'feeding', 'Breakfast', 'Measured portion of complete dog food. Fresh water alongside.', 'daily', ['07:30'], 10],
    ['task_bruno_water', 'pet_bruno', 'water', 'Refresh water bowls', 'Wash bowls and refill with clean water.', 'daily', ['09:00'], 5],
    ['task_bruno_dinner', 'pet_bruno', 'feeding', 'Dinner', 'Measured evening portion. Avoid table scraps.', 'daily', ['19:00'], 10],
    ['task_bruno_groom', 'pet_bruno', 'grooming', 'Brush coat and skin check', 'Brush coat and check for ticks, lumps and ear discharge.', 'weekly', ['10:00'], 30],
    ['task_luna_breakfast', 'pet_luna', 'feeding', 'Breakfast', 'Small measured portion of complete cat food.', 'daily', ['08:00'], 10],
    ['task_luna_water', 'pet_luna', 'water', 'Fresh water', 'Refresh water and clean the bowl.', 'daily', ['12:00'], 5],
    ['task_luna_play', 'pet_luna', 'walk', 'Play session', 'Interactive play with a wand toy for 10–15 minutes.', 'daily', ['18:30'], 10],
    ['task_luna_litter', 'pet_luna', 'other', 'Scoop litter tray', 'Scoop and check for changes in urination.', 'daily', ['20:00'], 10],
    ['task_kiwi_food', 'pet_kiwi', 'feeding', 'Fresh seed and sprouts', 'Replace seed mix and add sprouted grains.', 'daily', ['07:00'], 10],
    ['task_kiwi_water', 'pet_kiwi', 'water', 'Change water', 'Change water and clean the drinker.', 'daily', ['07:05'], 5],
    ['task_kiwi_cage', 'pet_kiwi', 'grooming', 'Cage clean', 'Replace cage liner and check perches.', 'weekly', ['11:00'], 30],
    ['task_gauri_feed', 'pet_gauri', 'feeding', 'Fodder and water check', 'Green and dry fodder; check water trough.', 'daily', ['06:00'], 10],
    ['task_gauri_water', 'pet_gauri', 'water', 'Trough cleaning', 'Clean the water trough and refill.', 'daily', ['12:00'], 10],
    ['task_chhotu_feed', 'pet_chhotu', 'feeding', 'Fodder', 'Fodder and clean water; observe appetite.', 'daily', ['07:00'], 10],
  ];

  for (const t of careTasks) {
    await insert('care_tasks', {
      id: t[0], pet_id: t[1], type: t[2], title: t[3], instructions: t[4],
      frequency: t[5], times: t[6], is_active: true, created_by: 'usr_owner',
    }, { times: 'jsonb' });
  }

  await insert('care_logs', {
    id: 'log_demo_1', pet_id: 'pet_bruno', task_id: 'task_bruno_breakfast', type: 'feeding',
    value: { amount: '1 bowl', food: 'Complete dog food' }, notes: 'Finished the full portion.',
    logged_by: 'usr_owner', logged_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
  }, { value: 'jsonb' });
  await insert('care_logs', {
    id: 'log_demo_2', pet_id: 'pet_bruno', task_id: 'task_bruno_walk', type: 'walk',
    value: { duration_minutes: 25 }, notes: 'Normal energy, slight heat later in the walk.',
    logged_by: 'usr_owner', logged_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
  }, { value: 'jsonb' });
  await insert('care_logs', {
    id: 'log_demo_3', pet_id: 'pet_luna', task_id: 'task_luna_litter', type: 'observation',
    value: { note: 'Urine clumps normal size' }, notes: 'No straining observed.',
    logged_by: 'usr_owner', logged_at: new Date(Date.now() - 12 * 3600_000).toISOString(),
  }, { value: 'jsonb' });

  const vaccinations: Array<[string, string, string, string, string | null, string, string]> = [
    ['vax_bruno_rabies', 'pet_bruno', 'Rabies', addDays(today, -350), addDays(today, 15), 'demo', 'Demo record — confirm with your veterinarian.'],
    ['vax_bruno_dhpp', 'pet_bruno', 'DHPP booster', addDays(today, -420), addDays(today, 7), 'demo', 'Demo record — next due date is illustrative.'],
    ['vax_luna_fvrcp', 'pet_luna', 'FVRCP booster', addDays(today, -200), addDays(today, 165), 'demo', 'Demo record — confirm schedule with your veterinarian.'],
    ['vax_kiwi_none', 'pet_kiwi', 'No vaccination record', yesterday, null, 'demo', 'Demo record — avian vaccination needs are species-specific.'],
  ];
  for (const v of vaccinations) {
    await insert('vaccinations', {
      id: v[0], pet_id: v[1], vaccine_name: v[2], administered_on: v[3],
      next_due_on: v[4], source: v[5], notes: v[6], recorded_by: 'usr_owner',
    });
  }

  for (const c of CLINICS) {
    await insert('clinics', {
      id: c[0], name: c[1], address: c[2], city: c[3], state: c[4], pincode: c[5],
      latitude: c[6], longitude: c[7], services: c[8], hours: c[9],
      is_demo: c[10], is_24x7: c[11], verified: false,
    }, { services: 'text[]' });
  }

  const tomorrow = addDays(today, 1);
  await insert('appointments', {
    id: 'appt_demo_1', owner_id: 'usr_owner', vet_id: 'usr_vet_verified', pet_id: 'pet_bruno',
    scheduled_for: `${tomorrow}T12:30:00.000Z`, mode: 'video',
    reason: 'Demo appointment: recurring itchiness on the paws. Synthetic record.',
    status: 'accepted', response_note: 'Accepted for the product demo.',
  });
  await insert('appointments', {
    id: 'appt_demo_2', owner_id: 'usr_owner', vet_id: 'usr_vet_verified', pet_id: 'pet_luna',
    scheduled_for: `${addDays(today, 3)}T10:00:00.000Z`, mode: 'in_person',
    reason: 'Demo appointment: routine weight and dental check. Synthetic record.',
    status: 'pending',
  });

  await insert('threads', {
    id: 'thread_demo_1', owner_id: 'usr_owner', vet_id: 'usr_vet_verified',
    pet_id: 'pet_bruno', appointment_id: 'appt_demo_1', last_message_at: new Date().toISOString(),
  });
  await insert('messages', {
    id: 'msg_demo_1', thread_id: 'thread_demo_1', sender_id: 'usr_vet_verified',
    body: 'Hello Priya — this is a demo conversation for Bruno. The account, clinic and veterinarian are synthetic demo data.',
    created_at: new Date(Date.now() - 3600_000).toISOString(),
  });

  await insert('notifications', {
    id: 'notif_demo_1', user_id: 'usr_owner', title: 'Welcome to Pet Vet AI (demo)',
    body: 'This account uses synthetic demo data. AI guidance is general information, not a diagnosis.',
    kind: 'info', link: '/dashboard',
  });
}
