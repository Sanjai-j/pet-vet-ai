# Pet Vet AI — AI upgrade: current state and plan

Written after reading the actual repository, not from the request's assumptions.
Every number below was counted in the source. Anything I could not verify is
listed in §7 rather than guessed.

---

## 1. What the stack actually is

Not Replit, and not "PostgreSQL / Neon" only — the code runs either way:

| Layer | Reality |
| --- | --- |
| Frontend | Angular 20 standalone components, no SSR (`apps/web`) |
| API | Node 22 + Express 4 + TypeScript ESM (`apps/api`) |
| Database | Postgres SQL, run either as embedded **PGlite** or a real server via `pg` — Neon is one option, not a requirement (`apps/api/src/db.ts`) |
| Migrations | 6 hand-written forward-only SQL files in `db/migrations`, applied by `src/migrate.ts` at boot |
| Hosting | Cloudflare Pages (static) behind a proxy to **Render** (`petvet-api-jwcf.onrender.com`) |
| AI | Optional OpenAI-compatible LLM behind a deterministic composer (`services/llm.ts`, `services/ai.ts`) |
| Auth | JWT + bcrypt; password reset exists (migration `006_password_reset.sql`) |

Anything below that says "gap" means the code genuinely does not have it.

---

## 2. The AI pipeline as it exists today

`POST /api/ai/chat` → `routes/ai.ts` → `generateAiReply()` in `services/ai.ts`:

1. **Load admin settings** (`settings` row `ai`) — `enabled`, `llmEnabled`, `disclaimer`.
2. **Emergency check** — `detectEmergency()` in `services/emergency.ts`, **before** anything else. 15 regex rules, species-scoped.
3. **Task detection + capability gate** — `detectTask()` / `getCapability()` in `services/capability.ts`. Six tasks; the `capability_registry` table holds 29 rows (dog/cat/bird/cow/goat/other × tasks). `not_supported` returns an explicit refusal instead of guessing.
4. **Retrieval** — `retrieveAllSources()` merges:
   - `retrieveSources()` (`services/retrieval.ts`) — lexical BM25-style scoring over `knowledge_chunks` joined to `knowledge_documents` where `status = 'approved'` and the species array matches.
   - `retrieveNutritionForChat()` (`services/nutrition-rag.ts`) — structured `nutrition_*` tables filtered by species, breed, life stage and recorded conditions.
5. **Pet record facts** — `loadPetRecordFacts()` (`services/pet-context.ts`) pulls profile, conditions, allergies, medications, vaccination records, checkpoints, today's care plan, weight log, appointments. Facts only; never treated as clinical evidence.
6. **Answer** — LLM when configured, deterministic composer otherwise. Mode is reported honestly (`llm` / `deterministic` / `blocked`) and stored on every message.

**This is a genuinely good skeleton.** The ordering the request asks for in §6 (emergency first, then generation) and §10 (no invented doses) is already the design. The weak parts are data volume, retrieval filters, output validation and measurement — not architecture.

---

## 3. Where accuracy actually tops out today

**The corpus is 11 hand-written demo documents.** `seed.ts` defines `KNOWLEDGE` with 11 `kd_*` entries (heatstroke, chocolate/xylitol, cat urinary, vaccination, …), each a few paragraphs, and stamps them `source_org: 'Pet Vet AI demo corpus (illustrative, not a clinical authority)'`, `is_demo = true`.

Alongside that:

- `scripts/import-breedwise.ts` and `src/services/nutrition-import.ts` load a structured nutrition workbook into `nutrition_guidance` / `nutrition_hazards` / `nutrition_recipes` / `nutrition_breed_guidance` / `nutrition_health_rules` — **pending review, not served until approved**.
- `src/services/vaccine-rag.ts` mirrors approved vaccine-schedule rows into the same knowledge index.
- `food_items` holds a curated per-species safety table.

So real breadth depends on whether the workbook and vaccine schedule were imported and approved on the live database. **I could not check the live row counts** (§7). If they were not imported, the assistant is answering from ~11 paragraphs, which is exactly the "accurately" ceiling.

No amount of prompt engineering fixes that. The fix is §4-style ingestion of real, permitted sources plus honest refusal for the rest.

---

## 4. Gap table, mapped to the request

| Request | Status | The actual gap |
| --- | --- | --- |
| §3.A species rules kept separate | **Done** | `capability_registry` + species arrays; birds already refuse symptom checks |
| §3.B breed info incl. predispositions | **Partial** | `breeds` has only `name`/`notes`/`is_unknown`. No inherited-condition, grooming, exercise or life-stage structure. Breed guidance exists only as `nutrition_breed_guidance` |
| §3.C conditions, signs, red flags, urgency | **Partial** | Signs/red flags live only in prose inside `knowledge_documents.content`. No structured condition/symptom table, no urgency enum, no review date per claim |
| §3.D nutrition & food safety | **Mostly done** | Rich tables, pending→approved workflow, per-record versioning (`nutrition_record_versions`), hazard severity enum |
| §3.E recipes incl. classification | **Done, conservatively** | `is_complete_diet` defaults false with no UI path to set it; `nutritional_adequacy` defaults `not_evaluated`. Correct behaviour |
| §4 ingestion with provenance, hashes, updates | **Gap** | `knowledge_documents` has no `content_hash`, no `retrieved_at`, no `license_notes`, no `life_stage`/`topic`/`urgency`/`breed` metadata. Re-import would duplicate rather than version |
| §5 retrieval filters + synonyms + dedupe | **Partial** | Species filter only. No topic/breed/life-stage filter, no chunk-level dedupe, and the whole approved corpus is loaded and scored in memory per request — fine at 11 docs, not at 5,000 |
| §5 hybrid/vector retrieval | **Gap, deliberately** | Lexical only. Adding embeddings needs a free embedding source and a `pgvector`-or-array column; cost/complexity was not justified at this corpus size |
| §6 emergency triage | **Partial** | 15 rules run first and are testable. Missing: explicit urgency level in the output (`routine/prompt/urgent/emergency`), and the `vomiting` rule matches the bare word "vomit", so "should I watch for vomiting?" escalates |
| §7 personalization | **Done** | Full record injection, ownership enforced by `loadPet()` + owner check. Missing only: asking a focused follow-up when a critical field (age, weight, bird species) is absent |
| §8 deterministic nutrition math | **Gap** | No calorie, RER/MER, unit-conversion or portion calculation anywhere in the API — `grep` for `kcal` finds only seed prose. This is the cheapest real capability win |
| §9 provider interface + startup validation | **Partial** | `services/llm.ts` is a clean 47-line OpenAI-compatible client with timeout and null-on-failure. `config.ts` does not validate it: a bad `LLM_PROVIDER`/`LLM_BASE_URL`/empty key degrades silently instead of failing loudly |
| §10 output validation | **Gap** | Nothing inspects the LLM's text before it is returned. The system prompt forbids doses and diagnoses; no code enforces it on the output |
| §11 evaluation dataset | **Gap** | `ai_evaluation_runs` table and `POST /admin/evaluations` exist, but there is no version-controlled golden set and no runner that exercises real questions. `qa-harness.ts` is workbook maths, not AI behaviour |
| §12 migration safety | **Convention exists** | Forward-only, `IF NOT EXISTS`, reviewed; six migrations so far |

---

## 5. Proposed order of work

Chosen so each phase is independently shippable, testable without an LLM key, and does not risk the live site.

**Phase A — Safety net on generated text (no migration).**
`services/ai.ts` + new `services/answer-guard.ts`: urgency levels on emergency replies, a post-generation validator that rejects/repairs answers containing dose patterns (`mg/kg`, "give 1 tablet"), named prescriptions, or a claimed diagnosis, falling back to the deterministic composer. Plus the `vomiting` false-positive narrowing.

**Phase B — Measurement (no migration).**
A version-controlled golden set (`test/ai-eval/*.json`) and a runner that calls `generateAiReply` directly against the PGlite fixture, asserting emergency recall, citation validity (every citation came back from retrieval), refusal behaviour on unsupported species, and unsafe-claim rate. Wire into `npm test`. **Nothing can be called "accurate" until this exists.**

**Phase C — Retrieval quality (no migration).**
Topic/life-stage/breed filters and chunk-level dedupe in `services/retrieval.ts`; move scoring to a single SQL-prefiltered pass so it does not load the corpus per request.

**Phase D — Knowledge ingestion with provenance (migration `007`).**
Add `content_hash`, `retrieved_at`, `license_notes`, `published_on`, `topic`, `life_stage`, `breed_names`, `urgency` to `knowledge_documents`; unique index on `content_hash`; a CLI importer that stages permitted WSAVA/AAHA/Merck/FEDIAF material as **pending** with full provenance and never overwrites review history.

**Phase E — Nutrition engine (migration optional).**
Pure functions: unit conversion, RER/MER with explicit formula + activity factor, portion maths with named assumptions, BCS-aware caveats, allergy/ingredient checks against `nutrition_hazards`. Endpoint + UI surface. Every output states its assumptions and is never called a feeding plan.

**Phase F — Provider hardening (no migration).**
Startup validation with actionable errors, `/health` reporting the effective mode without secrets, documented ₹0 path.

D is the only phase that touches real veterinary content, and it is the one that actually moves accuracy. A, B, C and F are code-only and reversible.

---

## 6. Files that would change

- Phase A: `apps/api/src/services/emergency.ts`, `services/ai.ts`, new `services/answer-guard.ts`, `test/api.test.ts`
- Phase B: new `apps/api/test/ai-eval/*.json`, new `apps/api/test/ai-eval.test.ts`, `apps/api/package.json`
- Phase C: `apps/api/src/services/retrieval.ts`, `services/nutrition-rag.ts`, `test/nutrition.test.ts`
- Phase D: new `db/migrations/007_knowledge_metadata.sql`, new `apps/api/scripts/import-knowledge.ts`, `routes/admin.ts`, `docs/API.md`
- Phase E: new `apps/api/src/services/nutrition-calc.ts`, `routes/nutrition.ts`, `apps/web/.../nutrition.component.ts`
- Phase F: `apps/api/src/config.ts`, `services/llm.ts`, `routes/providers.ts`

---

## 7. Verification status — what I could and could not confirm

**Confirmed by reading the source:** pipeline order, 15 emergency rules, 29 capability rows, 11 seeded knowledge documents, 60 API tests across 6 files, no calorie maths, no output validator, no golden eval set, no knowledge provenance columns.

**Not verified — do not treat as true:**

- Live row counts in `knowledge_documents`, `nutrition_*` and whether the workbook/vaccine imports were run and approved on the deployed database.
- Whether a real `LLM_API_KEY` is set on Render, so whether the live assistant is in `llm` or `deterministic-demo` mode. `/api/health` reports it; I have not called it this session.
- Test and build results. **`node`, `npm` and `npx` are not on PATH in this shell right now** (`where node` finds nothing), so nothing could be executed. The last recorded run was 60/60 passing before the password-reset work shipped; that result does not cover the current tree.

## 8. Phase A + B implementation status

Implemented and verified on 2026-10-25 against a local Node 24.22.1
(`.tools/`, gitignored):

| Check | Result |
| --- | --- |
| `npm --prefix apps/api run typecheck` | pass |
| `npm --prefix apps/api test` | **89/89 pass** — the 60 existing tests plus 29 new |
| `npm --prefix apps/api run eval:ai` | emergency recall 11/11, false positives 0, citation validity 50/50, referral rate 100%, output-guard findings 0 |
| `npm --prefix apps/api run build` | pass |
| `npm --prefix apps/web run build` | pass |

Nothing is committed or deployed yet. One existing test
(`nutrition.test.ts`: "Is chocolate safe for Bruno to eat?") initially caught a
regression: naming the pet did not count as referring to a real animal, so the
question stopped escalating. `detectEmergency()` now takes the pet's name, and
that test passes without being weakened.

| File | Change |
| --- | --- |
| `apps/api/src/services/answer-guard.ts` | **New.** `checkGeneratedAnswer()` rejects doses, prescription advice, stated diagnoses, home remedies, claimed examinations and answers with no referral. `urgencyForEmergency()` maps each red-flag rule to `routine` / `prompt` / `urgent` / `emergency` |
| `apps/api/src/services/ai.ts` | `AiReply.urgency` on every branch; emergency answers state their level; a model answer that fails the guard is discarded and replaced by the deterministic composer (logged, `mode: "deterministic"`) |
| `apps/api/src/services/emergency.ts` | Questions are no longer treated as events: counterfactuals ("what if…") and hazard questions ("which foods are toxic…", "is chocolate safe for dogs…") stop raising an incident alert, while a suspected exposure ("not sure if he ate…") and any question naming the actual pet still escalate. The vomiting rule now needs a reported event instead of the bare word |
| `apps/api/test/ai-eval/cases.json` | **New.** 25 golden cases: 10 emergencies, 5 non-incidents, 4 capability refusals, 3 retrieval, 1 unreviewed-document, 2 personalisation |
| `apps/api/test/ai-eval.test.ts` | **New.** Guard unit tests plus the golden runner, reporting emergency recall, false positives, citation validity, referral rate and guard findings |
| `apps/api/package.json` | `npm run eval:ai` |
| `docs/API.md`, `docs/CODE_GUIDE.md` | Documented `reply.urgency` and the guard |

Known limitations of what was written:

- The three retrieval cases now require at least one citation **and** the expected document, so recall at the cutoff is genuinely measured for those topics — but three topics is not a retrieval benchmark.
- `urgency` is returned in the API response but not persisted: `ai_messages` has no urgency column (that is Phase D's migration). Reopening a conversation therefore loses the level.
- The output guard has never run against a real model's prose: `LLM_PROVIDER=none` in tests, so only the planted-sentence unit cases exercise it. Treat Phase F (provider hardening) as the point where that becomes testable.
- The golden set is 25 cases written by one author against a 10-document corpus. It pins behaviour that exists; it does not establish coverage.

## 9. Broad answers and personalised feeding (second round)

Product decision taken: the assistant answers general health questions
broadly, while the safety layer stays.

**What changed**

| File | Change |
| --- | --- |
| `apps/api/src/services/ai.ts` | `capability.status === 'not_supported'` no longer short-circuits an answer. Only `medication_guidance` still refuses outright — a medicine name or dose is a product promise, not a coverage gap. Uncovered questions go to a general path: with a model configured it answers from general veterinary knowledge via `generalSystemPrompt` (must label uncertainty, never diagnose or dose), and the output guard still screens it; with no model it returns `generalAnswer()` — the honest gap plus the details that actually help a clinician |
| `apps/api/src/services/feeding-plan.ts` | **New.** Deterministic plan from the pet's own data: life stage, approved breed guidance, condition rules matched against the owner's recording, allergy cross-check on recipe ingredients, meal split, treat allowance, water guidance. `RER = 70 × kg^0.75` with a maintenance **range**, formula and assumptions returned. No calorie maths for birds |
| `apps/api/src/routes/nutrition.ts` | `GET /pets/:petId/feeding-plan` |
| `apps/api/src/services/ai.ts` + `routes/ai.ts` | Food questions carry the computed digest into both prompts, so "what should I feed Bruno?" is answered with Bruno's numbers rather than generic advice |
| `apps/api/test/feeding-plan.test.ts` | **New.** Energy maths, weight-loss factors, bird/weight refusals, condition + allergy filtering, missing-info handling, endpoint auth, and the chat integration |

**Verified on 2026-10-25:** typecheck pass; `npm test` **105/105**; API build pass; web build pass.

**Provider configuration (added after the reference chat was reviewed)**

The reference site is a bare LLM chat: a pet selector, one free-text box, and a
footer reading "Consult a local vet before starting treatments for accurate pet
diagnosis." No symptom checker, no citations, no refusals. Matching that
behaviour needs a model, so the misconfiguration path is now loud instead of
silent:

| File | Change |
| --- | --- |
| `apps/api/src/services/llm.ts` | `checkLlmSettings()`, `llmConfigStatus()` — checks provider, key, model and URL, and returns one actionable sentence per mistake. `llmConfigured()` is now derived from it |
| `apps/api/src/services/ai.ts` | `aiRuntimeInfo()` reports `configProblem` and the endpoint **host** (never the key) |
| `apps/api/src/server.ts` | Logs the configuration problem at boot instead of looking deliberately offline |
| `apps/api/test/llm-config.test.ts` | **New.** One case per misconfiguration |
| `.env.example`, `docs/DEPLOY_RENDER.md` | Verified base URLs for Gemini and Groq, and the four variables to set |

Verified base URLs, read from the providers' own docs: Gemini
`https://generativelanguage.googleapis.com/v1beta/openai`, Groq
`https://api.groq.com/openai/v1`.

**Still true, and important**

- Production still has `provider: none`. Without `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` on Render, "answer like an LLM vet" does not happen — the deterministic path runs, which is honest but cannot answer an uncovered question. The broader model branch has never been exercised against a real model; only its prompt, guard wiring and fallback are tested.
- The guardian blocks doses and prescriptions, so some medical questions will still get a refusal — by design.
- The feeding plan is exposed as an endpoint and used inside chat, but no screen renders it yet.
- No website was supplied, so nothing was modelled on it.

**The chat routing defect (fixed 2026-10-25)**

Production reported `provider: openai-compatible`, `modelConfigured: true`, `mode: llm` on
`/api/health` — and still answered a general feeding question with deterministic
approved-reference text. `/api/health` describes *configuration*; the reply describes what
happened, and nothing connected the two.

Root cause, in the order the request hit it:

1. `generateAiReply` chose between **two prompts** on one condition: did retrieval return any
   approved chunk? A feeding question token-matched nutrition guidance/hazard rows on words
   like "food" and "diet", so the *sources-only* prompt ran. That prompt says "Use ONLY the
   numbered approved sources for clinical claims. If they do not answer, say so plainly" — so
   the model had no permission to answer the question it was asked.
2. Any failure after that (provider 404/timeout/quota, or an output-guard rejection) fell back
   to `demoAnswer`, which prints the approved snippets and the line "No language model was
   used for this answer" — the reported symptom.
3. Nothing reported *which* of those happened. A stale `settings.ai.llmEnabled = false` would
   also disable the model with no log line at all.

| File | Change |
| --- | --- |
| `apps/api/src/services/ai.ts` | One `answerSystemPrompt` for every non-emergency question: cite `[n]` only for claims that source contains, answer from labelled general knowledge otherwise. The model is now invoked whether or not a reference matched — retrieval decides what may be cited, not whether an answer is allowed. Added `isFeedingQuestion`, `citedSources` (only `[n]` markers actually used become citations), `modeReason` on every reply, and a warning when a configured model is switched off by the admin setting |
| `apps/api/src/services/profile-match.ts` | **New.** `detectProfileConflict` compares the species, breed, age and weight in the question with the selected pet. On a mismatch it asks which animal (`needsClarification`) and calculates nothing; emergencies are still checked first, and general plural questions are not treated as conflicts |
| `apps/api/src/services/nutrition-answer.ts` | **New.** Deterministic feeding answer — complete-and-balanced food first, daily range with its assumptions, meals, water, gradual transitions, hazards, recipes only as treats, missing data listed. Birds get no dog/cat equations |
| `apps/api/src/services/feeding-plan.ts` | `digestLines(plan)` split out so one plan feeds both the prompt and the answer |
| `apps/api/src/services/llm.ts` | Provider failures log and remember the response body; `llmLastError()` reaches `/api/health` as `ai.lastProviderError`; a timeout is reported as a timeout |
| `apps/api/test/ai-routing.test.ts` | **New.** 12 cases, stubbed provider: feeding question reaches the model; computed plan reaches the prompt; only used sources become citations; medication and emergency paths never call the model; Labrador question against a selected cat clarifies with no plan; matching question is personalised; no-model fallback still answers; bird gets no energy maths; the admin switch is reported as `model_disabled_by_admin`; a 500 is reported as `provider_error` and shows on `/health` |
| `apps/api/src/app.ts` | `/api/health` reports `ai.llmEnabledByAdmin` beside `modelConfigured`, so a silent admin switch cannot masquerade as a healthy model |
| `docs/API.md`, `docs/CODE_GUIDE.md` | `modeReason`, `needsClarification`, citation rule, selected-pet rule |

**Verified on 2026-10-25 (this change):** `npm run typecheck` pass; `npm test` **117/117**
(105 existing + 12 new, golden eval included); API build pass; web build pass. Not committed,
pushed or deployed, and no production secret or database row was touched.

**Remaining limits of this fix**

- The provider path was exercised against a stub that speaks the OpenAI-compatible protocol,
  not against live Gemini. The live failure (if any) will now name itself in
  `ai.lastProviderError`, but it has not been observed from here.
- `modeReason` and `needsClarification` are returned by the API; the Angular chat screen renders
  the clarification as message text but does not yet offer buttons for "answer for Kushi" /
  "answer for another pet".
- `ai_messages` still has no column for `urgency` or `modeReason`, so history shows the answer
  text only; both are returned on the live reply.

## 10. Honest limits of the request itself

- "More powerful and accurate" cannot come from model tweaking here. With 11 demo documents, the assistant is at its data ceiling; Phase D is the only real accuracy lever.
- A ₹0 budget rules out hosted LLM inference at any useful volume. The deterministic, retrieval-cited path is the only one that scales at zero cost, which is why it must stay first-class and never be presented as a language model.
- No claim of clinical validation will be made at any point. The existing `capability_registry` wording ("status reflects the absence of a documented clinical validation study, not model confidence") should stay.
