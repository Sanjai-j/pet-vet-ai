/**
 * Live verification for nutrition-aware AI retrieval.
 *
 * Logs in as a demo owner, asks the AI chat a food-safety question, and
 * prints the citations so we can confirm approved nutrition records
 * (nutrition_hazards / nutrition_health_rules) appear as sources after a
 * bulk review approval.
 *
 * Usage: node --experimental-strip-types scripts/live-verify-nutrition.ts
 *   (run from apps/api, with the API listening on API_URL, default :4000)
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

async function req(path: string, opts: RequestInit & { token?: string } = {}) {
  const { token, ...init } = opts;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function login(email: string): Promise<string> {
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD ?? 'Demo@1234' }),
  });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
  return (r.data as { token: string }).token;
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const ownerEmail = process.env.OWNER_EMAIL ?? 'priya.sharma@example.com';
  const ownerToken = await login(ownerEmail);
  console.log(`logged in as ${ownerEmail}`);

  const petsRes = await req('/api/pets', { token: ownerToken });
  const pets = ((petsRes.data as { pets?: unknown[] }).pets ?? petsRes.data ?? []) as Array<{
    id: string; name: string; speciesCode: string;
  }>;
  if (!pets.length) fail('no pets for owner');
  const pet = pets[0];
  console.log(`using pet ${pet.id} (${pet.name}, ${pet.speciesCode})`);

  const question = process.env.QUESTION ?? 'My dog ate some grapes. What should I do?';
  const chat = await req('/api/ai/chat', {
    method: 'POST',
    token: ownerToken,
    body: JSON.stringify({ petId: pet.id, message: question }),
  });
  if (chat.status !== 201 && chat.status !== 200) {
    fail(`chat -> ${chat.status} ${JSON.stringify(chat.data).slice(0, 500)}`);
  }
  const reply = (chat.data as { reply: {
    answer: string; mode: string; emergency: unknown;
    citations: Array<{ id?: string; title?: string; kind?: string; source?: string }>;
  } }).reply;

  console.log(`\nmode: ${reply.mode}`);
  console.log(`emergency: ${reply.emergency ? JSON.stringify(reply.emergency) : 'none'}`);
  console.log(`citations (${reply.citations.length}):`);
  for (const c of reply.citations) {
    console.log(`  - [${c.kind ?? c.source ?? '?'}] ${c.title ?? c.id ?? JSON.stringify(c)}`);
  }
  console.log(`\nanswer (first 600 chars):\n${reply.answer.slice(0, 600)}`);

  const hasNutrition = reply.citations.some((c) => {
    const blob = JSON.stringify(c).toLowerCase();
    return blob.includes('nutrition') || blob.includes('hazard') || blob.includes('grape')
      || blob.includes('health_rule') || blob.includes('demo');
  });
  if (!reply.citations.length) fail('no citations returned');
  if (!hasNutrition) {
    fail('citations did not include any nutrition record');
  }
  console.log('\nPASS: AI chat returned citations including nutrition records');
}

main().catch((e) => { console.error(e); process.exit(1); });
