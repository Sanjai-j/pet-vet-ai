import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Its own database directory: node's test runner runs these files in parallel.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-ai-routing';
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';
process.env.UPLOAD_DIR = '.data/test-uploads-ai-routing';
process.env.OVERPASS_ENABLED = 'false';

fs.rmSync(path.join(root, '.data/test-pg-ai-routing'), { recursive: true, force: true });
fs.rmSync(path.join(root, '.data/test-uploads-ai-routing'), { recursive: true, force: true });

/**
 * Regression suite for the chat pipeline's *routing*.
 *
 * The bug these tests exist for: with a model configured and healthy, a general
 * feeding question still returned deterministic approved-reference text,
 * because retrieval decided whether the model was allowed to answer. These
 * tests pin the decision to the question and the pet, not to whether some
 * chunk happened to match a word.
 */

let server: http.Server;
let base = '';
let ownerToken = '';
let adminToken = '';
let kushiId = '';

// One fetch wrapper for both directions: requests to the local API go to the
// real transport, requests to the configured provider go to the stub below.
const realFetch = globalThis.fetch;
let providerCalls: Array<{ url: string; body: any }> = [];
let providerReply: { text: string; status: number } | null = null;

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? '');
  if (url.startsWith(base) || url.includes('127.0.0.1')) return realFetch(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  providerCalls.push({ url, body });
  if (!providerReply) return new Response('{}', { status: 500 });
  const payload = providerReply.status === 200
    ? { choices: [{ message: { content: providerReply.text } }] }
    : { error: { message: 'stubbed provider failure' } };
  return new Response(JSON.stringify(payload), {
    status: providerReply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

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

async function useModel(reply: string | null, status = 200): Promise<void> {
  const { config } = await import('../src/config.js');
  config.llm.provider = 'openai-compatible';
  config.llm.baseUrl = 'https://model.test/v1';
  config.llm.apiKey = 'test-only-key';
  config.llm.model = 'test-model';
  config.llm.timeoutMs = 5000;
  providerCalls = [];
  providerReply = reply === null ? null : { text: reply, status };
}

async function useNoModel(): Promise<void> {
  const { config } = await import('../src/config.js');
  config.llm.provider = 'none';
  config.llm.apiKey = '';
  providerCalls = [];
  providerReply = null;
}

/** A safe model answer: cites source 1, ends with a referral. */
const SAFE_MODEL_ANSWER =
  'A commercially prepared complete and balanced food for the life stage is the default [1]. ' +
  'Split the daily amount into measured meals and keep water available.\n\n' +
  'When to contact a veterinarian: if the pet stops eating or loses weight.';

before(async () => {
  const { migrate } = await import('../src/migrate.js');
  const { seed } = await import('../src/seed.js');
  const { seedTestFixtures } = await import('./fixtures.js');
  const { createApp } = await import('../src/app.js');
  await migrate();
  await seed();
  await seedTestFixtures();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;

  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: 'priya@petvetai.demo', password: 'Demo@1234' },
  });
  assert.equal(login.status, 200, 'owner login');
  ownerToken = login.data.token;

  const admin = await call('/auth/login', {
    method: 'POST',
    body: { email: 'admin@petvetai.demo', password: 'Demo@1234' },
  });
  assert.equal(admin.status, 200, 'admin login');
  adminToken = admin.data.token;

  // The screenshot case: a 3-month-old Persian cat named Kushi, 1.5 kg.
  const created = await call('/pets', {
    method: 'POST',
    token: ownerToken,
    body: {
      name: 'Kushi',
      speciesCode: 'cat',
      customBreed: 'Persian',
      ageEstimateMonths: 3,
      weightKg: 1.5,
      sex: 'female',
      activityLevel: 'moderate',
    },
  });
  assert.equal(created.status, 201, 'Kushi is created');
  kushiId = created.data.pet.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

test('a general feeding question reaches the configured model', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi? How much food does she need each day?' },
    });
    assert.equal(res.status, 201);
    assert.equal(providerCalls.length, 1, 'the provider was called exactly once');
    assert.equal(providerCalls[0]!.body.model, 'test-model');
    assert.equal(res.data.reply.mode, 'llm', `expected an LLM answer, got ${res.data.reply.modeReason}`);
    assert.equal(res.data.reply.modeReason, 'llm_answer');
    assert.doesNotMatch(res.data.reply.answer, /No language model was used/i);
  } finally {
    await useNoModel();
  }
});

test('a feeding question sends the computed plan and stays labelled as sourced-or-general', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi?' },
    });
    assert.equal(res.status, 201);
    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.match(system, /Feeding data computed from approved records for Kushi/);
    assert.match(system, /kcal/, 'the model receives the calculated energy figures');
    assert.match(system, /never claim|Never describe a homemade recipe as complete/i, 'completeness rule is in the prompt');
    assert.match(system, /only when that source contains the claim|only when that source/i, 'citation rule is in the prompt');
    assert.equal(res.data.reply.mode, 'llm');
  } finally {
    await useNoModel();
  }
});

test('approved references stay cited when the answer actually uses them', async () => {
  await useModel('Brush the coat in the direction of hair growth and check for ticks [1].\n\nWhen to contact a veterinarian: for lumps or skin lesions. See a veterinarian.');
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: 'pet_luna', message: 'How do I groom my cat\'s coat?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.mode, 'llm');
    const citations = res.data.reply.citations as any[];
    assert.ok(citations.length > 0, 'the cited approved document is returned');
    assert.equal(citations[0].documentId, 'kd_grooming');
  } finally {
    await useNoModel();
  }
});

test('a citation the answer never used is not attached to it', async () => {
  await useModel('Give a complete and balanced food and fresh water.\n\nWhen to contact a veterinarian: if appetite drops. See a veterinarian.');
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi?' },
    });
    assert.equal(res.data.reply.mode, 'llm');
    assert.deepEqual(res.data.reply.citations, [], 'no general-knowledge claim is made to look sourced');
  } finally {
    await useNoModel();
  }
});

test('medication questions keep their restrictions even with a model configured', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What dose of paracetamol should I give Kushi?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.modeReason, 'medication_blocked');
    assert.equal(providerCalls.length, 0, 'the model is never asked for a dose');
    assert.doesNotMatch(res.data.reply.answer, /\d+\s?(mg|ml)/i);
  } finally {
    await useNoModel();
  }
});

test('emergencies keep the deterministic instruction first and use the model only to supplement it', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'Kushi ate chocolate a few minutes ago' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.emergency.ruleId, 'chocolate');
    // The red flag still opens the reply, byte for byte, before anything the
    // model wrote.
    assert.match(res.data.reply.answer.split('\n')[0]!, /^⚠️ Urgent: Possible chocolate exposure$/);
    assert.match(res.data.reply.answer, /emergency hospital|veterinarian/i);
    assert.equal(res.data.reply.modeReason, 'emergency_llm');
    assert.equal(res.data.reply.llmAttempted, true);
    assert.equal(providerCalls.length, 1, 'the model is asked for a supplementary explanation');
    assert.match(providerCalls[0]!.body.messages[0].content, /SAFETY INSTRUCTION ALREADY SHOWN/);
  } finally {
    await useNoModel();
  }
});

test('a Labrador question while Kushi is selected asks which animal instead of answering', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: {
        petId: kushiId,
        message: 'What should I feed a 2-year-old Labrador weighing 25 kg? He is very active.',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.modeReason, 'profile_mismatch');
    assert.equal(res.data.reply.needsClarification, true);
    assert.equal(providerCalls.length, 0, 'no answer is generated for the wrong animal');
    assert.match(res.data.reply.answer, /Kushi/);
    assert.match(res.data.reply.answer, /Labrador/i);
    assert.match(res.data.reply.answer, /which would you like|Which would you like/i);
    assert.doesNotMatch(res.data.reply.answer, /kcal/i, 'no plan is calculated for the described animal');
    assert.deepEqual(res.data.reply.citations, []);

    // The exact short phrasing from the bug report is still a conflict: no
    // general marker, and a specific animal that is not the selected one.
    const short = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed my 2-year-old Labrador weighing 25 kg?' },
    });
    assert.equal(short.data.reply.modeReason, 'profile_mismatch');
    assert.equal(short.data.reply.needsClarification, true);
  } finally {
    await useNoModel();
  }
});

test('a general dog question while a cat is selected is answered, not sent to clarification', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: {
        petId: kushiId,
        message:
          'For a dog in general, what should a healthy adult Labrador weighing around 25 kg eat daily? ' +
          'Explain suitable food, approximate feeding amount, meal frequency, foods to avoid, and how to adjust portions based on body condition.',
      },
    });
    assert.equal(res.status, 201);
    assert.notEqual(res.data.reply.modeReason, 'profile_mismatch', 'an explicit general question is not a mismatch');
    assert.equal(res.data.reply.needsClarification, undefined);
    assert.equal(res.data.reply.modeReason, 'llm_answer');

    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.match(system, /general question about dogs/i);
    assert.match(system, /25 kg/, 'the weight stated in the question is the one used');
    assert.doesNotMatch(system, /1\.5 kg/, "the selected cat's weight is never used");
    assert.doesNotMatch(system, /Persian/i, "the selected cat's breed is never used");
    assert.doesNotMatch(system, /Pet record from the owner/i, "the selected pet's record is not included");
    assert.match(system, /kcal/, 'an estimate from the stated weight is available');
  } finally {
    await useNoModel();
  }
});

test('"generally speaking" about dogs while a cat is selected is not a conflict', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'Generally speaking, what should adult dogs eat?' },
    });
    assert.equal(res.status, 201);
    assert.notEqual(res.data.reply.modeReason, 'profile_mismatch');
    assert.equal(res.data.reply.modeReason, 'llm_answer');
    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.match(system, /general question about dogs/i);
    assert.doesNotMatch(system, /1\.5 kg/);
  } finally {
    await useNoModel();
  }
});

test('a general dog answer never borrows the selected cat\'s numbers', async () => {
  await useNoModel();
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: {
      petId: kushiId,
      message: 'For a dog in general, what should a healthy adult Labrador weighing around 25 kg eat daily?',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.reply.modeReason, 'no_model_configured');
  assert.doesNotMatch(res.data.reply.answer, /1\.5 kg/, 'no profile weight leaks into a general answer');
  assert.doesNotMatch(res.data.reply.answer, /Kushi/);
  assert.match(res.data.reply.answer, /25 kg/, 'the stated weight is used');
  assert.match(res.data.reply.answer, /kcal/);
  assert.match(res.data.reply.answer, /dogs/i);
  assert.match(res.data.reply.answer, /veterinar/i);
  assert.match(res.data.reply.answer, /complete and balanced/i);
});

test('a question about the selected pet gets its own personalised plan', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi? She is 3 months old and 1.5 kg.' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.modeReason, 'llm_answer', 'a matching 3-month-old 1.5 kg question is not a conflict');
    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.match(system, /Kushi/);
    assert.match(system, /1\.5 kg/);
    assert.match(system, /3 months|0\.3 years|life stage/i);
  } finally {
    await useNoModel();
  }
});

test('the deterministic answer still works when no model is configured', async () => {
  await useNoModel();
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: { petId: kushiId, message: 'What should I feed Kushi?' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.reply.mode, 'deterministic');
  assert.equal(res.data.reply.modeReason, 'no_model_configured');
  assert.match(res.data.reply.answer, /kcal/, 'the answer carries the computed energy estimate');
  assert.match(res.data.reply.answer, /meal\(s\) a day/i);
  assert.match(res.data.reply.answer, /complete and balanced/i);
  assert.match(res.data.reply.answer, /veterinar/i);
  assert.match(res.data.reply.answer, /not a prescription/i);
  assert.doesNotMatch(res.data.reply.answer, /\d+\s?(mg|ml)\b/i, 'no dose is ever printed');
});

test('a bird feeding question never gets dog or cat energy maths', async () => {
  await useNoModel();
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: { petId: 'pet_kiwi', message: 'What should I feed Kiwi?' },
  });
  assert.equal(res.status, 201);
  assert.match(res.data.reply.answer, /not applied to birds|validated for dogs and cats/i);
  assert.doesNotMatch(res.data.reply.answer, /kcal/i, 'no canine/feline energy equation is applied to a bird');
});

test('a configured model silenced by the admin switch is reported, not hidden', async () => {
  await useModel(SAFE_MODEL_ANSWER);
  await call('/admin/settings/ai', { method: 'PATCH', token: adminToken, body: { llmEnabled: false } });
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.mode, 'deterministic');
    assert.equal(res.data.reply.modeReason, 'model_disabled_by_admin');
    assert.equal(providerCalls.length, 0, 'the disabled model is not called');

    const health = await call('/health');
    assert.equal(health.data.ai.modelConfigured, true);
    assert.equal(health.data.ai.llmEnabledByAdmin, false, 'the switch is visible next to the configuration');
  } finally {
    await call('/admin/settings/ai', { method: 'PATCH', token: adminToken, body: { llmEnabled: true } });
    await useNoModel();
  }
});

test('a provider failure is reported, and the answer falls back to the computed plan', async () => {
  await useModel(null, 500);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: kushiId, message: 'What should I feed Kushi?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.modeReason, 'provider_error');
    assert.match(res.data.reply.answer, /kcal/);

    const health = await call('/health');
    assert.match(
      health.data.ai.lastProviderError ?? '',
      /HTTP 500/,
      'the operator can see why the model was not used',
    );
  } finally {
    await useNoModel();
  }
});
