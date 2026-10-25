import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Its own database directory: node's test runner runs these files in parallel.
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = '.data/test-pg-emergency';
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-123456';
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';
process.env.UPLOAD_DIR = '.data/test-uploads-emergency';
process.env.OVERPASS_ENABLED = 'false';

fs.rmSync(path.join(root, '.data/test-pg-emergency'), { recursive: true, force: true });
fs.rmSync(path.join(root, '.data/test-uploads-emergency'), { recursive: true, force: true });

/**
 * The production case this suite exists for: "Papu not eating for days" was
 * answered with a red-flag template plus generic vomiting and diabetes
 * references, and the configured model was never asked for an explanation.
 *
 * These tests pin the shape of a safe emergency reply:
 *   1. the deterministic red-flag instruction is always first and always there,
 *   2. the model may only supplement it, and only when the text supports it,
 *   3. a failure or an unsafe answer degrades to that same instruction,
 *   4. a reference is shown only when it is *about* the red flag.
 */

let server: http.Server;
let base = '';
let ownerToken = '';
let papuId = '';

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

/** A supplementary explanation that supports the red flag and names no dose. */
const SAFE_EXPLANATION =
  'A cat that stops eating for more than a day can dehydrate quickly, and fat cats are at risk of liver problems. ' +
  'That is why this needs a same-day examination rather than waiting for the appetite to return on its own. ' +
  'While you arrange transport, keep fresh water available and note the last time Papu ate, drank or used the litter tray.\n\n' +
  'When to contact a veterinarian: now — go to a 24×7 emergency hospital if she also vomits, hides or seems weak.';

/** The same idea, softened into unsafe advice. */
const DOWNGRADING_ANSWER =
  'You can wait and see for another day and try a little boiled rice at home. Nothing to worry about. ' +
  'Schedule a routine appointment next week if she is still off her food.';

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

  // Papu as described in the report: an older cat with a recorded condition,
  // so the nutrition rules that produced the "diabetes" card are in play.
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

test('"not eating for days" keeps the red flag first and adds a model explanation', async () => {
  await useModel(SAFE_EXPLANATION);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'Papu not eating for days' },
    });
    assert.equal(res.status, 201);
    const reply = res.data.reply;

    assert.equal(reply.emergency.ruleId, 'not_eating', 'the red flag still fires');
    assert.equal(reply.urgency, 'prompt');

    // Safety instruction first, unchanged, before any generated text.
    assert.match(reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
    assert.match(reply.answer, /can deteriorate quickly/);
    assert.match(reply.answer, /Contact a veterinarian the same day/);

    // The explanation is additive.
    assert.match(reply.answer, /can dehydrate quickly/);
    assert.equal(reply.mode, 'llm');
    assert.equal(reply.modeReason, 'emergency_llm');
    assert.equal(reply.llmAttempted, true);
    assert.equal(providerCalls.length, 1, 'the model is asked exactly once');

    // Useful follow-ups, explicitly optional.
    assert.match(reply.answer, /How long has Papu refused food/);
    assert.match(reply.answer, /still drinking water/);
    assert.match(reply.answer, /answering them is optional and must not delay care/);

    // The prompt hands the model the safety instruction and forbids softening.
    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.match(system, /SAFETY INSTRUCTION ALREADY SHOWN/);
    assert.match(system, /Never downgrade the urgency/);
    assert.match(system, /Never invent a citation/);
  } finally {
    await useNoModel();
  }
});

test('an explanation that softens the red flag is discarded, and the instruction survives', async () => {
  await useModel(DOWNGRADING_ANSWER);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'Papu not eating for days' },
    });
    assert.equal(res.status, 201);
    const reply = res.data.reply;
    assert.equal(reply.emergency.ruleId, 'not_eating');
    assert.equal(reply.mode, 'deterministic');
    assert.equal(reply.modeReason, 'emergency_guard_rejected');
    assert.equal(reply.llmAttempted, true);
    assert.doesNotMatch(reply.answer, /wait and see/i, 'unsafe advice never reaches the owner');
    assert.doesNotMatch(reply.answer, /nothing to worry about/i);
    assert.doesNotMatch(reply.answer, /boiled rice/i, 'no home treatment is passed on');
    assert.match(reply.answer, /Contact a veterinarian the same day/, 'the safety instruction is intact');
    assert.match(reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
  } finally {
    await useNoModel();
  }
});

test('a provider failure returns the same safe emergency answer', async () => {
  await useModel(null, 500);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'Papu not eating for days' },
    });
    assert.equal(res.status, 201);
    const reply = res.data.reply;
    assert.equal(reply.mode, 'deterministic');
    assert.equal(reply.modeReason, 'emergency_provider_error');
    assert.equal(reply.llmAttempted, true);
    assert.match(reply.providerError ?? '', /HTTP 500/, 'the failure is reported in a sanitised form');
    assert.match(reply.answer, /can deteriorate quickly/);
    assert.match(reply.answer, /How long has Papu refused food/);
    assert.doesNotMatch(reply.answer, /What this means:/, 'no explanation is invented');
  } finally {
    await useNoModel();
  }
});

test('without a model the emergency answer is still complete and honest', async () => {
  await useNoModel();
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: { petId: papuId, message: 'Papu not eating for days' },
  });
  assert.equal(res.status, 201);
  const reply = res.data.reply;
  assert.equal(reply.mode, 'deterministic');
  assert.equal(reply.modeReason, 'emergency');
  assert.equal(reply.llmAttempted, false);
  assert.match(reply.answer, /Not eating or drinking/);
  assert.match(reply.answer, /veterinar/i);
  assert.match(reply.answer, /must not delay care/);
});

test('references that are not about the red flag are not attached', async () => {
  await useNoModel();
  const res = await call('/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: { petId: papuId, message: 'Papu not eating for days' },
  });
  assert.equal(res.status, 201);
  const reply = res.data.reply;
  const titles: string[] = (reply.citations as any[]).map((c) => c.title);
  for (const title of titles) {
    assert.match(
      title,
      /appetit|anorex|not eating|weight loss|dehydrat/i,
      `"${title}" is not about refusing food and must not be cited`,
    );
  }
  assert.doesNotMatch(reply.answer, /vomiting and digestive upset/i);
  assert.doesNotMatch(reply.answer, /diabetes/i);
  assert.doesNotMatch(reply.answer, /Related approved reference material/i, 'no reference card is offered without a relevant one');
});

test('a red flag that a reference does cover still cites it', async () => {
  await useModel(
    'Chocolate contains methylxanthines that cats and dogs cannot process safely [1]. ' +
      'Do not wait for symptoms.\n\nWhen to contact a veterinarian: now — contact an emergency veterinary hospital.',
  );
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'Papu ate chocolate a few minutes ago' },
    });
    assert.equal(res.status, 201);
    const reply = res.data.reply;
    assert.equal(reply.emergency.ruleId, 'chocolate');
    assert.equal(reply.modeReason, 'emergency_llm');
    const citations = reply.citations as any[];
    assert.equal(citations.length, 1, 'only the source the answer used is attached');
    assert.match(citations[0].title, /chocolate/i, 'the cited reference is about the red flag');
    // The irrelevant rows lexical search also finds are filtered out of the prompt.
    const system: string = providerCalls[0]!.body.messages[0].content;
    assert.doesNotMatch(system, /Vomiting and digestive upset/i);
    assert.doesNotMatch(system, /Diabetes/i);
  } finally {
    await useNoModel();
  }
});

test('a normal question still reaches the model', async () => {
  await useModel(
    'A complete and balanced food for her life stage is the default. ' +
      'Split it into measured meals and keep fresh water available.\n\n' +
      'When to contact a veterinarian: if the appetite or weight changes.',
  );
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'What should I feed Papu?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.mode, 'llm');
    assert.equal(res.data.reply.modeReason, 'llm_answer');
    assert.equal(res.data.reply.llmAttempted, true);
    assert.equal(providerCalls.length, 1);
    assert.equal(res.data.reply.emergency, null);
  } finally {
    await useNoModel();
  }
});

test('medication questions stay blocked even with a model configured', async () => {
  await useModel(SAFE_EXPLANATION);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'What dose of paracetamol should I give Papu?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.modeReason, 'medication_blocked');
    assert.equal(providerCalls.length, 0, 'the model is never asked for a dose');
  } finally {
    await useNoModel();
  }
});

test('a red flag outranks a medication question in the same message', async () => {
  await useModel(SAFE_EXPLANATION);
  try {
    const res = await call('/ai/chat', {
      method: 'POST',
      token: ownerToken,
      body: { petId: papuId, message: 'Papu is not eating since yesterday, can I give her paracetamol 5 mg?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reply.emergency.ruleId, 'not_eating');
    assert.match(res.data.reply.modeReason, /^emergency/);
    assert.match(res.data.reply.answer.split('\n')[0]!, /^⚠️ Prompt: Not eating or drinking$/);
    assert.match(res.data.reply.answer, /deteriorate quickly/);
  } finally {
    await useNoModel();
  }
});
