# Pet Vet AI

An India-focused animal-care platform: daily care routines, veterinary records, food-safety
checks, a **cautious, evidence-linked AI assistant**, and access to **verified veterinarians**
through chat and peer-to-peer video.

The product is deliberately honest about its limits. It is care coordination and general
information — **not** a diagnosis service. Emergency red flags are detected by deterministic
rules *before* any AI answer is produced, unsupported species and questions fail transparently
with a referral. The platform ships no demo people, pets or clinics — a fresh install is empty
until real accounts are created — and every surface that shows external data names its source.

---

## 1. Status at a glance

| Area | State |
| --- | --- |
| Angular 20 + Angular Material frontend | Runs, builds, verified in a real browser |
| REST API, JWT auth, role-based authorization | Runs, verified (12 automated end-to-end API tests) |
| PostgreSQL schema, migrations, seed data | Runs; works against embedded PGlite **or** a real PostgreSQL server |
| Daily care checklist, logs, reminders, notifications | Runs, verified (opt-in gate tested) |
| AI safety layer: emergency rules, capability registry, RAG, optional LLM | Runs, verified in tests and UI |
| Food safety lookup, clinic/verified-vet directory, booking | Runs, verified |
| Appointments, consultation notes, private chat, WebRTC signalling | Runs, verified (chat round-trip tested; media needs a camera) |
| Administrator console (verification, knowledge review, capabilities, audit) | Runs, verified |
| Optional integrations (LLM provider, SMTP email, web push, maps key, TURN) | Interfaces implemented, disabled until you supply configuration |

### Runtime note (please read)

The original brief specified four services: Angular, **ASP.NET Core**, **Spring Boot**,
**FastAPI**, and PostgreSQL, orchestrated with Docker Compose.

This development environment contains **only Node.js 22** — `dotnet`, `java`/`mvn`, `python3`,
`docker` and `psql` are all absent, and administrator installs are not available. Shipping four
services that cannot be compiled, run, or tested here would have produced unverifiable code and
a platform that does not actually work.

Instead the brief's **service boundaries, contracts and responsibilities** are preserved inside
one deployable TypeScript API (`apps/api`) with clearly separated modules, and PostgreSQL is
used as the real database engine (PGlite is a Postgres build, or point `DATABASE_URL` at a real
server). The AI orchestration, safety rules and retrieval layer live in `apps/api/src/services`
behind the same HTTP contract a separate service would expose, so they can be extracted into a
Python FastAPI service without touching the frontend.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the mapping of each requested service to
the delivered module, including what to do when a Python/.NET/Java toolchain is available.

---

## 2. Architecture

```
                      ┌──────────────────────────────┐
   Browser            │  Angular 20 + Material (SPA) │
   (desktop/tablet/   │  owner · vet · admin shells  │
    mobile)           └──────────────┬───────────────┘
                                     │  HTTPS/JSON + WebSocket (JWT)
                      ┌──────────────▼───────────────┐
                      │  API (TypeScript, Express)   │
                      │  auth · pets · care · AI     │
                      │  appointments · chat · admin │
                      └───┬────────┬─────────┬───────┘
                          │        │         │
      ┌───────────────────▼──┐  ┌──▼───────┐ ┌▼────────────────────┐
      │ PostgreSQL (PGlite    │  │ Reminder │ │ WebSocket: chat,    │
      │ embedded, or pg to a  │  │ worker   │ │ notifications,      │
      │ real server)          │  │ 30s tick │ │ WebRTC signalling   │
      └───────────────────────┘  └──────────┘ └─────────────────────┘
```

* **Persistence** — one PostgreSQL schema (`db/migrations/001_init.sql`): 30 tables with foreign
  keys, check constraints, unique indexes and an append-only `audit_logs` table.
* **AI layer** — `services/emergency.ts` (deterministic red-flag rules) → `services/capability.ts`
  (database-backed capability registry) → `services/retrieval.ts` (approved-only lexical RAG with
  source attribution) → `services/llm.ts` (optional OpenAI-compatible provider) orchestrated by
  `services/ai.ts`.
* **Real-time** — `ws.ts` authenticates the socket with the same JWT, routes private chat,
  delivers notifications created anywhere in the API, and relays WebRTC offers/answers/ICE
  candidates only to the two participants of an accepted appointment.
* **Video** — browser-native `RTCPeerConnection`. Media is peer-to-peer and is **not** recorded or
  stored. Public STUN works out of the box; TURN is configurable and reported honestly in the UI.

Detailed design, data model and security notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Endpoint list: [docs/API.md](docs/API.md).
Every file and function, for learning the code: [docs/CODE_GUIDE.md](docs/CODE_GUIDE.md).

---

## 3. Quick start (no Docker, no external database)

Requirements: **Node.js 20+** (Node 22 tested). Nothing else.

```bash
git clone <this repo> && cd "pet vet"      # or open the folder you already have
npm run install:all                        # installs API and web dependencies

cp .env.example .env                       # optional: defaults work as-is

npm run migrate                            # create the schema
npm run seed                               # reference catalogs only: species, breeds, food safety, schedules
npm run create-admin -- you@example.com "A-strong-password"   # the first administrator
npm run import:workbook -- <file.xlsx>     # optional: import the nutrition workbook (add --dry-run to validate only)
npm run import:vaccine-schedule -- <file.xlsx>  # optional: import a vaccination schedule workbook (pending review)
npm run dev:api                            # API on http://localhost:4000
# in a second terminal:
npm run dev:web                            # Angular dev server on http://localhost:4200
```

Open <http://localhost:4200>. The dev server proxies `/api`, `/socket` and `/ws` to the API.

**Single-origin alternative:** `npm run build:web` and the API serves the built SPA itself at
<http://localhost:4000> (this is what the automated verification used).

### Using a real PostgreSQL server

```bash
docker compose up -d postgres              # or use any PostgreSQL 14+ instance
# .env
DATABASE_URL=postgresql://petvet:petvet@localhost:5432/petvet
npm run migrate && npm run seed && npm run dev:api
```

`DATABASE_URL` empty ⇒ embedded PGlite under `.data/pg`. Same schema, same SQL, no code change.

### Docker Compose (database + API)

```bash
docker compose up --build                  # then open http://localhost:4000
```

### First account (no demo data is shipped)

The seed loads **reference catalogs only** — species, breeds, food-safety entries, approved
vaccine schedules, the knowledge base and nutrition guidance. It never creates people, pets,
clinics or records, so a fresh deployment is empty until real accounts are added.

```bash
npm run create-admin -- you@example.com "A-strong-password" "Your Name"
```

That is the one account that can approve credentials and review knowledge. Owners register
themselves on `/register`; veterinarians register and then wait for the administrator to approve
their credentials before they appear in the directory or can be booked.

If you want a populated environment for screenshots or demos, run the API test fixtures:
`apps/api/test/fixtures.ts` contains the synthetic people, pets and clinics the automated tests
use — it is test code, never part of a deployment.

---

## 4. Environment variables

Copy `.env.example` → `.env`. Nothing is required for local development.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | API port | `4000` |
| `WEB_ORIGIN` | Allowed CORS origin | `http://localhost:4200` |
| `APP_TIMEZONE` | Reminder/checklist timezone | `Asia/Kolkata` |
| `DATABASE_URL` | Real PostgreSQL connection string; empty ⇒ embedded PGlite | *(empty)* |
| `PGLITE_DIR` | Embedded database directory | `.data/pg` |
| `JWT_SECRET` | **Required in production** (≥32 chars) | dev placeholder (throws in prod) |
| `JWT_EXPIRES_IN` | Token lifetime | `12h` |
| `SEED_CATALOG` | Auto-seed reference catalogs when the database is empty | `true` |
| `OVERPASS_ENABLED` | Free OpenStreetMap nearby-hospital search | `true` |
| `NOMINATIM_USER_AGENT` | User-Agent for OSM geocoding (put a contact address in it) | `PetVetAI/1.0` |
| `LLM_PROVIDER` | `none` (deterministic composer) or `openai-compatible` | `none` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Provider endpoint, key, model | — |
| `AI_MAX_MESSAGES_PER_DAY` | Per-owner AI message cap | `80` |
| `EXA_API_KEY` | **Server** key for the live web-search panel on the AI page; never sent to the browser | *(empty → panel shows setup guidance)* |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | Private media storage | `uploads`, `10` |
| `SMTP_*`, `EMAIL_FROM` | Optional email reminders | disabled |
| `VAPID_*` | Optional browser push keys | disabled |
| `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_MAP_ID` | Optional maps provider | disabled (offline geo + deep links) |
| `WEBRTC_STUN_URLS`, `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | WebRTC ICE configuration | public STUN only |

Secrets stay server-side. The browser never receives an SMTP password, LLM key or TURN
credential; TURN credentials are handed out only to authenticated consultation participants.

| `GOOGLE_MAPS_API_KEY` | **Server** key for Places API (New) + Geocoding. Never sent to the browser | *(empty → free OpenStreetMap lookup)* |
| `GOOGLE_MAPS_BROWSER_KEY` | Optional Maps JavaScript key; only with HTTP-referrer restrictions | *(empty)* |
| `GOOGLE_MAPS_MAP_ID` | Optional Map ID for the browser map | *(empty)* |
| `GOOGLE_PLACES_API_ENABLED` | `false` disables live Places lookups even with a key | `true` |
| `GOOGLE_MAPS_TIMEOUT_MS` | Per-request Maps timeout | `8000` |
| `PGLITE_ADMIN_SOCKET_ENABLED` | Expose the embedded engine over the PostgreSQL wire protocol | `true` |
| `PGLITE_ADMIN_SOCKET_HOST` / `_PORT` | Where that socket listens | `127.0.0.1:5544` |

### Nearby hospital search (free by default)

"Find care" answers **which vet hospital is closest to me** with no key and no billing:
your browser shares a location (or you type a city), the server geocodes it with Nominatim and
looks up `amenity=veterinary` / `healthcare=veterinary` places within the chosen radius, and the
results come back sorted by real distance with "Open in Maps" directions.

Both OpenStreetMap lookups run together and their answers are merged by OpenStreetMap id: the
Overpass API supplies opening hours, phone numbers and the emergency flag, while Nominatim's
bounded listing search answers in about a second when the public Overpass mirrors are saturated.
Whichever answers first still produces a list, so the page does not fail just because one mirror
is busy. OpenStreetMap's coverage is community-maintained and incomplete, so the page always
says to call ahead, and it credits OpenStreetMap where the data comes from.

To use Google Places instead (better coverage and review data), follow the setup below — the
page switches sources automatically. To turn nearby search off entirely (air-gapped host), set
`OVERPASS_ENABLED=false`.

### Google Maps setup (optional, ~10 minutes)

Google Places is an optional upgrade over the built-in OpenStreetMap lookup:

1. In Google Cloud Console create (or pick) a project and **enable billing**.
2. Enable **Places API (New)** and **Geocoding API**. Do not enable legacy "Places API" — this
   code uses the v1 `places:searchText` endpoint.
3. Create an API key under *APIs & Services → Credentials* and restrict it:
   *Application restrictions* → **IP addresses** (your server's egress IPs),
   *API restrictions* → only the two APIs above. This key must never reach a browser.
4. Put it in `.env` as `GOOGLE_MAPS_API_KEY` and restart the API. `GET /api/maps/config` starts
   returning `placesConfigured: true`, and the Find a Vet page switches from OpenStreetMap to
   Google listings automatically.
5. Optionally create a *second*, HTTP-referrer-restricted key for Maps JavaScript and set
   `GOOGLE_MAPS_BROWSER_KEY` + `GOOGLE_MAPS_MAP_ID`.

Operational notes that the code enforces:

* Places results are **proxied and displayed live — never copied into our database**. Google's
  terms prohibit caching or building a competing directory from Places content; only our own
  clinic rows (demo, or independently sourced and imported) are stored
* Every response carries `dataSource` and `verificationStatus`. A Google listing is
  `listing_only`; it is **never** presented as a Pet Vet AI verification.
* Requests are rate-limited per user (30/minute) and logged to `maps_api_log` with endpoint,
  latency, status and result count only — **no coordinates or query text** are stored.
  Admins can read aggregates at `GET /api/maps/usage`.

### Inspecting the database with pgAdmin 4 or DBeaver

When `DATABASE_URL` is empty the app runs the embedded PGlite engine and exposes it over the
PostgreSQL wire protocol, so desktop tools work without installing PostgreSQL:

| Setting | Value |
| --- | --- |
| Host | `127.0.0.1` (loopback only) |
| Port | `5544` (change with `PGLITE_ADMIN_SOCKET_PORT`) |
| Database | `postgres` |
| Username | `postgres` |
| Password | *(none)* |
| SSL | off |

In pgAdmin: *Register → Server*, fill the table above, leave SSL off, then browse
`public → tables`. The API prints the same coordinates on boot
(`[db] pgAdmin/DBeaver connection: …`). Notes:

* Start the API first — the socket lives inside the API process.
* PGlite is **single-process**: stop the API before running `npm run migrate` or `npm run seed`
  against the same directory, or they will contend for the lock.
* Only one admin socket per process; set `PGLITE_ADMIN_SOCKET_ENABLED=false` to turn it off
  (do that before exposing the machine publicly, or rely on the loopback binding).
* With a real `DATABASE_URL`, connect your tool directly to PostgreSQL and this socket stays idle.

---

## 5. What each role can do

**Pet owner** — register/sign in · guided onboarding (species → breed → details, everything but
the name optional) · multiple pets · full pet profile with unknown fields left unknown · daily
care checklist with one-tap logging · routine builder (feeding, water, walk, grooming,
medication, observation, one-off) · meals/water/grooming/observation/weight logs · vaccination
records (owner-reported vs vet-recorded, never invented) · vaccination plan: age-based checkpoints calculated
from the approved schedule for young pets, one tap to mark done, or set the date your vet gave you and get a
notification on that date ·Pet Vet AI with citations and honest limits · personalized nutrition guidance filtered by species, life stage,
allergies, conditions and veterinary dietary restrictions (approved knowledge only; recipes are framed as
treats/supplements unless professionally validated; cattle and goats always require a formulated feed plan) ·
food-safety lookup · nearby care discovery (offline geo search or browser location) ·
care discovery with radius search and free/open slot booking · private chat with attachments ·
WebRTC video consultation · notification opt-in controls and privacy settings.

**Veterinarian** — professional registration with license/council (starts `pending`) ·
verification application with credential documents (`/vet/apply`) · practice profile, species
coverage, qualifications, languages, consultation types and demo fee · publish availability as
bookable slots · directory listing **only after verification** · appointment
accept/reject/complete · propose a reschedule · request a clinic association (reviewed, never
auto-linked) · shared pet records for accepted consultations only · consultation notes and care
plans that create owner follow-up tasks · chat with owners · video consultations.

**Administrator** — platform KPIs · veterinarian verification with notes · knowledge-document
review (approve/reject; approving chunks the text for retrieval, editing an approved document
sends it back to review) · nutrition knowledge review for the imported food workbook — pending
queue per record kind, edit, approve/reject/reopen with notes, full version history, RAG mirror
sync on approval (editing an approved record returns it to the queue) · vaccination schedule review
(imported workbook rows are pending until approved; only approved rows with a concrete age may create
checkpoints) · species/breed catalog management · capability registry editing
(validated / limited / not supported with an evidence summary) · user enable/disable · content
reports · AI settings (global enable, LLM permission, disclaimer) · technical evaluation runs ·
veterinarian application queue (start review, request more information, approve, reject — with
notes sent to the applicant) · clinic association requests · Maps API usage diagnostics ·
audit log.

**Verification workflow.** A veterinarian registers (role `vet`, status `pending`), submits an
application with licence, registering authority, qualification, species, languages,
consultation types and optional credential documents, and sees the outcome in their portal.
They are invisible to owners and unbookable until an administrator approves. Approval stamps
`verified_at` and schedules re-verification a year out; changing the licence number or council
sends the profile back to review automatically. Only approved vets publish slots, and a slot can
be held by exactly one appointment — the claim is a single conditional `UPDATE`, so two owners
racing for the same slot can never both succeed.

Authorization is enforced in the API on every route — hiding a button is never the control.

---

## 6. AI safety model

1. **Emergency rules first.** `services/emergency.ts` holds deterministic, species-aware
   red-flag patterns (chocolate/xylitol/grapes/allium, poisoning, breathing difficulty, collapse
   or seizure, heatstroke, bloat, feline urinary blockage, significant bleeding, rumen bloat,
   avian respiratory distress, refusing food). A match short-circuits the pipeline into an
   immediate escalation — independent of any model setting.
2. **Capability gate.** Every species/task pair has a database status. `not_supported` returns a
   transparent limitation plus a species-appropriate referral and *no* retrieval, so the platform
   never improvises clinical advice. Medication and dosing questions are always refused.
3. **Retrieval-augmented answers.** Only `approved` documents are searchable. Retrieval scores
   chunks lexically and returns attributed snippets (title, source, demo flag, URL).
4. **Two answer modes.**
   * `deterministic` (default, no API key): a composer that presents retrieved snippets, states
     coverage limits, and says explicitly that no language model was used.
   * `llm` (when `LLM_PROVIDER=openai-compatible` with a key): a strict system prompt forbids
     diagnosis, prescriptions and doses, restricts claims to the numbered sources, treats source
     text as data (prompt-injection resistant), and requires a "when to contact a veterinarian"
     line. If the provider fails, the deterministic composer takes over.
5. **Capability status is evidence, not confidence.** The seeded registry marks dog/cat symptom
   review, emergency triage, food safety and general care as **limited**, and image analysis and
   medication guidance as **not supported**, with the explicit note that no clinical validation
   study has been completed. Technical tests are never presented as clinical validation.

---

## 7. Repository layout

```
db/migrations/001_init.sql     PostgreSQL schema (tables, constraints, indexes)
apps/api/                      TypeScript API
  src/routes/                  auth, catalog, pets, care, dashboard, ai, providers,
                               appointments, threads, vet, files, notifications, admin, reports
  src/services/                ai, emergency, capability, retrieval, llm, care, scheduler,
                               notifications
  src/db.ts                    dual driver: embedded PGlite or `pg` for a real server
  src/ws.ts                    authenticated WebSocket: chat, notifications, WebRTC signalling
  src/seed.ts                  India-focused reference catalogs (species, food, schedules, knowledge)
  test/api.test.ts             12 end-to-end API tests (node:test)
apps/web/                      Angular 20 + Angular Material SPA
  src/app/core/                API client, auth state, guards, WebSocket service, toasts, models
  src/app/pages/               login, register, onboarding, dashboard, pet detail, AI chat,
                               food safety, find care, appointments, messages, video room,
                               vet portal, admin console, settings
docs/ARCHITECTURE.md           design, data model, service mapping, security
docs/API.md                    endpoint reference
docs/CODE_GUIDE.md             file-by-file guide to every function, with a reading order
docker-compose.yml             optional PostgreSQL (+ API) orchestration
.env.example                   every supported variable, commented
```

---

## 8. Scripts

```bash
npm run install:all     # install API + web dependencies
npm run dev:api         # API with reload (tsx watch)
npm run dev:web         # Angular dev server (proxy to the API)
npm run start:api       # API without watch (serves the built SPA when present)
npm run migrate         # apply db/migrations
npm run seed            # seed reference catalogs (skips if species already exist)
npm run seed:reset      # wipe everything and re-seed catalogs
npm run create-admin -- <email> "<password>"   # create/promote the administrator account
npm run import:workbook -- <file.xlsx> # nutrition xlsx → normalized tables (pending review; --dry-run validates only)
npm run import:vaccine-schedule -- <file.xlsx> # vaccination schedule xlsx → review queue (--dry-run validates only)
npm test                # end-to-end API tests (HTTP against a real schema)
npm run typecheck       # strict TypeScript check of the API
npm run build:web       # production Angular build
npm run build           # typecheck + production web build
```

---

## 9. Testing

`npm test` (API, `node:test`, real HTTP against a real schema in an isolated database):

1. species and breed catalogs are species-scoped (dog breeds never leak into cats)
2. registration, duplicate detection, login failure, role escalation blocked, admin routes 403
3. pet creation with unknown breed; species/breed mismatch rejected
4. another owner cannot read a private pet record
5. **feeding reminders create nothing until the owner opts in**, then exactly one reminder
6. emergency rules win over the AI (chocolate, feline urinary blockage) and cite approved sources
7. unsupported species and medication questions fail transparently; no dose is ever invented
8. food safety distinguishes toxic / unknown / unsupported-species coverage
9. **an unreviewed knowledge document is not retrievable until an administrator approves it**
10. an unverified veterinarian cannot take bookings; verification publishes them
11. appointment acceptance creates a private thread; a third party gets 403; notes are shared
12. uploaded files are readable by the owner and refused to everyone else
13. `/maps/config` never leaks the server key and names the active nearby provider
14. map search requires a signed-in user
15. nearby hospital results carry their OpenStreetMap/Google source, distance and "call ahead" notice
16. map usage diagnostics are administrator-only
17. **the directory lists only approved veterinarians**; unreviewed profiles 404
18. an unverified veterinarian cannot be booked (fails closed)
19. **slot booking holds the slot and prevents double booking** (second attempt 409), and
    cancelling releases the slot back to other owners
20. an application moves submitted → under review → approved and only then appears in the
    directory; one open application at a time; owners cannot review
21. clinic association requests are gated on verification and cannot be reviewed twice
22. **nutrition knowledge stays hidden until approved**; guidance filters by species + life
    stage; hazards are species-scoped and prioritise veterinary advice; recorded allergies flag
    conflicting guidance and recipes; incomplete pet data is disclosed as gaps, never guessed;
    recipes expose ingredients/steps/storage and are treats unless adequacy was validated;
    cows and goats require a formulated feed plan with no universal quantities; breed context
    appears only with approved evidence; admins can review/edit/version/reject end to end;
    recipe completeness cannot be flipped on through the API; workbook import validates before
    writing and cannot overwrite approved records; approved records surface as RAG citations

Manual browser verification covered: sign-in, dashboard checklist logging, species-driven breed
selection, AI chat with citations and coverage notes, food safety, care discovery, booking
surfaces, real-time chat round-trip (message persisted and echoed over the WebSocket), vet
appointment decision + consultation note, administrator knowledge approval, capability editing,
users/audit, and settings toggles.

**Not verified here:** actual video/audio media flow (the automated browser has no camera and its
permission prompt cannot be answered), email/push delivery (no SMTP/VAPID credentials), and any
clinical accuracy claim — none is made.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Cannot reach the Pet Vet AI server` | API not running, or the web dev server proxy is missing. Start `npm run dev:api`; use `npm run dev:web` (not a bare static server) so `/api`, `/socket` and `/ws` are proxied. |
| Port already in use | Another process holds 4000/4200 — stop it or set `PORT`/`--port`. |
| API starts then exits with `JWT_SECRET must be set` | You set `NODE_ENV=production`. Provide a strong `JWT_SECRET`. |
| 401 on every request | Expired/cleared token in localStorage. Sign in again. |
| 403 `Veterinarian access required` | Role-guarded route used by another role — expected. |
| Chat doesn't update live | WebSocket blocked (proxy/corporate network). The UI falls back to an HTTP send; check the "Live connection" badge on Messages. |
| Video says "STUN only" / call fails on mobile data | Configure `TURN_URL` + credentials. Carrier-grade NAT needs TURN. |
| Camera denied or prompt never appears | Browser permission for `localhost`/HTTPS; the room now times out after 20s with a clear message instead of hanging. |
| Reminders never arrive | Reminders are opt-in per category in **Settings → Care reminders**. Email/push also need SMTP/VAPID configured. |
| `seed` says reference catalogs already exist | Intentional idempotency: it skips once species are loaded. Use `npm run seed:reset` to rebuild catalogs (this deletes all data, including accounts). |
| PGlite errors after running a second process against the same directory | PGlite is single-process. Stop the API before running `migrate`/`seed`, or use a real PostgreSQL server. |

---

## 11. Deployment

**₹0 hosting — Cloudflare Pages + Render + Neon:** [docs/DEPLOY_FREE.md](docs/DEPLOY_FREE.md) is
the complete guide for this layout. The Angular app is built and served by Cloudflare Pages, a
Pages Function proxies `/api/*` and the WebSocket (`/socket`) to a Render Free service, and Neon
holds the data. It covers every dashboard setting, the exact environment variables, the
administrator command, a verification checklist and the free-tier limits. Nothing in that path
needs a credit card.

**Single service (API + app on Render):** [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) covers
the simpler one-service layout, which needs a **Starter** instance: the Angular build peaks
around 760 MB and Render Free only has 512 MB.

Deploying anywhere else — minimum path:

1. PostgreSQL 14+ (managed instance is fine). Set `DATABASE_URL`, `JWT_SECRET` (≥32 random
   bytes), `NODE_ENV=production`, `WEB_ORIGIN` to your public origin.
2. `npm run build` (typecheck + API + web) → `apps/web/dist/pet-vet-ai/browser`. The API serves
   it automatically, or host it on a CDN and proxy `/api` + `/socket` to the API (see
   [docs/DEPLOY_FREE.md](docs/DEPLOY_FREE.md) for a working Cloudflare Pages setup). Start with
   `npm run start:prod` (compiled server); `npm run start:api` runs TypeScript and is for
   development.
3. Terminate TLS at your proxy. **HTTPS is required** for camera/microphone access and service
   workers; `localhost` is the only exception.
4. Run the API under a process manager (`systemd`, PM2, ECS/Fly/Render-style container). The
   reminder worker runs in-process every 30 seconds; keep exactly one scheduler instance or
   scale with a single leader.
5. Set `UPLOAD_DIR` to durable storage, or set `FILE_STORAGE=db` to keep uploads inside
   PostgreSQL (required on hosts without a persistent disk, e.g. Render's free plan). Either
   way uploads are only served through the access-checked `/api/files/:id` endpoint. Back up the
   database.
6. Optional: `SMTP_*`, `VAPID_*`, `LLM_*`, `TURN_*`, `GOOGLE_MAPS_*`.
7. No demo accounts exist: the seed ships catalogs only. After the first deploy, run
   `npm run create-admin --prefix apps/api -- you@example.com "password"` against the production
   database to create the administrator who can approve credentials.
8. `DATABASE_SSL` defaults to on in production (Neon, Supabase). Set it to `false` for a plain
   local PostgreSQL that does not offer TLS.
9. `docker compose up --build` is a working reference for a single-host deployment.

Add rate limiting/WAF at the edge (a login throttle exists in-process), rotate `JWT_SECRET`
deliberately (it invalidates sessions), and keep `audit_logs` retention long enough for your
compliance needs.

---

## 12. Honest limitations and what remains

* **No clinical validation.** The knowledge corpus is a small synthetic demo set (marked
  `is_demo`). Capability statuses say so. Before any real use, a licensed veterinarian must
  review and own the corpus, and evaluation must be documented per species and task.
* **Species coverage is intentionally uneven.** Dogs and cats have limited symptom support;
  birds, cattle and goats have husbandry/awareness guidance plus emergency-only escalation; other
  species are `not_supported`.
* **Video is P2P only.** No recording, no server-side media, no TURN out of the box.
* **No payments.** Consultation fees are displayed as demo information; no payment provider is
  integrated, so no payment is ever claimed.
* **No SMS/WhatsApp.** Delivery channels are in-app, optional email, optional web push.
* **Hospital listings come from community maps, not a verification.** OpenStreetMap is free and
  keyless but community-maintained: some places are missing, some details are stale, and a
  listing is never a Pet Vet AI verification. Google Places results carry the same caveat. The
  UI labels the source and always says to call ahead. Credential verification is a separate,
  administrator-reviewed workflow — no licence number is ever invented.
* **Coverage is never claimed to be complete.** OpenStreetMap, Google Places and any curated
  list all miss facilities; the UI says so next to the results instead of implying a national
  register.
* **Imagery analysis is absent** by design (`image_analysis: not_supported`).
* **Toolchain gap.** The requested .NET/Java/Python services are documented boundaries rather
  than running processes; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains exactly how to
  introduce them when those runtimes are available.

### Phase mapping from the brief

| Phase | Delivered |
| --- | --- |
| 1 Structure, auth, catalogs, onboarding, PostgreSQL, owner dashboard | ✅ |
| 2 Care checklist, feeding schedules, opt-in notifications, grooming, vaccinations | ✅ |
| 3 AI service, knowledge ingestion, RAG, emergency rules, species-aware conversations, limited-support fallback | ✅ (deterministic + optional LLM) |
| 4 Food safety, care discovery, vet directory, verification, booking | ✅ |
| 5 Real-time messaging, media sharing, WebRTC, notes and care plans | ✅ (TURN/SMTP optional) |
| 6 Automated testing, security checks, AI evaluation, dataset review workflow, deployment docs | ✅ (technical evaluation only; no clinical validation claimed) |
