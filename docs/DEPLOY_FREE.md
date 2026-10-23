# Deploying PetVet AI for ₹0 (Cloudflare Pages + Pages Functions + Render + Neon)

This is the zero-cost deployment: the Angular app on **Cloudflare Pages**, a
**Pages Function** that forwards `/api/*` and the WebSocket to **Render Free**,
the API on **Render**, and PostgreSQL on **Neon**. Nothing here needs a paid
plan, a credit card or a domain — every service runs on its free tier and on the
provider's own HTTPS hostname.

The alternative single-service layout (Render serving the API *and* the built
Angular app) is in [DEPLOY_RENDER.md](DEPLOY_RENDER.md). It needs a paid Render
instance, because the Angular production build peaks at roughly **760 MB** and a
Render Free instance has **512 MB**.

```
Browser ──HTTPS──▶ <project>.pages.dev        (Cloudflare Pages, free)
                     ├── /              Angular app (static)
                     ├── /dashboard     Angular app (SPA fallback)
                     ├── /api/*         Pages Function → Render
                     └── /socket        Pages Function → Render (WebSocket)
                                              │
                                              ▼
                                  petvet-api.onrender.com (Render Free, API only)
                                              │  TLS
                                              ▼
                                       Neon PostgreSQL (free)
```

Everything durable lives in Neon: users, pets, records, appointments, chat, the
knowledge base — and uploaded files, stored as `bytea` (`FILE_STORAGE=db`),
because a Render Free instance has no persistent disk.

---

## 0. What is already in the repository

| Path | Purpose |
| --- | --- |
| [render.yaml](../render.yaml) | Render Blueprint for the **API-only** service (free plan) |
| [infra/cloudflare/proxy.ts](../infra/cloudflare/proxy.ts) | The edge proxy: forwards REST and WebSocket traffic, keeps the browser's `Origin`, turns Render cold starts into a readable message |
| [functions/api/[[path]].ts](../functions/api/%5B%5Bpath%5D%5D.ts) | Pages Function for `/api/*` |
| [functions/socket/[[path]].ts](../functions/socket/%5B%5Bpath%5D%5D.ts) | Pages Function for the WebSocket at `/socket` |
| [apps/web/public/_routes.json](../apps/web/public/_routes.json) | Restricts Function invocations to `/api/*` and `/socket*`; copied into the build output automatically |
| [apps/api/src/ws.ts](../apps/api/src/ws.ts) | Serves the socket on `/ws` (single-service) **and** `/socket` (behind Pages) |
| [apps/web/src/app/core/ws.service.ts](../apps/web/src/app/core/ws.service.ts) | Opens `wss://<same host>/socket` |

### Why the socket is at `/socket` and not `/ws`

Cloudflare Pages does not route `/ws` to a Function: a probe Function declared
on that path was never invoked — `GET /ws` came back with the SPA's
`index.html` instead (verified with `wrangler pages dev`), which would break a
socket handshake. The same code at `/socket` proxied the upgrade and delivered
frames. The API therefore answers on both paths, so the app behaves identically
whether it is served by Pages or directly by the API.

### How requests behave

* REST calls from the browser are same-origin (`/api/...`), so no CORS applies
  to them; the Function forwards method, path, query, headers, bearer tokens and
  multipart bodies unchanged.
* The browser's `Origin` header is forwarded as-is, so the API still validates
  sockets against `WEB_ORIGIN` — the proxy does not become a way around it.
* WebSocket upgrades are forwarded as the original `Request` object. This detail
  matters: `Upgrade` is a forbidden Fetch header, so rebuilding the request from
  a copied header map silently downgrades it to a plain GET (the API then answers
  200 with the SPA HTML). `new Request(target, request)` keeps the upgrade.
* When Render is asleep, the Function answers `503` with a readable message and
  `Retry-After: 30` instead of passing an opaque gateway error to the app.

---

## 1. Push the project to GitHub

Render and Cloudflare both deploy from Git.

```bash
git init
git add .
git commit -m "PetVet AI"
git branch -M main
git remote add origin https://github.com/<you>/pet-vet-ai.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `.env.local`, `.data/`, `uploads/`,
`node_modules/` and both `dist/` folders, so no secrets or build output are
committed. Never commit `.dev.vars` either (it is ignored after step 6).

---

## 2. Create the database on Neon (free)

1. <https://console.neon.tech> → **New Project**, PostgreSQL 16, region
   **Singapore** (or the closest to your Render region).
2. Open **Connect** and copy the **pooled** connection string — the host
   contains `-pooler`:

   ```
   postgresql://USER:PASSWORD@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

3. Keep it for the Render step. The API migrates the schema itself on first
   boot (`db/migrations/001…005`), so there is nothing to run here.

Neon's free plan gives 0.5 GB of storage and suspends the compute when idle; the
first query after idle reconnects automatically through the pool.

---

## 3. Deploy the API on Render (free, API only)

### Option A — Blueprint (recommended)

1. <https://dashboard.render.com> → **New → Blueprint** → pick the repository.
2. Render reads [render.yaml](../render.yaml) and asks for three values:
   * `DATABASE_URL` → the Neon pooled string from step 2
   * `WEB_ORIGIN` → your Pages production origin, e.g. `https://petvet.pages.dev`
     (you will have it after step 4; enter a placeholder such as
     `https://petvet.pages.dev` now if you prefer to do Pages first)
   * `NOMINATIM_USER_AGENT` → `PetVetAI/1.0 (your-real@email.com)`. OpenStreetMap
     needs a genuine contact address; it answers **403** to `example.com`
     addresses, which breaks the hospital search with "Address lookup failed".
3. **Apply** and wait for the first deploy. The log should end with
   `[api] Pet Vet AI API listening on http://localhost:10000` and
   `[db] connected to PostgreSQL`.

### Option B — Manual web service

| Setting | Value |
| --- | --- |
| Runtime | Node 22 |
| Plan | Free |
| Region | Singapore (same as Neon if possible) |
| Build command | `NODE_ENV=development npm --prefix apps/api install --no-audit --no-fund && npm --prefix apps/api run build` |
| Start command | `npm run start:prod` |
| Health check path | `/api/health` |

Environment variables:

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | enables TLS for Postgres and strict config checks |
| `JWT_SECRET` | Render → **Generate** (or a 48-byte random hex string) | never commit it |
| `DATABASE_URL` | Neon **pooled** URL | secret |
| `WEB_ORIGIN` | `https://<project>.pages.dev` | exact origin, no trailing slash |
| `FILE_STORAGE` | `db` | uploads survive restarts |
| `SEED_CATALOG` | `true` | reference catalogs only, no accounts or pets |
| `APP_TIMEZONE` | `Asia/Kolkata` | drives "today", reminders and labels |
| `NOMINATIM_USER_AGENT` | `PetVetAI/1.0 (your-real@email.com)` | OpenStreetMap asks for a real contact address and rejects `example.com` addresses with 403 |
| `OVERPASS_ENABLED` | `true` | keyless nearby-hospital search |

`NODE_ENV=development` on the **build** line is deliberate: Render applies
service environment variables to the build too, and `npm install` under
`NODE_ENV=production` skips the devDependencies that `tsc` needs. Angular is not
built here at all.

---

## 4. Deploy the frontend on Cloudflare Pages (free)

1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages →
   Connect to Git**, pick the repository.
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | `Angular` (or `None`) |
   | Root directory | *(leave empty — the repository root)* |
   | Build command | `npm --prefix apps/web install --no-audit --no-fund && npm --prefix apps/web run build` |
   | Build output directory | `apps/web/dist/pet-vet-ai/browser` |
   | Environment variable | `NODE_VERSION=22` |

   Leave the root directory empty: the Pages Functions live in `/functions` at
   the repository root, and the build output is the nested Angular folder.

3. **Environment variables → Production** (and **Preview**, same values):

   | Name | Value |
   | --- | --- |
   | `API_ORIGIN` | `https://petvet-api.onrender.com` (your Render URL, no trailing slash) |
   | `NODE_VERSION` | `22` |

   `API_ORIGIN` is *not* a secret and never reaches the browser as a variable;
   the Function reads it at the edge. Do not put any secret in a variable that
   starts with `NG_` or is baked into the Angular build.

4. Deploy. The first build takes a few minutes; the log should show
   `Application bundle generation complete` and `Success: Your site was deployed!`.

5. Copy the production URL (`https://<project>.pages.dev`) into Render's
   `WEB_ORIGIN` and redeploy the API if you had not set it already.

### Why no `_redirects` file

Cloudflare Pages serves the root document for any path that is not a static
asset **when the build has no top-level `404.html`** — Angular's output has
none. That gives deep links (`/find-care`, `/pets/<id>`) a 200 without a
`_redirects` rule. `_routes.json` only whitelists `/api/*` and `/socket*` for
Function invocations, so static assets never spend compute.

### Preview deployments

Every Pages preview gets its own `*.pages.dev` origin. REST calls work there
(they are proxied server-side), but the API's WebSocket origin check compares
`Origin` with `WEB_ORIGIN`, so a preview URL cannot open the socket until you
either point a second Render service at it or promote the preview. Treat the
production URL as the app.

---

## 5. Create the first administrator

The seed ships catalogs only — no accounts, pets or clinics — so the first
administrator is created once, after the API has booted and migrated:

```bash
DATABASE_URL="postgresql://…-pooler…neon.tech/neondb?sslmode=require" \
NODE_ENV=production \
npm run create-admin --prefix apps/api -- you@example.com "A-strong-password" "Your Name"
```

Notes:

* Run it from the repository root, on a machine that can reach Neon. The inline
  `DATABASE_URL` wins over your local `.env` file.
* `NODE_ENV=production` is what enables TLS (`DATABASE_SSL` defaults to true in
  production); without it the connection to Neon fails with an SSL error.
* The command needs the `users` table, so it only works **after** the API's
  first boot has run the migrations.
* An existing email is promoted to `admin` without its password being changed.
* It prints no password and stores only a bcrypt hash.

Owners and veterinarians then register themselves at `/register`.

---

## 6. Verify the deployment

**Quick checks**

```bash
BASE=https://<project>.pages.dev
curl -s $BASE/api/health                     # {"status":"ok","database":"ok",…}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/find-care   # 200 — SPA deep link
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/pets    # 401 — auth is enforced
curl -s $BASE/api/config/public              # flags for this deployment
```

**In the browser** (production URL, JavaScript console):

1. Sign in, open **Find care**, search a city → hospitals come back from
   OpenStreetMap, distance-sorted, with "Open in Maps" links.
2. Upload a pet photo, then Render → **Manual Deploy → Restart**. The photo must
   still load: that proves it is in Postgres, not on a disk.
3. Open **Messages** with a veterinarian account in a second window — the socket
   is proxying if messages arrive live. To test the socket directly:

   ```js
   const t = localStorage.getItem('petvet_token');
   const ws = new WebSocket(`wss://${location.host}/socket?token=${encodeURIComponent(t)}`);
   ws.onmessage = (e) => console.log('frame', e.data);
   ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
   // expect a "ready" frame, then "pong"
   ```

4. Ask **Pet Vet AI** a question → the deterministic composer answers with
   citations (no LLM key on a free deployment).
5. Refresh a deep link such as `/find-care` → the app loads instead of a 404.
6. Wake-from-sleep: leave the site idle for ~20 minutes, then reload. The first
   request can take 30–60 seconds; the API answers after Render boots.

**Failure signals**

| Symptom | Meaning |
| --- | --- |
| `503 upstream_unavailable` / "API is waking up" | Render is asleep or restarting; retry after ~30 s |
| `500 proxy_not_configured` | `API_ORIGIN` is missing in the Pages environment |
| Socket closes immediately / 403 | `WEB_ORIGIN` on Render is not the exact Pages origin |
| Socket 502 "refused the handshake (HTTP 200)" | The proxy sent a plain GET; `new Request(target, request)` was replaced by a header copy |

### What has been verified locally (not yet on the live URLs)

`wrangler pages dev` was run on the built Angular output with the real Pages
Functions from `functions/`, `API_ORIGIN` pointing at the production build of
the API (`npm run start:prod`, `NODE_ENV=production`, `FILE_STORAGE=db`), and
PostgreSQL holding the data — the same topology as the deployed stack. All 18
checks below were run against that setup, 17 passing; the 18th is expected
behaviour, explained under the table.

| Check | Result |
| --- | --- |
| `/api/health` through Pages → Render path | 200, `database: ok` |
| `/api/pets` without a token | 401 JSON, passed through unchanged |
| Angular deep link `/find-care` | 200 with `index.html` (SPA fallback) |
| Unknown `/api/*` route | JSON error from the API (see note) |
| Register, login, authenticated `POST /api/pets` | 201 / 200 / 201 |
| Multipart upload (`FILE_STORAGE=db`) | 201, bytes stored in `bytea` |
| Download through the proxy | 200, SHA-256 identical to the upload |
| Download after a full API restart | 200, same SHA-256 (file survived) |
| Pet, thread and last message after restart | still present |
| WebSocket upgrade through the Pages Function | `ready` frame for two users |
| `ping` → `pong` over the proxied socket | received |
| Chat message owner → vet | delivered live over the socket |
| Typing indicator | relayed |
| WebRTC offer relayed for an accepted consultation | received with `fromUserId` |
| Foreign `Origin` handshake | 403, the proxy does not bypass the check |
| Socket reconnect with the same token (after restart) | `ready`, then `pong` |
| Same-origin CORS preflight | 204 with the Pages origin |
| Hospital discovery (`/api/maps/clinics?city=Chennai`) | 200, 2 clinics in ~2.5 s via Nominatim |

Note on the unknown-route row: the API has an authenticated `/api` guard, so an
unknown API path answers `401` JSON rather than `404`. The proxy returns exactly
what the API sent — it never substitutes the SPA, which is what matters here.

**Still to verify on the deployed URLs** (impossible from a local machine): the
Render build/start of this repository, Neon connectivity with TLS on, Cloudflare's
production WebSocket tunnel (local `workerd` is not proof of the edge behaviour),
Render cold starts after idle, and the Pages build settings themselves. Section 6
is the checklist for those.

---

## 7. Free-tier limits to expect

| Service | Free limits that matter here |
| --- | --- |
| Render Free | 512 MB RAM, 0.1 CPU, sleeps after ~15 min idle (30–60 s cold start); 750 instance-hours/month; no persistent disk (uploads go to Postgres) |
| Cloudflare Pages / Functions | Unlimited static requests; Functions are limited per day and per-invocation CPU. The proxy performs a single upstream fetch per REST call and one tunnel per socket |
| Neon Free | ~0.5 GB storage, compute suspends when idle, pooled connections (the API caps its pool at 10) |
| OpenStreetMap | Public Overpass mirrors are donated and often saturated; the API also queries Nominatim and merges both answers, and caches nothing |

No resource in this layout requires a credit card. If a provider changes its
free plan, the next-cheapest fix is a Render Starter instance for the API alone
(the frontend stays free on Pages).

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Pages build fails with `ng: not found` | Dependencies installed with `NODE_ENV=production`, so devDependencies were skipped | Use the build command above (no `NODE_ENV=production` prefix); add `NODE_VERSION=22` |
| Pages build succeeds but the site is the wrong folder | Output directory does not match `apps/web/dist/pet-vet-ai/browser` | Fix the setting; Angular prints the exact path |
| `/api/*` answers 404 HTML | Functions are not deployed or `_routes.json` excludes the path | Confirm `functions/` is at the repository root and `include` contains `/api/*` |
| `/api/*` answers `proxy_not_configured` | `API_ORIGIN` missing for that environment (Production vs Preview) | Set it for both |
| Render build fails on `tsc: not found` | `NODE_ENV=production` during install | Prefix the install with `NODE_ENV=development` |
| Render start fails: `tsx: not found` | Started with `start:api` (tsx is a devDependency) | Use `npm run start:prod` |
| Postgres `no pg_hba.conf entry … no encryption` | TLS off against Neon | Keep `NODE_ENV=production` (or `DATABASE_SSL=true`) |
| `too many connections` | Using Neon's direct host or several replicas | Use the `-pooler` host, one instance |
| `Address lookup failed (403)` on Find care | `NOMINATIM_USER_AGENT` has a placeholder address (`you@example.com`, `*.test`) | Set it to a real contact address, e.g. `PetVetAI/1.0 (you@gmail.com)`, and redeploy |
| Find care says it could not reach OpenStreetMap | Both public Overpass mirrors are saturated or refuse the request | Retry in a minute; city/town searches also use Nominatim, which usually answers |
| Photos vanish after a restart | `FILE_STORAGE` not `db` when they were uploaded | Set `FILE_STORAGE=db`, restart; older rows have no bytes stored |
| Admin command: `relation "users" does not exist` | Run before the API's first boot | Deploy first, then run it |
| CORS error in the console | The app is calling the API cross-origin (someone rebuilt with a different base URL) | Keep the same-origin `/api` calls; the proxy exists so this never happens |
| Deep link 404 | A `404.html` was added to the build output, which disables Pages' SPA fallback | Remove it |

Logs: Cloudflare → **Workers & Pages → your project → Deployments → Functions
logs**; Render → **your service → Logs**. Both sides log proxy failures, so a
502 can be traced to one of them.
