# Production Deployment — Hospital ERP

Backend: **api.cenaps.in**  •  Frontend: **dev.cenaps.in**

This is the single source of truth for getting both services live and correctly
configured. It reflects the production-readiness changes made on the
`production-ready` branch.

---

## TL;DR

1. **Backend** — set the env vars from `.env.production.example`, then start with
   `npm start` (or the Docker image). On start it:
   - provisions the schema with `prisma db push` (the migration history can't
     replay cleanly, so we sync the schema directly — takes ~2s), then
   - **auto-seeds all reference data** on boot (idempotent, advisory-locked).
   No manual migrate/seed step is required.
2. **Frontend** — set `NEXT_PUBLIC_API_URL=https://api.cenaps.in/api/v1` **at
   build time**, then `npm run build && npm start`. Rebuild whenever a
   `NEXT_PUBLIC_*` value changes.

---

## 1. Backend (api.cenaps.in)

### Required environment
Copy from [`.env.production.example`](./.env.production.example). The essentials:

| Var | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your managed Postgres URL (`?sslmode=require` if needed) |
| `REDIS_URL` | your managed Redis URL — **required** (rate limiting + login lockout) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | two long random strings (different) |
| `FRONTEND_URL` | `https://dev.cenaps.in` |
| `CORS_ORIGINS` | empty = allow all origins (current policy); set to lock down |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | optional; **live** keys enable payments |
| `AUTO_SEED` | `true` (default in production) |

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Start command
```bash
npm ci
npm run build          # tsc -> dist/
npm start              # = prisma db push --skip-generate && node dist/server.js
```
`npm start` provisions the schema then boots. If your platform provisions the
schema separately, use `npm run start:no-provision` instead.

### Docker
The provided `Dockerfile` already does the right thing — its `CMD` runs
`prisma db push --skip-generate` then the server. Mount a volume for `/app/uploads`
(uploaded files/DICOM) if you need persistence. The vendor drug catalogue ships in
the image under `prisma/scripts/data/drug-catalog` (~104 MB of gzipped NDJSON plus a
checksummed manifest), so seeding works with **no internet access**.

### What gets auto-seeded on boot
Runs after the server is listening (health checks pass immediately). All steps
are idempotent; heavy catalogs are skipped once populated.

- **Platform** — permissions, platform roles, super admin, subscription plans,
  commission. *Runs every boot (fast).*
- **Catalogs** — lab units, lab test templates, patient form templates, physical
  observation catalog. *Idempotent upserts every boot.*
- **ICD-10 codes** — seeded once, then skipped.
- **Drug catalogue** — the vendor release bundled with the build (June 2026:
  399,090 drugs + 344,873 OTC products, with their monographs). Imported once per
  release, then a single query per boot. On a database that still holds the old
  open dataset, the first boot re-points every hospital formulary row imported
  from it at the same product in the new catalogue, carries hand-added GTINs/HSNs
  across, and deletes the old rows; hospital prices and stock are never touched.
  The salt-master, classification and search-index steps then pick the new
  products up by themselves. Check the result with `npm run db:check-drug-catalog`.
  *Measured on a dev machine:* import ~13 min on an empty database (texts ~1.5 min,
  products ~11 min); on a database holding the old dataset add ~3 min to retire it.
  Salt linking ~4 min, then classification of all 744K products, in the
  background after the server is already answering: **33 minutes** measured on
  the dev machine (744,395 catalogue and formulary rows in 1,993 s, a steady
  ~370 rows/s with the search indexes present, which keep search fast meanwhile).
  Every later boot: 13 s for the whole auto-seed, the catalogue step itself one
  query (5 ms). The server is usable throughout; a catalogue drug imported into a
  formulary before classification reaches it is classified on the spot.
- **Retail products** — catalogue rows from the OTC workbook import into the
  hospital formulary as `product`, while rows from the two drug workbooks import
  as `drug`. Products use the same batches, barcodes, HSN/GST, stock ledger and
  counter-sale path as medicines, but are deliberately excluded from
  prescriptions, salt/schedule classification and CDSS interaction checks. The
  schema change is additive (`InventoryCategory.product` plus nullable
  `drug_formulary.product_category`) and is applied automatically by the Docker
  start command. Verify the complete path with `npm run db:check-retail-products`.
- **Imaging modalities** + **role-permission resync** — per-tenant, self-healing
  for tenants created between deploys.

**Super admin login (change the password after first login):**
`admin@hospital.com` / `Admin@123`

To disable auto-seed: `AUTO_SEED=false`. To seed manually instead:
`npm run db:seed:all` (or individual `npm run db:seed:*` scripts).

### CORS
Handled entirely by the API. The Cenaps first-party origins are always allowed.
Default = allow any origin (with credentials reflected). To restrict additional
origins, set
`CORS_ORIGINS=https://dev.cenaps.in` and redeploy.

### DICOM viewer (only if `PACS_PROVIDER=orthanc`)
The OHIF viewer iframe is served from api.cenaps.in but embedded in dev.cenaps.in
(cross-domain), so the session cookie must be cross-site:
```
PACS_PROXY_ENABLED=true
PACS_PROXY_PUBLIC_URL=https://api.cenaps.in
PACS_COOKIE_SAMESITE=none
PACS_COOKIE_SECURE=true
```
Leave `PACS_PROVIDER=none` (default) to use the in-house viewer with no extra infra.

---

## 2. Frontend (dev.cenaps.in)

`NEXT_PUBLIC_*` values are **baked into the bundle at build time**. The #1
deployment bug is building with the default `localhost:4000` API URL — every
request then fails (looks like a CORS/network error). Set these before `next build`:

```
NEXT_PUBLIC_API_URL=https://api.cenaps.in/api/v1
NEXT_PUBLIC_APP_NAME=Hospital ERP
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxx
```
(See [`.env.production.example`](../frontend/.env.production.example).)

### Build & start
```bash
npm ci
npm run build
npm start               # next start (standalone)
```

### Docker
The frontend `Dockerfile` accepts the values as build args:
```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.cenaps.in/api/v1 \
  --build-arg NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_live_xxx \
  -t hospital-erp-frontend .
```
On a PaaS, set them as **build-time** env vars (not just runtime).

After changing any `NEXT_PUBLIC_*` value you must **rebuild** — restarting is
not enough.

> ⚠️ **`.env.local` overrides `.env.production`.** Next.js loads `.env.local`
> during `next build` and it wins over `.env.production`. The repo's local
> `.env.local` points at `http://localhost:4000`, so a **local** build bakes
> localhost. This is fine on the server (`.env.local` is gitignored and absent
> there — the platform's env vars / `.env.production` are used), but if you build
> locally for prod, remove/ignore `.env.local` or set `NEXT_PUBLIC_API_URL`
> explicitly in the build environment (a real env var beats every `.env` file).

---

## 3. Post-deploy smoke test

```bash
curl https://api.cenaps.in/health                     # {"status":"ok",...}
curl -i -X OPTIONS https://api.cenaps.in/api/v1/auth/login \
  -H "Origin: https://dev.cenaps.in" \
  -H "Access-Control-Request-Method: POST"            # 204 + Access-Control-* headers
```
Then open https://dev.cenaps.in and log in as the super admin. Confirm the browser
Network tab shows requests going to `https://api.cenaps.in/api/v1` (not localhost).

---

## Notes / gotchas

- **Migrations vs db push:** `prisma migrate deploy` fails on a fresh DB (a
  migration references `drug_master`, a table no migration creates). We therefore
  provision via `db push --accept-data-loss`, which always brings the DB in sync
  with `schema.prisma`. `--accept-data-loss` is required so non-interactive
  startup can apply changes the live DB lacks (e.g. a new unique index like
  `drug_returns.refund_id`); it still fails loudly on genuinely impossible
  changes (real duplicate values). ⚠️ It also means a schema change that **drops
  a column will drop it on deploy** — review `schema.prisma` diffs before
  shipping. Keep using `db push` for schema changes in this deployment.
- **Redis is strongly recommended** (rate limiting + login brute-force
  lockout). Rate limiting now **fails open** if Redis is unreachable — the API
  keeps serving (logged as warnings) rather than 500-ing every request — but
  without Redis you effectively have no rate limiting/lockout, so provision it.
- **Uploads** live on the local disk under `/app/uploads` — use a persistent
  volume (or migrate to object storage) so files survive redeploys.
