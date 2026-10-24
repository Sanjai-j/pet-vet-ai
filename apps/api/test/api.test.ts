import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Force the embedded test database even when a root .env points the API at
// a real PostgreSQL server — tests must never touch the developer's data.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg';
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';
process.env.UPLOAD_DIR = '.data/test-uploads';
// Never call OpenStreetMap from tests: the keyless fallback is exercised
// through its "switched off" contract instead of live network traffic.
process.env.OVERPASS_ENABLED = 'false';

fs.rmSync(path.join(root, '.data/test-pg'), { recursive: true, force: true });
fs.rmSync(path.join(root, '.data/test-uploads'), { recursive: true, force: true });

let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};
let owner2Token = '';
let petId = '';

async function call(
  route: string,
  options: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${route}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  const { migrate } = await import('../src/migrate.js');
  const { seed } = await import('../src/seed.js');
  const { seedTestFixtures } = await import('./fixtures.js');
  const { createApp } = await import('../src/app.js');
  await migrate();
  await seed();
  // The production seed ships reference catalogs only; the synthetic people,
  // pets and clinics these tests exercise live in test/fixtures.ts.
  await seedTestFixtures();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;

  for (const [role, email] of [
    ['owner', 'priya@petvetai.demo'],
    ['vet', 'dr.arjun@petvetai.demo'],
    ['pendingVet', 'dr.meera@petvetai.demo'],
    ['admin', 'admin@petvetai.demo'],
  ] as const) {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email, password: 'Demo@1234' },
    });
    assert.equal(res.status, 200, `login ${role}`);
    tokens[role] = res.data.token;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

test('species and breed catalogs are species-scoped', async () => {
  const species = await call('/species');
  assert.equal(species.status, 200);
  assert.equal(species.data.species.length, 6);

  const dogBreeds = await call('/species/dog/breeds?q=lab');
  assert.equal(dogBreeds.status, 200);
  assert.ok(dogBreeds.data.breeds.some((b: any) => b.name === 'Labrador Retriever'));

  const catBreeds = await call('/species/cat/breeds');
  assert.ok(catBreeds.data.breeds.some((b: any) => b.name === 'Persian'));
  assert.ok(catBreeds.data.breeds.some((b: any) => b.isUnknown));
  assert.ok(!catBreeds.data.breeds.some((b: any) => b.name === 'Labrador Retriever'));
});

test('registration, login and role protection', async () => {
  const created = await call('/auth/register', {
    method: 'POST',
    body: {
      email: 'second.owner@example.test',
      password: 'StrongPass123',
      fullName: 'Second Owner',
      role: 'owner',
    },
  });
  assert.equal(created.status, 201);
  owner2Token = created.data.token;
  assert.equal(created.data.user.role, 'owner');

  const duplicate = await call('/auth/register', {
    method: 'POST',
    body: { email: 'second.owner@example.test', password: 'StrongPass123', fullName: 'Dup' },
  });
  assert.equal(duplicate.status, 409);

  const wrong = await call('/auth/login', {
    method: 'POST',
    body: { email: 'second.owner@example.test', password: 'wrong-password' },
  });
  assert.equal(wrong.status, 401);

  const forbidden = await call('/admin/stats', { token: owner2Token });
  assert.equal(forbidden.status, 403);

  const roleEscalation = await call('/auth/register', {
    method: 'POST',
    body: { email: 'evil@example.test', password: 'StrongPass123', fullName: 'Evil', role: 'admin' },
  });
  assert.equal(roleEscalation.status, 400);
});

test('owner can add a pet with unknown breed and skip optional fields', async () => {
  const created = await call('/pets', {
    method: 'POST',
    token: owner2Token,
    body: {
      name: 'Mochi',
      speciesCode: 'cat',
      customBreed: 'Rescued Indie mix',
      sex: 'unknown',
    },
  });
  assert.equal(created.status, 201);
  petId = created.data.pet.id;
  assert.equal(created.data.pet.breedId, null);
  assert.equal(created.data.pet.customBreed, 'Rescued Indie mix');

  const mismatch = await call('/pets', {
    method: 'POST',
    token: owner2Token,
    body: { name: 'Bad', speciesCode: 'dog', breedId: 'breed_cat_persian' },
  });
  assert.equal(mismatch.status, 400);

  const list = await call('/pets', { token: owner2Token });
  assert.equal(list.data.pets.length, 1);
});

test('private pet records and admin routes are protected server-side', async () => {
  const pet = await call('/pets/pet_bruno', { token: owner2Token });
  assert.equal(pet.status, 403);

  const dashboard = await call('/dashboard', { token: owner2Token });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.pets.length, 1);

  const stats = await call('/admin/stats', { token: tokens.admin });
  assert.equal(stats.status, 200);
  assert.ok(stats.data.stats.users >= 4);
});

test('feeding reminders stay off until the owner opts in', async () => {
  const { runReminderTick } = await import('../src/services/scheduler.js');
  const atBreakfast = new Date('2026-10-20T02:00:00.000Z'); // 07:30 Asia/Kolkata
  const before = await runReminderTick(atBreakfast);
  assert.equal(before.care, 0, 'no reminder should be created without opt-in');

  const prefs = await call('/auth/me/notifications', {
    method: 'PATCH',
    token: tokens.owner,
    body: { feeding: true },
  });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.data.notificationPrefs.feeding, true);

  const after = await runReminderTick(atBreakfast);
  assert.equal(after.care, 1, 'one breakfast reminder after opt-in');

  const notifications = await call('/notifications', { token: tokens.owner });
  assert.ok(notifications.data.notifications.some((n: any) => n.title.includes('Breakfast — Bruno')));

  const reminders = await call('/reminders', { token: tokens.owner });
  assert.ok(reminders.data.reminders.some((r: any) => r.title.includes('Breakfast — Bruno')));
});

test('emergency rules take priority and cite approved sources', async () => {
  const res = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_bruno', message: 'Bruno ate chocolate cookies an hour ago' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.reply.emergency.ruleId, 'chocolate');
  assert.equal(res.data.reply.capability.status, 'limited');
  assert.ok(res.data.reply.citations.length > 0);
  assert.ok(res.data.reply.answer.includes('not a diagnosis'));

  const cat = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_luna', message: 'Luna keeps straining to urinate and crying in the litter box' },
  });
  assert.equal(cat.data.reply.emergency.ruleId, 'urinary_cat');
});

test('unsupported species and medication questions fail transparently', async () => {
  const bird = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_kiwi', message: 'Kiwi has a lump on the wing. What disease is it?' },
  });
  assert.equal(bird.status, 201);
  assert.equal(bird.data.reply.capability.status, 'not_supported');
  assert.match(bird.data.reply.answer, /don't have validated guidance/i);
  assert.equal(bird.data.reply.citations.length, 0);

  const meds = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_bruno', message: 'What dose of paracetamol should I give Bruno?' },
  });
  assert.equal(meds.data.reply.capability.status, 'not_supported');
  assert.ok(!/\d+\s?mg/i.test(meds.data.reply.answer), 'must not invent a dose');
});

test('food safety distinguishes toxic, unknown and unsupported species', async () => {
  const chocolate = await call('/food-safety?species=dog&q=chocolate');
  assert.equal(chocolate.status, 200);
  assert.equal(chocolate.data.matches[0].safety, 'toxic');

  const unknown = await call('/food-safety?species=dog&q=dragonfruit');
  assert.equal(unknown.data.matches.length, 0);
  assert.match(unknown.data.note, /does not mean safe/i);

  const bird = await call('/food-safety?species=bird&q=dragonfruit');
  assert.equal(bird.data.matches.length, 0);
  assert.equal(bird.data.coverageKnown, true, 'bird dataset exists but is small');

  const other = await call('/food-safety?species=other&q=dragonfruit');
  assert.equal(other.data.coverageKnown, false, 'no curated dataset for other species');
});

test('unreviewed knowledge cannot be retrieved until an administrator approves it', async () => {
  const question = 'Bruno is stiff. How can I monitor osteoarthritis mobility at home?';
  const before = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_bruno', message: question },
  });
  assert.equal(before.status, 201);
  assert.ok(!before.data.reply.citations.some((c: any) => c.documentId === 'kd_pending_arthritis'));

  const approved = await call('/admin/knowledge/kd_pending_arthritis', {
    method: 'PATCH',
    token: tokens.admin,
    body: { status: 'approved', reviewNotes: 'Approved for the technical test fixture.' },
  });
  assert.equal(approved.status, 200);

  const after = await call('/ai/chat', {
    method: 'POST',
    token: tokens.owner,
    body: { petId: 'pet_bruno', message: question },
  });
  assert.ok(after.data.reply.citations.some((c: any) => c.documentId === 'kd_pending_arthritis'));
});

test('unverified veterinarians cannot take bookings; verification unblocks the directory', async () => {
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const blocked = await call('/appointments', {
    method: 'POST',
    token: tokens.owner,
    body: {
      petId: 'pet_bruno',
      vetId: 'usr_vet_pending',
      scheduledFor: future,
      mode: 'video',
      reason: 'Demo booking attempt before verification.',
    },
  });
  assert.equal(blocked.status, 400);

  const verify = await call('/admin/vets/usr_vet_pending/verification', {
    method: 'PATCH',
    token: tokens.admin,
    body: { status: 'verified', notes: 'Synthetic demo verification for test.' },
  });
  assert.equal(verify.status, 200);

  const directory = await call('/providers');
  assert.ok(directory.data.veterinarians.some((v: any) => v.id === 'usr_vet_pending'));
});

test('appointment acceptance creates a private thread and vet notes', async () => {
  const future = new Date(Date.now() + 4 * 86_400_000).toISOString();
  const created = await call('/appointments', {
    method: 'POST',
    token: tokens.owner,
    body: {
      petId: 'pet_bruno',
      vetId: 'usr_vet_verified',
      scheduledFor: future,
      mode: 'video',
      reason: 'Recurring paw itching for a demo consultation.',
    },
  });
  assert.equal(created.status, 201);
  const appointmentId = created.data.appointment.id;

  const accepted = await call(`/appointments/${appointmentId}/status`, {
    method: 'PATCH',
    token: tokens.vet,
    body: { status: 'accepted', note: 'Accepted for demo.' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.appointment.status, 'accepted');

  const threads = await call('/threads', { token: tokens.owner });
  const thread = threads.data.threads.find((t: any) => t.vetId === 'usr_vet_verified' && t.petId === 'pet_bruno');
  assert.ok(thread);

  const intruder = await call(`/threads/${thread.id}`, { token: owner2Token });
  assert.equal(intruder.status, 403);

  const note = await call(`/appointments/${appointmentId}/notes`, {
    method: 'POST',
    token: tokens.vet,
    body: {
      notes: 'Demo consultation note. Mild pododermatitis suspected; needs examination.',
      carePlan: 'Keep paws dry and book a follow-up if itching persists.',
      followUpOn: '2026-11-10',
    },
  });
  assert.equal(note.status, 201);

  const detail = await call(`/appointments/${appointmentId}`, { token: tokens.owner });
  assert.equal(detail.data.notes.length, 1);
});

test('uploaded files are private to the owner and sharing participants', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake png bytes')], { type: 'image/png' }), 'pet.png');
  form.append('purpose', 'record');
  form.append('petId', 'pet_bruno');

  const upload = await fetch(`${base}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.owner}` },
    body: form,
  });
  assert.equal(upload.status, 201);
  const file = (await upload.json()) as any;

  const own = await fetch(`${base}/files/${file.file.id}`, {
    headers: { authorization: `Bearer ${tokens.owner}` },
  });
  assert.equal(own.status, 200);

  const other = await fetch(`${base}/files/${file.file.id}`, {
    headers: { authorization: `Bearer ${owner2Token}` },
  });
  assert.equal(other.status, 403);
});

// ── Veterinary discovery & verified directory ────────────────────

/**
 * A freshly registered veterinarian is unapproved until an administrator
 * reviews them. Earlier tests approve the seeded pending vet, so these tests
 * create their own applicant instead of depending on seed state.
 */
async function registerPendingVet(email: string, licenseNumber: string) {
  const res = await call('/auth/register', {
    method: 'POST',
    body: {
      email,
      password: 'Demo@1234',
      fullName: 'Dr. Unverified Applicant',
      role: 'vet',
      city: 'Pune',
      state: 'Maharashtra',
      vet: { licenseNumber, council: 'Demo Council', species: ['dog'] },
    },
  });
  assert.equal(res.status, 201, `register ${email}`);
  return { token: res.data.token as string, id: res.data.user.id as string };
}

test('map config never exposes the server key and names the nearby provider', async () => {
  const res = await call('/maps/config', { token: tokens.owner });
  assert.equal(res.status, 200);
  assert.equal(res.data.placesConfigured, false);
  // OpenStreetMap is switched off in this environment, so the endpoint says so.
  assert.equal(res.data.nearbyProvider, 'disabled');
  assert.equal(res.data.setupMessage.includes('OVERPASS_ENABLED'), true);
  const serialized = JSON.stringify(res.data);
  assert.equal(serialized.includes('apiKey'), false);
});

test('map search requires a signed-in user', async () => {
  const anon = await call('/maps/clinics?city=Bengaluru');
  assert.equal(anon.status, 401);
});

test('with every hospital source off, clinic discovery reports it instead of inventing rows', async () => {
  const res = await call('/maps/clinics?city=Bengaluru', { token: tokens.owner });
  assert.equal(res.status, 200);
  assert.equal(res.data.source, 'none');
  assert.equal(res.data.configured, false);
  assert.deepEqual(res.data.clinics, []);
  assert.equal(res.data.attribution, null);
  assert.equal(res.data.notice.includes('OVERPASS_ENABLED'), true);
});

test('map usage diagnostics are administrator-only', async () => {
  const denied = await call('/maps/usage', { token: tokens.owner });
  assert.equal(denied.status, 404);
  const allowed = await call('/maps/usage', { token: tokens.admin });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.data.usage));
});

test('the public directory lists only approved veterinarians', async () => {
  const applicant = await registerPendingVet('dr.unlisted@petvetai.test', 'TEST-GA-1001');

  const res = await call('/directory/vets', { token: tokens.owner });
  assert.equal(res.status, 200);
  const ids = res.data.veterinarians.map((v: any) => v.id);
  assert.ok(ids.includes('usr_vet_verified'));
  assert.equal(ids.includes(applicant.id), false, 'unreviewed vets must stay hidden');
  assert.equal(res.data.veterinarians.every((v: any) => v.verified === true), true);
  assert.ok(res.data.notice.includes('not a verification'));

  const hidden = await call(`/directory/vets/${applicant.id}`, { token: tokens.owner });
  assert.equal(hidden.status, 404);
});

test('unverified veterinarians cannot be booked', async () => {
  const applicant = await registerPendingVet('dr.unbookable@petvetai.test', 'TEST-GA-1002');

  const res = await call('/appointments', {
    method: 'POST',
    token: tokens.owner,
    body: {
      petId: 'pet_bruno',
      vetId: applicant.id,
      scheduledFor: new Date(Date.now() + 7 * 86400_000).toISOString(),
      reason: 'Bruno has been scratching his ears for three days',
    },
  });
  assert.equal(res.status, 400);
  assert.ok(res.data.error.message.toLowerCase().includes('not been verified'));
});

test('slot booking holds the slot and prevents double booking', async () => {
  const slotDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const created = await call('/vet/slots', {
    method: 'POST',
    token: tokens.vet,
    body: { slots: [{ slotDate, startTime: '09:00', endTime: '09:30', consultationType: 'video' }] },
  });
  assert.equal(created.status, 201);

  const listed = await call(`/slots?vetId=usr_vet_verified&from=${slotDate}&to=${slotDate}`, {
    token: tokens.owner,
  });
  assert.equal(listed.status, 200);
  const slot = listed.data.slots.find((s: any) => s.startTime === '09:00');
  assert.ok(slot, 'the new slot should be listed');
  assert.equal(slot.slotDate, slotDate, 'slot dates are plain YYYY-MM-DD strings');

  const booking = await call('/appointments', {
    method: 'POST',
    token: tokens.owner,
    body: {
      petId: 'pet_bruno',
      vetId: 'usr_vet_verified',
      slotId: slot.id,
      mode: 'video',
      reason: 'Bruno limps on his front left leg since yesterday',
    },
  });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.appointment.status, 'pending');

  const duplicate = await call('/appointments', {
    method: 'POST',
    token: tokens.owner,
    body: {
      petId: 'pet_bruno',
      vetId: 'usr_vet_verified',
      slotId: slot.id,
      mode: 'video',
      reason: 'Trying to take the same slot twice',
    },
  });
  assert.equal(duplicate.status, 409);

  const open = await call(`/slots?vetId=usr_vet_verified&from=${slotDate}&to=${slotDate}`, {
    token: tokens.owner,
  });
  assert.equal(open.data.slots.some((s: any) => s.id === slot.id), false, 'booked slots leave the open list');

  // Cancelling gives the slot back to other owners.
  const cancelled = await call(`/appointments/${booking.data.appointment.id}/status`, {
    method: 'PATCH',
    token: tokens.owner,
    body: { status: 'cancelled' },
  });
  assert.equal(cancelled.status, 200);

  const released = await call(`/slots?vetId=usr_vet_verified&from=${slotDate}&to=${slotDate}`, {
    token: tokens.owner,
  });
  assert.ok(released.data.slots.some((s: any) => s.id === slot.id), 'cancelling releases the slot');
});

test('a veterinarian application is reviewed by an administrator before listing', async () => {
  const register = await call('/auth/register', {
    method: 'POST',
    body: {
      email: 'dr.new@petvetai.test',
      password: 'Demo@1234',
      fullName: 'Dr. New Applicant',
      role: 'vet',
      city: 'Pune',
      state: 'Maharashtra',
      vet: { licenseNumber: 'TEST-MH-9001', council: 'Demo Council', species: ['dog'] },
    },
  });
  assert.equal(register.status, 201);
  const vetToken = register.data.token;
  const applicationBody = {
    professionalName: 'Dr. New Applicant',
    phone: '+91 90000 11111',
    licenseNumber: 'TEST-MH-9001',
    registrationAuthority: 'Demo State Veterinary Council',
    qualification: 'BVSc & AH',
    specialization: ['Dentistry'],
    species: ['dog', 'cat'],
    languages: ['English', 'Marathi'],
    experienceYears: 6,
    city: 'Pune',
    state: 'Maharashtra',
    consultationTypes: ['in_person', 'video'],
    consultationFeeInr: 400,
    bio: 'Synthetic applicant used by the automated test suite.',
    documentIds: [],
  };

  const application = await call('/directory/applications', {
    method: 'POST', token: vetToken, body: applicationBody,
  });
  assert.equal(application.status, 201);

  const duplicate = await call('/directory/applications', {
    method: 'POST', token: vetToken, body: applicationBody,
  });
  assert.equal(duplicate.status, 409, 'one open application at a time');

  const queue = await call('/directory/admin/applications?status=submitted', { token: tokens.admin });
  const queued = queue.data.applications.find((a: any) => a.id === application.data.applicationId);
  assert.ok(queued, 'the admin queue shows the new application');

  const notAdmin = await call(`/directory/admin/applications/${application.data.applicationId}/transition`, {
    method: 'POST', token: tokens.owner, body: { action: 'approved' },
  });
  assert.equal(notAdmin.status, 403);

  const review = await call(`/directory/admin/applications/${application.data.applicationId}/transition`, {
    method: 'POST', token: tokens.admin,
    body: { action: 'under_review', notes: 'Checking registration details.' },
  });
  assert.equal(review.status, 200);

  const approve = await call(`/directory/admin/applications/${application.data.applicationId}/transition`, {
    method: 'POST', token: tokens.admin, body: { action: 'approved', notes: 'Demo approval.' },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.verificationStatus, 'verified');

  const directory = await call('/directory/vets?city=Pune', { token: tokens.owner });
  const published = directory.data.veterinarians.find((v: any) => v.fullName === 'Dr. New Applicant');
  assert.ok(published, 'approval publishes the profile in the directory');

  const slots = await call(`/slots?vetId=${published.id}`, { token: tokens.owner });
  assert.equal(slots.status, 200, 'an approved vet is bookable');
});
test('clinic association requests are gated on verification and reviewed by admins', async () => {
  const applicant = await registerPendingVet('dr.unlinked@petvetai.test', 'TEST-GA-1003');

  const denied = await call('/directory/associations', {
    method: 'POST', token: applicant.token,
    body: { placeId: 'test_place_1', clinicName: 'Unverified Clinic' },
  });
  assert.equal(denied.status, 403);

  const requested = await call('/directory/associations', {
    method: 'POST', token: tokens.vet,
    body: { placeId: 'test_place_2', clinicName: 'Test Clinic', evidence: 'Practice manager confirmed.' },
  });
  assert.equal(requested.status, 201);

  const queue = await call('/directory/admin/associations', { token: tokens.admin });
  const pending = queue.data.associations.find((a: any) => a.id === requested.data.id);
  assert.ok(pending);
  assert.equal(pending.status, 'pending');

  const approved = await call(`/directory/admin/associations/${requested.data.id}/transition`, {
    method: 'POST', token: tokens.admin, body: { action: 'approved' },
  });
  assert.equal(approved.status, 200);

  const again = await call(`/directory/admin/associations/${requested.data.id}/transition`, {
    method: 'POST', token: tokens.admin, body: { action: 'approved' },
  });
  assert.equal(again.status, 400, 'a reviewed association cannot be reviewed twice');
});

// ── Vaccination schedule checkpoints ─────────────────────────

function shiftDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test('adult pets get reference rows but no invented vaccination due dates', async () => {
  const plan = await call('/pets/pet_bruno/vaccination-plan', { token: tokens.owner });
  assert.equal(plan.status, 200);
  assert.ok(plan.data.reference.length >= 2, 'approved dog schedule rows are returned');
  const rabies = plan.data.reference.find((row: any) => row.vaccineName === 'Rabies');
  assert.ok(rabies, 'rabies row present');
  assert.equal(plan.data.canGenerate, false, 'an adult pet past the primary series cannot be auto-scheduled');
  assert.match(plan.data.message, /primary-series window/i);

  const generate = await call('/pets/pet_bruno/vaccination-plan/generate', {
    method: 'POST', token: tokens.owner, body: {},
  });
  assert.equal(generate.status, 200);
  assert.equal(generate.data.created, 0, 'no date is invented for an adult with unknown history');
});

test('puppy checkpoints are generated, marked done, rescheduled and reminded', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const birthDate = shiftDays(today, -49); // seven weeks old
  const created = await call('/pets', {
    method: 'POST', token: tokens.owner,
    body: { name: 'Coco', speciesCode: 'dog', birthDate, sex: 'female' },
  });
  assert.equal(created.status, 201);
  const dogId = created.data.pet.id;

  const plan = await call(`/pets/${dogId}/vaccination-plan`, { token: tokens.owner });
  assert.equal(plan.status, 200);
  assert.equal(plan.data.canGenerate, true);
  assert.equal(plan.data.checkpoints.length, 0);

  const generated = await call(`/pets/${dogId}/vaccination-plan/generate`, {
    method: 'POST', token: tokens.owner, body: {},
  });
  assert.equal(generated.status, 200);
  assert.ok(generated.data.created >= 3, 'primary series and rabies checkpoints are created');
  const core = generated.data.checkpoints.filter((cp: any) => cp.vaccineName.startsWith('Canine core combination'));
  assert.ok(core.length >= 2, 'the primary series creates repeated doses');
  const firstCore = core.find((cp: any) => cp.dueOn === shiftDays(birthDate, 42));
  assert.ok(firstCore, 'first core dose falls at six weeks of age');
  const rabies = generated.data.checkpoints.find((cp: any) => cp.vaccineName === 'Rabies');
  assert.ok(rabies, 'rabies checkpoint exists');
  assert.equal(rabies.dueOn, shiftDays(birthDate, 84), 'rabies checkpoint falls at twelve weeks of age');

  const again = await call(`/pets/${dogId}/vaccination-plan/generate`, {
    method: 'POST', token: tokens.owner, body: {},
  });
  assert.equal(again.data.created, 0, 'generation is idempotent');

  const target = generated.data.checkpoints[0];
  const done = await call(`/vaccination-checkpoints/${target.id}/done`, {
    method: 'POST', token: tokens.owner, body: {},
  });
  assert.equal(done.status, 200);
  const pet = await call(`/pets/${dogId}`, { token: tokens.owner });
  assert.ok(
    pet.data.vaccinations.some((v: any) => v.vaccineName === target.vaccineName && v.source === 'owner_reported'),
    'marking done writes a normal owner-reported vaccination record',
  );
  const completed = done.data.checkpoints.find((cp: any) => cp.id === target.id);
  assert.equal(completed.status, 'done');

  const added = await call(`/pets/${dogId}/vaccination-checkpoints`, {
    method: 'POST', token: tokens.owner,
    body: { vaccineName: 'Rabies booster', dueOn: shiftDays(today, 30) },
  });
  assert.equal(added.status, 201);
  const checkpointId = added.data.checkpoint.id;

  const moved = await call(`/vaccination-checkpoints/${checkpointId}`, {
    method: 'PATCH', token: tokens.owner, body: { dueOn: shiftDays(today, 2) },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.checkpoint.dueOn, shiftDays(today, 2));

  const intruder = await call(`/vaccination-checkpoints/${checkpointId}`, {
    method: 'PATCH', token: owner2Token, body: { dueOn: shiftDays(today, 5) },
  });
  assert.equal(intruder.status, 403, 'another owner cannot move the date');

  // No reminder until the owner opts in; then it fires on the moved date.
  await call('/auth/me/notifications', { method: 'PATCH', token: tokens.owner, body: { vaccination: true } });
  const { runReminderTick } = await import('../src/services/scheduler.js');
  const tick = await runReminderTick(new Date(`${shiftDays(today, 2)}T03:30:00.000Z`)); // 09:00 Asia/Kolkata
  assert.ok(tick.checkpoints >= 1, 'the reminder worker sends checkpoint reminders');
  const notifications = await call('/notifications', { token: tokens.owner });
  assert.ok(notifications.data.notifications.some((n: any) => n.title.includes('Vaccination due — Coco')));

  const removed = await call(`/vaccination-checkpoints/${checkpointId}`, { method: 'DELETE', token: tokens.owner });
  assert.equal(removed.status, 204);
  const afterRemoval = await call(`/pets/${dogId}/vaccination-plan`, { token: tokens.owner });
  assert.equal(afterRemoval.data.checkpoints.some((cp: any) => cp.id === checkpointId), false);
});

test('imported vaccination schedules stay inert until an administrator approves them', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const kid = await call('/pets', {
    method: 'POST', token: tokens.owner,
    body: { name: 'Kid', speciesCode: 'goat', birthDate: shiftDays(today, -90) },
  });
  assert.equal(kid.status, 201);
  const kidId = kid.data.pet.id;

  const { getDb } = await import('../src/db.js');
  const db = await getDb();
  const pendingId = 'vaxs_test_pending';
  await db.query(
    `INSERT INTO vaccine_schedules
       (id, species_code, species_label, vaccine_key, vaccine_name, first_dose_age_text,
        first_dose_age_days, primary_series_text, booster_interval_text, booster_interval_months,
        guidance_level, auto_assignable, reference_basis, status)
     VALUES ($1,'goat','Goat','ppr_test','PPR (peste des petits ruminants)',
             'Common reference: around 3 months; confirm current state campaign/product', null,
             'Product and current campaign protocol',
             'ICAR reference describes protection for about 3 years', null,
             'programme_only', false, 'ICAR', 'pending')`,
    [pendingId],
  );

  const before = await call(`/pets/${kidId}/vaccination-plan`, { token: tokens.owner });
  assert.equal(before.status, 200);
  assert.equal(before.data.reference.some((row: any) => row.id === pendingId), false, 'pending rows are not served');

  const generate = await call(`/pets/${kidId}/vaccination-plan/generate`, {
    method: 'POST', token: tokens.owner, body: {},
  });
  assert.equal(generate.data.created, 0, 'a pending row never schedules anything');

  const queue = await call('/admin/vaccine-schedules?status=pending', { token: tokens.admin });
  assert.ok(queue.data.schedules.some((row: any) => row.id === pendingId));

  const denied = await call(`/admin/vaccine-schedules/${pendingId}`, {
    method: 'PATCH', token: tokens.owner, body: { status: 'approved' },
  });
  assert.equal(denied.status, 403);

  const approved = await call(`/admin/vaccine-schedules/${pendingId}`, {
    method: 'PATCH', token: tokens.admin,
    body: { status: 'approved', reviewNotes: 'Reviewed in the test suite.' },
  });
  assert.equal(approved.status, 200);

  const after = await call(`/pets/${kidId}/vaccination-plan`, { token: tokens.owner });
  const approvedRow = after.data.reference.find((row: any) => row.id === pendingId);
  assert.ok(approvedRow, 'approved rows appear as reference');
  assert.equal(approvedRow.autoAssignable, false, 'a programme-only row still never auto-schedules');
});

// ── AI record grounding + vaccination knowledge mirror ──────

test('the AI answers date questions from the pet record, with the schedule cited', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const birthDate = shiftDays(today, -70); // ten weeks old
  const created = await call('/pets', {
    method: 'POST', token: tokens.owner,
    body: { name: 'Pixie', speciesCode: 'cat', birthDate, sex: 'female' },
  });
  assert.equal(created.status, 201);
  const catId = created.data.pet.id;

  const generated = await call(`/pets/${catId}/vaccination-plan/generate`, {
    method: 'POST', token: tokens.owner, body: {},
  });
  const rabies = generated.data.checkpoints.find((cp: any) => cp.vaccineName === 'Rabies');
  assert.ok(rabies, 'a kitten inside the primary-series window gets a rabies checkpoint');

  const answer = await call('/ai/chat', {
    method: 'POST', token: tokens.owner,
    body: { petId: catId, message: "When is Pixie's rabies vaccination due?" },
  });
  assert.equal(answer.status, 201);
  assert.match(answer.data.reply.answer, /From your records:/, 'the record block is used');
  assert.ok(answer.data.reply.answer.includes(rabies.dueOn), 'the exact checkpoint date is quoted');
  assert.match(answer.data.reply.answer, /not a diagnosis|general information/i);
  assert.ok(
    answer.data.reply.citations.some((c: any) => c.documentId.startsWith('vax_')),
    'the approved schedule row is citable',
  );
});

test('record data never leaks into an unsupported medication answer', async () => {
  const answer = await call('/ai/chat', {
    method: 'POST', token: tokens.owner,
    body: { petId: 'pet_bruno', message: 'What dose of paracetamol should I give Bruno?' },
  });
  assert.equal(answer.data.reply.capability.status, 'not_supported');
  assert.doesNotMatch(answer.data.reply.answer, /From your records:/);
  assert.ok(!/\d+\s?mg/i.test(answer.data.reply.answer));
});

test('approving a schedule row publishes it to the knowledge index; re-queueing removes it', async () => {
  const { many } = await import('../src/db.js');
  const rows = await many<{ id: string }>(
    `SELECT id FROM vaccine_schedules WHERE status = 'approved' ORDER BY id`,
  );
  assert.ok(rows.length >= 2, 'seeded dog and cat rows are approved');
  const docs = await many<{ id: string }>(
    `SELECT id FROM knowledge_documents WHERE category = 'vaccination'`,
  );
  assert.ok(
    docs.some((d) => d.id === `vax_${rows[0].id}`),
    'every approved row has a mirrored knowledge document',
  );

  const scheduleId = 'vaxs_test_pending';
  const approved = await call(`/admin/vaccine-schedules/${scheduleId}`, {
    method: 'PATCH', token: tokens.admin, body: { status: 'approved' },
  });
  assert.equal(approved.status, 200);
  const afterApproval = await many<{ id: string }>(
    `SELECT id FROM knowledge_documents WHERE id = $1`, [`vax_${scheduleId}`],
  );
  assert.equal(afterApproval.length, 1, 'approval mirrors the row');

  const requeued = await call(`/admin/vaccine-schedules/${scheduleId}`, {
    method: 'PATCH', token: tokens.admin, body: { status: 'pending' },
  });
  assert.equal(requeued.status, 200);
  const afterRequeue = await many<{ id: string }>(
    `SELECT id FROM knowledge_documents WHERE id = $1`, [`vax_${scheduleId}`],
  );
  assert.equal(afterRequeue.length, 0, 'an unreviewed row is not citable again');
});

test('a reset link is single-use and replaces the password', async () => {
  const { issueResetToken } = await import('../src/services/password-reset.js');
  const { one } = await import('../src/db.js');

  // An address with no account answers exactly like a real one. In tests no
  // email transport is configured, so the honest answer is `skipped`.
  const unknown = await call('/auth/forgot-password', {
    method: 'POST',
    body: { email: 'nobody@example.test' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.delivery, 'skipped');

  const invalidAddress = await call('/auth/forgot-password', {
    method: 'POST',
    body: { email: 'not-an-email' },
  });
  assert.equal(invalidAddress.status, 400);

  const account = await one<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = $1',
    ['second.owner@example.test'],
  );
  assert.ok(account);

  // The mail itself cannot be read back from the database (only its hash is
  // stored), so the test asks the service for the token it would have emailed.
  const token = await issueResetToken(account.id, '127.0.0.1');

  const check = await call(`/auth/reset-password/${encodeURIComponent(token)}`);
  assert.equal(check.status, 200);
  assert.equal(check.data.valid, true);

  const weak = await call('/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'short' },
  });
  assert.equal(weak.status, 400, 'a password under 8 characters is refused');

  const changed = await call('/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'BrandNewPass123' },
  });
  assert.equal(changed.status, 200);

  const oldPassword = await call('/auth/login', {
    method: 'POST',
    body: { email: 'second.owner@example.test', password: 'StrongPass123' },
  });
  assert.equal(oldPassword.status, 401, 'the old password no longer signs in');

  const newPassword = await call('/auth/login', {
    method: 'POST',
    body: { email: 'second.owner@example.test', password: 'BrandNewPass123' },
  });
  assert.equal(newPassword.status, 200, 'the new password does');
  owner2Token = newPassword.data.token;

  const replayed = await call('/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'AnotherPass456' },
  });
  assert.equal(replayed.status, 400, 'the same link cannot be used twice');

  const bogus = await call('/auth/reset-password', {
    method: 'POST',
    body: { token: 'x'.repeat(43), newPassword: 'AnotherPass456' },
  });
  assert.equal(bogus.status, 400, 'an unknown token is refused');
});
