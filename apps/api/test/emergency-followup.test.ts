import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Its own database directory: node's test runner runs these files in parallel.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-followup';
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';
process.env.UPLOAD_DIR = '.data/test-uploads-followup';
process.env.OVERPASS_ENABLED = 'false';

fs.rmSync(path.join(root, '.data/test-pg-followup'), { recursive: true, force: true });
fs.rmSync(path.join(root, '.data/test-uploads-followup'), { recursive: true, force: true });

/**
 * The production regression this suite exists for.
 *
 *   turn 1: "papu not eating for days"  → red flag, follow-up questions
 *   turn 2: "Papu refused for 1 day"    → deterministic composer, no red flag,
 *                                         urgency "routine", unrelated
 *                                         urinary/vomiting/diabetes references
 *
 * Two independent faults produced that: the not-eating rule only understood
 * one phrasing shape, and the red flag was evaluated per message with no
 * memory of the conversation. These tests pin the behaviour that has to hold
 * instead, across a model that works, a model that returns 503, a model that
 * times out, and no model at all.
 */

let server: http.Server;
let base = '';
let ownerToken = '';
let papuId = '';

const realFetch = globalThis.fetch;
let providerCalls: Array<{ body: any }> = [];
type ProviderMode = 'ok' | 'http503' | 'network' | 'timeout';
let providerMode: ProviderMode = 'ok';
let providerText = '';

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? '');
  if (url.startsWith(base) || url.includes('127.0.0.1') || url.includes('localhost')) {
    return realFetch(input, init);
  }
  providerCalls.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
  if (providerMode === 'network') throw new TypeError('fetch failed');
  if (providerMode === 'timeout') {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }
  if (providerMode === 'http503') {
    const payload = {
      error: {
        code: 503,
        message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
        status: 'UNAVAILABLE',
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: providerText } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function call(route: string, options: { method?: string; token?: string; body?: unknown } = {}) {
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

async function useModel(mode: ProviderMode, reply = ''): Promise<void> {
  const { config } = await import('../src/config.js');
  config.llm.provider = 'openai-compatible';
  config.llm.baseUrl = 'https://model.test/v1';
  config.llm.apiKey = 'test-only-key';
  config.llm.model = 'test-model';
  config.llm.timeoutMs = mode === 'timeout' ? 60 : 5000;
  providerCalls = [];
  providerMode = mode;
  providerText = reply;
}

async function useNoModel(): Promise<void> {
  const { config } = await import('../src/config.js');
  config.llm.provider = 'none';
  config.llm.apiKey = '';
  providerCalls = [];
  providerMode = 'ok';
  providerText = '';
}

const SAFE_EXPLANATION =
  'A cat that stops eating can dehydrate quickly, and a cat with diabetes is at extra risk when intake falls. ' +
  'Keep fresh water available while you arrange transport and note the last time Papu ate, drank or used the litter tray.\n\n' +
  'When to contact a veterinarian: now — go to a 24×7 emergency hospital if she also vomits, hides or seems weak.';

const SAFE_GROOMING_ANSWER =
  'Brush the coat in the direction of hair growth and check for ticks [1].\n\n' +
  'When to contact a veterinarian: for lumps, sores or skin that looks infected. See a veterinarian.';

/** A reply as the API returns it. */
type Reply = {
  answer: string;
  citations: Array<{ title: string; documentId: string }>;
  emergency: { ruleId: string; label: string } | null;
  urgency: string;
  mode: string;
  modeReason: string;
  emergencyContinued?: boolean;
  llmAttempted?: boolean;
  providerError?: string | null;
};

/** Send one message in a conversation and return the reply. */
async function chat(message: string, conversationId?: string): Promise<{ reply: Reply; conversationId: string }> {
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: { petId: papuId, message, ...(conversationId ? { conversationId } : {}) },
  });
  assert.equal(res.status, 201, `chat "${message}" answered 201`);
  return { reply: res.data.reply as Reply, conversationId: res.data.conversationId as string };
}

const REFERENCE_TITLES = (reply: Reply) => reply.citations.map((c) => c.title).join(' | ');

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

  // Papu exactly as in the report: an older cat with a recorded condition, so
  // the nutrition "diabetes" rule that used to be attached is in play.
  const created = await call('/pets', {
    method: 'POST',
    token: ownerToken,
    body: {
      name: 'Papu',
      speciesCode: 'cat',
      customBreed: 'Persian',
      ageEstimateMonths: 108,
      weightKg: 4.2,
      sex: 'female',
      activityLevel: 'low',
      conditions: 'Diabetes mellitus (diagnosed 2024)',
    },
  });
  assert.equal(created.status, 201, 'Papu is created');
  papuId = created.data.pet.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import('../src/db.js');
  await closeDb();
});

/* ── 1. Red-flag phrasing ─────────────────────────────────────────────── */

test('refusing food or water is detected in the phrasings owners actually use', async () => {
  const { detectEmergency } = await import('../src/services/emergency.js');
  const cases = [
    'Papu refused for 1 day',
    'Papu refused to eat for 1 day',
    'Papu refused food for 1 day',
    'Papu has not eaten since yesterday',
    "Papu hasn't eaten for 24 hours",
    'Papu is not drinking',
    'Papu stopped eating',
    'Papu is off her food',
    'Papu ate nothing since yesterday',
    'papu not eating for days',
  ];
  for (const message of cases) {
    const hit = detectEmergency(message, 'cat', 'Papu');
    assert.equal(hit?.ruleId, 'not_eating', `"${message}" is an appetite red flag`);
    assert.equal(hit?.label, 'Not eating or drinking');
  }
});

test('appetite detection does not fire on questions, other refusals or normal eating', async () => {
  const { detectEmergency } = await import('../src/services/emergency.js');
  const cases = [
    'Papu refused to walk for 1 day',
    'Papu refused the carrier for 1 day',
    'Papu is eating normally again',
    'Papu is eating well',
    'What should I feed Papu?',
    'How much should a cat drink each day?',
    'Papu is playing and eating normally',
    'Which foods are dangerous for cats?',
  ];
  for (const message of cases) {
    assert.equal(detectEmergency(message, 'cat', 'Papu'), null, `"${message}" is not a red flag`);
  }
});

test('appetite detection follows species and leaves dog-only rules to dogs', async () => {
  const { detectEmergency } = await import('../src/services/emergency.js');
  for (const species of ['dog', 'cat', 'bird', 'cow', 'goat']) {
    assert.equal(detectEmergency('has not eaten for two days', species)?.ruleId, 'not_eating', species);
  }
  // Xylitol is dog-only, and a cat owner should not get a dog emergency banner.
  assert.equal(detectEmergency('ate sugar-free gum', 'cat')?.ruleId ?? null, null);
  assert.equal(detectEmergency('ate sugar-free gum', 'dog')?.ruleId, 'xylitol');
});

test('a reported resolution is recognised, and a negation keeps the risk open', async () => {
  const { riskLooksResolved } = await import('../src/services/emergency.js');
  for (const text of [
    'Papu started eating again this morning',
    'She is eating normally now',
    'The vet said she is fine',
    'No longer refusing food',
  ]) {
    assert.equal(riskLooksResolved(text), true, `"${text}" is a resolution`);
  }
  for (const text of [
    'Papu is not eating again',
    'Still refusing food',
    'No change',
    'she is eating well but still a bit quiet',
  ]) {
    assert.equal(riskLooksResolved(text), false, `"${text}" leaves the risk open`);
  }
});

test('the previous turn red flag is read from the assistant banner', async () => {
  const { priorEmergencyFromHistory } = await import('../src/services/emergency.js');
  const raised = priorEmergencyFromHistory([
    { role: 'user', content: 'Papu not eating for days' },
    { role: 'assistant', content: '⚠️ Prompt: Not eating or drinking\n\nA pet that stops eating…' },
  ]);
  assert.equal(raised?.ruleId, 'not_eating');
  assert.equal(raised?.historyIndex, 1);

  // An ordinary answer in between ends the context: the concern is not carried
  // across unrelated turns.
  assert.equal(
    priorEmergencyFromHistory([
      { role: 'assistant', content: '⚠️ Prompt: Not eating or drinking\n\n…' },
      { role: 'user', content: 'How do I brush her coat?' },
      { role: 'assistant', content: 'Brush in the direction of hair growth.' },
    ]),
    null,
  );
});

/* ── 2. The two-turn conversation ─────────────────────────────────────── */

test('turn 2 keeps the red flag, the urgency and a guarded model explanation', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  try {
    const first = await chat('papu not eating for days');
    assert.equal(first.reply.emergency?.ruleId, 'not_eating');
    assert.equal(first.reply.modeReason, 'emergency_llm');
    assert.match(first.reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);

    const second = await chat('Papu refused for 1 day', first.conversationId);
    assert.equal(second.reply.emergency?.ruleId, 'not_eating', 'the follow-up is still a red flag');
    assert.equal(second.reply.urgency, 'prompt', 'urgency is not downgraded');
    assert.match(second.reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
    assert.match(second.reply.answer, /can deteriorate quickly/, 'the core safety instruction is present');
    assert.match(second.reply.answer, /Contact a veterinarian the same day/);
    assert.match(second.reply.answer, /can dehydrate quickly/, 'the model explanation is added');
    assert.equal(second.reply.mode, 'llm');
    assert.equal(second.reply.modeReason, 'emergency_llm');
    assert.equal(second.reply.llmAttempted, true);
    assert.equal(second.reply.providerError, null);
    assert.doesNotMatch(second.reply.answer, /General information for Papu — not a diagnosis/);
    assert.doesNotMatch(second.reply.answer, /Coverage note/);
    assert.match(second.reply.answer, /How long has Papu refused food/, 'the follow-up questions remain');

    // Emphasis: this turn's own words matched, so it is a fresh detection, not
    // a carried one — the point is that either path keeps the flag.
    assert.equal(second.reply.emergencyContinued, undefined);
  } finally {
    await useNoModel();
  }
});

test('turn 2 with Gemini returning 503 keeps the safety instruction and says why', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    const first = await chat('papu not eating for days');
    conversationId = first.conversationId;
  } finally {
    await useNoModel();
  }

  await useModel('http503');
  try {
    const second = await chat('Papu refused for 1 day', conversationId);
    assert.equal(second.reply.emergency?.ruleId, 'not_eating');
    assert.equal(second.reply.urgency, 'prompt');
    assert.match(second.reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
    assert.match(second.reply.answer, /can deteriorate quickly/);
    assert.match(second.reply.answer, /How long has Papu refused food/, 'follow-up questions survive a provider failure');
    assert.equal(second.reply.mode, 'deterministic');
    assert.equal(second.reply.modeReason, 'emergency_provider_error');
    assert.equal(second.reply.llmAttempted, true);
    assert.match(second.reply.providerError ?? '', /HTTP 503/);
    assert.doesNotMatch(second.reply.providerError ?? '', /test-only-key/, 'the key never appears in metadata');
    assert.doesNotMatch(second.reply.answer, /No language model was used/i, 'the model was attempted and failed');
    assert.doesNotMatch(second.reply.answer, /What this means:/, 'no explanation is invented');
  } finally {
    await useNoModel();
  }
});

test('turn 2 with a provider timeout or network error also keeps the safety answer', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  for (const mode of ['timeout', 'network'] as const) {
    await useModel(mode);
    try {
      const reply = (await chat('Papu refused for 1 day', conversationId)).reply;
      assert.equal(reply.emergency?.ruleId, 'not_eating', mode);
      assert.equal(reply.urgency, 'prompt', mode);
      assert.match(reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/, mode);
      assert.equal(reply.modeReason, 'emergency_provider_error', mode);
      assert.equal(reply.llmAttempted, true, mode);
      assert.ok(reply.providerError, `${mode} reports a sanitised reason`);
      assert.doesNotMatch(reply.answer, /No language model was used/i, mode);
    } finally {
      await useNoModel();
    }
  }
});

test('a follow-up that does not name the symptom still continues the red flag', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  await useModel('http503');
  try {
    const reply = (await chat('Papu is hiding under the bed and will not come out', conversationId)).reply;
    assert.equal(reply.emergency?.ruleId, 'not_eating', 'the unresolved red flag is carried forward');
    assert.equal(reply.emergencyContinued, true);
    assert.equal(reply.urgency, 'prompt');
    assert.match(reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
    assert.match(reply.answer, /continues the red flag raised earlier in this conversation/);
    assert.doesNotMatch(reply.answer, /General information for Papu — not a diagnosis/);
  } finally {
    await useNoModel();
  }
});

test('a reported resolution ends the red flag instead of repeating it', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  await useNoModel();
  const reply = (await chat('Papu started eating again this morning', conversationId)).reply;
  assert.equal(reply.emergency, null, 'a resolved risk is not carried');
  assert.equal(reply.urgency, 'routine');
  assert.doesNotMatch(reply.answer, /⚠️/);
});

test('a new red flag in a follow-up replaces the old one with its own urgency', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  await useModel('ok', SAFE_EXPLANATION);
  try {
    const reply = (await chat('Papu is now open-mouth breathing and gasping', conversationId)).reply;
    assert.equal(reply.emergency?.ruleId, 'breathing');
    assert.equal(reply.urgency, 'emergency');
    assert.equal(reply.emergencyContinued, undefined);
    assert.match(reply.answer.split('\n')[0]!, /^⚠️ Emergency: Breathing difficulty$/);
  } finally {
    await useNoModel();
  }
});

test('a general question after an emergency is answered as a general question', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  await useModel(
    'ok',
    'A complete and balanced adult dog food is the default for a healthy 25 kg Labrador. ' +
      'Feed two measured meals and adjust by body condition. This is general guidance.\n\n' +
      'When to contact a veterinarian: if the weight or appetite changes.',
  );
  try {
    const reply = (await chat(
      'For a dog in general, what should a healthy adult Labrador weighing around 25 kg eat daily?',
      conversationId,
    )).reply;
    assert.equal(reply.emergency, null, 'a general question is not the cat emergency');
    assert.equal(reply.urgency, 'routine');
    assert.doesNotMatch(reply.answer, /⚠️/);
    assert.equal(reply.mode, 'llm');
  } finally {
    await useNoModel();
  }
});

/* ── 3. References ────────────────────────────────────────────────────── */

test('unrelated references are excluded from the follow-up', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  let conversationId = '';
  try {
    conversationId = (await chat('papu not eating for days')).conversationId;
  } finally {
    await useNoModel();
  }

  await useNoModel();
  const reply = (await chat('Papu refused for 1 day', conversationId)).reply;
  const titles = REFERENCE_TITLES(reply);
  assert.doesNotMatch(titles, /urinary|blockage/i, `no urinary card (${titles})`);
  assert.doesNotMatch(titles, /vomit/i, `no vomiting card (${titles})`);
  assert.doesNotMatch(titles, /diabetes/i, `a recorded condition is not a cause (${titles})`);
  assert.doesNotMatch(reply.answer, /Nutrition rule for recorded condition/);
  assert.doesNotMatch(reply.answer, /Related approved reference material/);
  assert.deepEqual(reply.citations, [], 'nothing relevant was retrieved, so nothing is cited');
});

test('an ordinary question still cites a reference it actually used', async () => {
  await useModel('ok', SAFE_GROOMING_ANSWER);
  try {
    const reply = (await chat('How do I groom my cat\'s coat?')).reply;
    assert.equal(reply.emergency, null);
    assert.equal(reply.mode, 'llm');
    assert.equal(reply.citations.length, 1, 'the cited reference survives retrieval filtering');
    assert.equal(reply.citations[0]!.documentId, 'kd_grooming');
  } finally {
    await useNoModel();
  }
});

/* ── 4. Metadata honesty ──────────────────────────────────────────────── */

test('a provider failure on an ordinary question does not claim the model was never asked', async () => {
  await useModel('http503');
  try {
    const reply = (await chat('How do I groom my cat\'s coat?')).reply;
    assert.equal(reply.mode, 'deterministic');
    assert.equal(reply.modeReason, 'provider_error');
    assert.equal(reply.llmAttempted, true);
    assert.match(reply.answer, /was asked for an answer and did not return a usable one/);
    assert.doesNotMatch(reply.answer, /No language model was used/i);
  } finally {
    await useNoModel();
  }
});

test('without a configured model the fallback says so plainly', async () => {
  await useNoModel();
  const reply = (await chat('How do I groom my cat\'s coat?')).reply;
  assert.equal(reply.modeReason, 'no_model_configured');
  assert.equal(reply.llmAttempted, false);
  assert.match(reply.answer, /No language model is configured for this deployment/);
});

test('every reply carries the diagnostic fields the client and audit log read', async () => {
  await useNoModel();
  const reply = (await chat('papu not eating for days')).reply;
  for (const key of ['mode', 'modeReason', 'urgency', 'llmAttempted', 'providerError', 'emergency'] as const) {
    assert.ok(key in reply, `reply exposes ${key}`);
  }
  assert.equal(reply.mode, 'deterministic');
  assert.equal(reply.modeReason, 'emergency');
  assert.equal(reply.urgency, 'prompt');
  assert.equal(reply.providerError, null);
});

test('medication restrictions and unrelated safety rules are unchanged', async () => {
  await useModel('ok', SAFE_EXPLANATION);
  try {
    const meds = (await chat('What dose of paracetamol should I give Papu?')).reply;
    assert.equal(meds.modeReason, 'medication_blocked');
    assert.equal(providerCalls.length, 0, 'the model is never asked for a dose');

    const general = (await chat('Which foods are dangerous for cats?')).reply;
    assert.equal(general.emergency, null, 'a hazard list question is not an incident');
  } finally {
    await useNoModel();
  }
});
