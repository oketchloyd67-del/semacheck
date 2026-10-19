# Moving off free hosting — recommendation

Filed from a hosting research pass on 16 October 2026. Context: customers are about to
integrate, and a payment-triggered API cannot wait for a cold start. The frontend already
lives on Vercel and can stay there; this is about the Node API, Postgres and the upload files.

## Recommendation: paid Render (Starter web service) + Render Postgres, Frankfurt

- **Rough cost:** ~US$26–30/month (US$7 Starter web service + ~US$19 1 GB Postgres), rising to
  roughly US$44–50/month if the Node process needs the US$25 web plan. Upload storage extra.
- **Why:** the backend is already on Render, so this is a plan upgrade rather than a rewrite —
  least migration risk before customers integrate. Render documents that the ~1 minute wake-up
  is a **free-tier** behaviour; paid web services run continuously, which removes the cold-start
  problem that motivates this move. Managed Postgres on paid plans has documented
  point-in-time recovery, and Git-linked deploys, custom domains and managed TLS are built in.
- **Runner-up:** Railway Pro (~US$30/month for a small app + Postgres). Better if you prefer its
  deploy workflow and usage pricing; you then own the Postgres service's backups and volumes.

Sources: <https://render.com/pricing>, <https://render.com/docs/free>,
<https://render.com/docs/postgresql-backups>, <https://render.com/docs/disks>,
<https://render.com/docs/custom-domains>, <https://railway.com/pricing>,
<https://docs.railway.com/deployments/regions>.

## What is now in the repo (18 October 2026)

The decision above is recorded in code, but the purchase itself is a manual step and is
**not done yet**. What exists now:

- **`render.yaml`** pins the API to the paid `starter` plan (US$7/mo, always on, no idle
  spin-down) with `healthCheckPath: /api/ready` — a real readiness probe that queries the
  database, unlike `/api/ping`. Apply it by upgrading the existing service's instance type in
  the Render dashboard (simplest, keeps the URL) or by syncing the blueprint.
- **Growth and Scale are held off sale** until that has happened. `backend/config/infrastructure.js`
  refuses `POST /api/account/api/plan` for the KES 20,000 and KES 75,000 plans with HTTP 503
  `infrastructure_not_ready` while `ALWAYS_ON_HOST` is not `true`, and the dashboard shows those
  plans as "opening soon" and stops steering volume towards them. This is a safety interlock, not
  a nicety: without it a customer can pay KES 75,000 for an API that answers in a minute.
- **After the upgrade, set `ALWAYS_ON_HOST=true`** in the Render environment. That single
  variable opens the two plans.

Two things to check while you are in the dashboard:

1. **Free Render Postgres expires 30 days after creation** (with a 14-day grace period before
   deletion). If the database behind this API was created on the free plan, upgrade or migrate it
   *before* that date — `pg_dump` → restore → verify → switch `DATABASE_URL`, as in the checklist
   below. Do not delete the old database until the new one is verified.
2. **Keep the webhook hostname stable.** Tuma's callback URL and every customer's webhook point at
   the current host; a second service created by a blueprint sync would get a new hostname and
   silently stop delivering payments.

## Alternatives considered (monthly, small always-on Node + Postgres)

| Option | Rough cost | Notes |
| --- | --- | --- |
| Render paid (recommended) | US$26–50 | No sleep on paid compute; closest region Frankfurt (~135–142 ms Nairobi RTT sample) |
| Railway Pro | ~US$30 | Usage-based; Postgres is a service you operate; Amsterdam region |
| Fly.io | ~US$44+ | Managed Postgres alone starts ~US$38; watch machine auto-stop settings |
| DigitalOcean VPS + managed Postgres | ~US$27–33 | More ops work; closest regions Frankfurt/Amsterdam/London |
| Hetzner VPS + Docker | ~€5+ | Cheapest, but you run Postgres, backups, TLS and patching yourself |
| Nairobi VPS (e.g. Hostraha, KES 2,499/mo) | ~US$20 | Lowest latency for Kenyan users; self-managed database and no documented managed-Postgres/backup story |
| AWS Cape Town / GCP Johannesburg | calculator-dependent | Nearest cloud regions to Kenya (~52 ms city RTT sample) but more billing/config complexity |

## Migration checklist

1. **Uploads off ephemeral disk.** The ID documents and evidence files live in
   `backend/uploads/`, which is wiped on a redeploy on most PaaS hosts. Move them to private
   S3-compatible object storage (Cloudflare R2 or DigitalOcean Spaces), keep the bucket private
   and serve through short-lived signed URLs or an authenticated route.
2. **Copy every env var deliberately** — `DATABASE_URL`, `TUMA_*`, `API_KEY_HASH_SECRET`,
   `ADMIN_JWT_SECRET`, session secret, CORS allowlist, `REDIS_URL`, Brevo key, plus
   `STATUS_PROBE_SECRET` (the status page's external prober, see
   `.github/workflows/uptime-probe.yml`) and `ALWAYS_ON_HOST` once the paid instance is live.
3. **Postgres cutover, not a URL edit:** `pg_dump` → restore into the empty target → verify
   schema, row counts, and SSL → short write pause → switch `DATABASE_URL` → keep the old DB
   until validation is done.
4. **Stable webhook URL.** Point Tuma callbacks at a hostname you own (custom domain + managed
   TLS) rather than a provider hostname, so future moves don't break payments.
5. **Cron-like jobs:** `jobs/subscriptionMaintenance.js`, `apiPlanReminders.js`,
   `enforceApiBilling.js` and `generateApiInvoices.js` must keep running on a schedule —
   either keep the API at one instance with in-process timers or add a scheduler, and make sure
   each job is safe against double execution.
6. **Webhook resilience:** confirm Tuma's retry/signature contract directly with them (not
   documented publicly), make `/api/payments/tuma/callback` idempotent, persist the event before
   acking, and reconcile payment status so a missed callback never leaves a customer charged
   without a result.

## Admin panel security (19 October 2026)

- **The shared admin password was rotated in the production database.** The new value was
  handed over once outside this repository; it is not in code, docs or git. If it is lost, use
  the recovery command below rather than a seed run (seeding refuses to change an existing
  admin's password).
- **Two-factor authentication is mandatory.** The first sign-in after this deploy asks the
  admin to add the account to an authenticator app and confirm a 6-digit code. Every later
  sign-in needs that code. Sessions last **4 hours**, and changing a password increments
  `admins.session_version`, which immediately invalidates every other token — including one
  that leaked.
- **Roles:** `super_admin` (everything), `reviewer` (ID/organisation verification, jobs,
  reports, disputes — no plans or settings), `support` (read-only plus webhook retry and status
  notices). Enforced server-side by `requireRole`, not just hidden in the UI.
- **Audit trail:** `admin_audit_log` records logins, credential changes, approvals, rejections,
  suspensions, plan changes, document views, payment re-queries and every other privileged
  action; `admin_login_attempts` records failed sign-ins with the reason. The Audit log tab is
  super-admin only and has no delete endpoint.
- **Payment reconciliation:** the Payments tab lists payments stuck in initiated/pending for
  more than 2 minutes and failures from the last 7 days, and can re-query Tuma for the live
  status. A confirmed success applies the same side effects as a normal callback.

### If an admin is locked out

From the backend directory, against the database in `DATABASE_URL`:

```bash
node db/admin-recovery.js --email you@example.com --disable-2fa
node db/admin-recovery.js --email you@example.com --reset-password
```

Both sign out every existing session. The new password is printed once to that console and is
never written to disk or the database in clear text. `--disable-2fa` makes the next sign-in
re-enrol an authenticator.

### Deploying the admin panel

The panel is served from `admin-deploy/` on Vercel (`https://semacheck-admin.vercel.app`). The
API-side changes go out with the Render service; the login/dashboard changes need the admin
Vercel project to redeploy from `main`.

## Verification limits of this research

- Render's pricing page did not render its full price table during extraction — confirm the
  current Postgres price in the dashboard before purchase.
- Vultr's pages returned 403, so its prices and Johannesburg Postgres availability are unverified.
- Nairobi-hosted VPS providers advertise local hosting and SLAs, but operational history and
  backup quality were not verified.
- RTT figures are city-to-city samples, not provider SLAs.
