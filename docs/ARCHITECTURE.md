# Pet Vet AI — architecture

## 1. Why one service instead of four

The brief asked for Angular + ASP.NET Core + Spring Boot + FastAPI + PostgreSQL. The
development environment contains **only Node.js 22**: `dotnet`, `java`, `mvn`, `python3`,
`pip`, `docker` and `psql` are all missing and cannot be installed here. Four services that
cannot be built, started or tested would have produced a platform that does not run.

The delivered system keeps the brief's **boundaries, responsibilities and contracts** in one
deployable process, with the code split so that each boundary can be lifted into its own service
later without changing the frontend or the database.

| Requested service | Delivered module | Responsibility |
| --- | --- | --- |
| Angular + Material SPA | `apps/web` | All screens: onboarding, dashboard, pet records, AI chat, food safety, care discovery, appointments, messaging, video room, vet portal, admin console, settings |
| ASP.NET Core Web API | `apps/api` (`routes/*`, `auth.ts`, `access.ts`, `audit.ts`) | REST surface, JWT auth, role authorization, validation, audit |
| Spring Boot knowledge / scheduling service | `services/care.ts`, `services/scheduler.ts`, `services/capability.ts`, `routes/admin.ts` | Care-task scheduling semantics, reminder worker, capability registry, catalog and knowledge review workflows, health endpoint |
| FastAPI AI service | `services/ai.ts`, `services/emergency.ts`, `services/retrieval.ts`, `services/llm.ts`, `routes/ai.ts` | Safety rules, capability gating, retrieval over approved documents, optional LLM provider, citation building |
| PostgreSQL | `db/migrations/*`, `src/db.ts` | Schema, constraints, indexes, audit log; embedded Postgres (PGlite) or a real server via `pg` |
| SignalR / WebSockets | `src/ws.ts` | Authenticated chat, notification fan-out, WebRTC signalling, typing, read receipts |
| WebRTC | `apps/web/.../video-room.component.ts` + `ws.ts` relay + `routes/providers.ts` (`/config/webrtc`) | Peer-to-peer media with STUN/TURN configuration and authorization |
| Maps provider | `routes/providers.ts` + `find-care.component.ts` | Geo search over the directory (haversine) and "Open in Maps" deep links; a maps API key is optional |
| Push / email | `services/notifications.ts` | In-app always; optional web-push (VAPID) and SMTP email, each reporting delivery honestly |
| Media storage | `routes/files.ts` | Authenticated upload/download, ownership checks, private storage directory (swap for object storage) |
| Docker Compose | `docker-compose.yml` | Optional PostgreSQL + API orchestration; the app also runs with neither Docker nor a database server |

### Extracting the AI service into Python (when `python3` exists)

The contract is already HTTP-shaped:

```http
POST /api/ai/chat          # { petId, message, conversationId? }
GET  /api/ai/status        # provider mode, limits, disclaimer
GET  /api/capabilities     # capability registry view
```

A FastAPI implementation needs: (a) the same capability table, (b) the same emergency rules,
(c) read access to `knowledge_documents` where `status = 'approved'`, and (d) the same JSON
response shape (`answer`, `citations[]`, `emergency`, `capability`, `mode`, `disclaimer`,
`referral`). Move `services/{ai,emergency,capability,retrieval,llm}.ts` behind a new base URL and
set `AI_SERVICE_URL`; nothing in the SPA changes. The same applies to a scheduler leader or a
separate identity service.

---

## 2. Data model (30 tables)

| Domain | Tables | Notes |
| --- | --- | --- |
| Identity & roles | `users` | `role ∈ {owner, vet, admin}`, unique lower(email), notification and privacy JSON, `disabled` flag |
| Professional | `vet_profiles` | license/council (unique), specialties/species arrays, availability JSON, fee, `verification_status` |
| Catalogs | `species`, `breeds` | species categories drive household-vs-farm prompts; breeds unique per species with an explicit "Other / Unknown" row |
| Pets | `pets` | species FK, optional breed + custom breed, weight/date, lifestyle, medical text fields, `photo_file_id`, `is_household_pet` |
| Care | `care_tasks`, `care_logs`, `reminders`, `notifications`, `push_subscriptions` | times as JSON array of `HH:MM`, frequency `daily/weekly/monthly/once`; reminders have a unique `dedupe_key` |
| Preventive | `vaccinations` | `source ∈ {owner_reported, vet_recorded, demo}` |
| Clinical access | `appointments`, `consultation_notes`, `threads`, `messages` | consultation notes can create a `once` follow-up care task |
| Knowledge | `knowledge_documents`, `knowledge_chunks`, `capability_registry`, `ai_evaluation_runs` | only `approved` documents have chunks; capability unique per (species, task) |
| Safety & directory | `food_items`, `clinics` | both carry `is_demo` |
| Governance | `audit_logs`, `content_reports`, `settings`, `files` | audit rows are append-only; `settings.ai` holds enable/LLM/disclaimer |

Migrations live in `db/migrations` and are applied in filename order, recorded in
`schema_migrations`. `npm run seed` is idempotent; `npm run seed:reset` rebuilds demo data.

### Care scheduling semantics

* A task is due on a date by frequency: `daily` always; `once` when `due_date` matches; `weekly`
  on the weekday of `due_date` (Sunday by default); `monthly` on the day-of-month of `due_date`
  (the 1st by default).
* The scheduler ticks every 30 seconds in `APP_TIMEZONE` and fires a reminder when the local
  time is within 5 minutes after a task slot.
* A reminder is only created when the owner has opted in for **that category**
  (`feeding`, `grooming`, `vaccination`). Vaccination follow-ups additionally require a documented
  `next_due_on` inside 7 days and run once per day at 09:00 local.
* `dedupe_key` guarantees at most one reminder per task/slot/day. Delivery is in-app by default,
  plus optional email and web push — each channel's real outcome is logged, never assumed.

---

## 3. Security model

* **Authentication** — bcrypt (cost 11) password hashes; JWT (HS256, `JWT_EXPIRES_IN`). The token
  is accepted from `Authorization: Bearer` and, for `<img>` loads only, from a `token` query
  parameter on the access-checked file endpoint.
* **Authorization** — every route re-reads the user from the database (so a disabled account is
  rejected immediately) and checks role. Pet access (`access.ts`) is ownership-based for owners,
  appointment/thread-based for veterinarians, and explicit for admins. Admins cannot disable
  themselves. Frontend guards are for UX only.
* **Private records** — pet records, consultations, notes, messages and uploads are all
  server-scoped. A third owner receives `403`, verified by tests.
* **Uploads** — MIME allow-list, size limit, random stored filename, served only through
  `/api/files/:id` with ownership/sharing checks, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store`.
* **WebSocket** — JWT verified at connect; every frame re-checks participant membership
  (threads) or appointment participation and status (WebRTC signalling).
* **AI safety** — injection-resistant prompt construction (sources are data, never
  instructions), no diagnosis/prescription/dose ever produced, capability gate refuses
  unsupported species and medication questions, emergency rules are deterministic and always run.
* **Abuse controls** — helmet headers, CORS allow-list, JSON body limit, login throttle, per-owner
  daily AI message cap, content reporting with an admin queue.
* **Auditability** — registration, login, verification, knowledge approvals, catalog changes,
  capability updates, settings changes, appointment decisions, consultation notes and AI messages
  (including whether an emergency rule fired) are written to `audit_logs`.

---

## 4. Request flow examples

**Owner asks the AI about a symptom**

1. `POST /api/ai/chat` → auth, pet ownership, per-day limit check.
2. `detectEmergency(text, species)` runs first.
3. If matched → urgent answer + referral, capability recorded, message persisted with
   `emergency = true`, audit entry created.
4. Else `detectTask()` chooses the task, the capability registry decides supported/limited/
   not-supported, and unsupported tasks return a limitation plus referral.
5. Otherwise retrieval returns approved chunks; the LLM (if configured) answers from those
   sources, else the deterministic composer does. Citations are stored as JSONB on the message.

**Vet accepts an appointment**

1. `PATCH /api/appointments/:id/status` → participant check, transition rules by role.
2. Status updated, `threads` upserted on `(owner_id, vet_id, pet_id)`.
3. Owner notified in-app and, if connected, over the socket.
4. Vet adds consultation notes → optional follow-up care task for the pet + owner notification.

**Video consultation**

1. Room requires `status = 'accepted'`; ice servers come from `/api/config/webrtc` (TURN
   credentials only for authenticated users).
2. Both participants send `join`; the lexicographically lower user id creates the offer
   (deterministic, avoids glare). Answers and ICE candidates are relayed only to the counterpart.
3. Media is peer-to-peer; nothing is recorded server-side.
