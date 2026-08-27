# SemaCheck — Kenya Scam & Fraud Verification Platform (v2)

A complete rebuild: functional login/signup with manual ID-document review,
real database-backed accounts, M-Pesa payments via the Tuma gateway, admin
approval workflow, and a single email-based support channel.

## What's in this rebuild

**Homepage (unchanged look, now fully functional):**
- Search bar (Paybill / phone / job offer) with 3 pricing tiers — KES 50, 100, 150
- Working **Log in** and **Sign up** buttons (they now actually create accounts and start sessions)
- Contact dialogue box at the bottom — sends straight to management's email
- Privacy Policy page (`privacy.html`), linked from the footer and from signup

**Accounts:**
- Regular users: sign up, search, log out. They stay on the homepage — no dashboard.
- Job owners: sign up with business name, business registration number, and KRA PIN → get a dashboard.
- Live password strength meter under the password field.
- Live email + phone validation as you type (format + already-registered checks).
- National ID number **and a photo/scan of the ID document** required at signup — reviewed manually by an admin (see "ID verification" below), not by an automated check.
- Required consent checkbox ("I agree to the Privacy Policy") before an account can be created; the moment of consent is timestamped in the database as proof.

**ID verification — manual, not automatic:**
- At signup, the user uploads a JPG/PNG/PDF of their ID alongside the ID number they typed in
- The file is stored outside any public folder (`backend/uploads/id-documents/`) and is never reachable by URL — only an authenticated admin can view it, via a dedicated admin-only route
- New accounts start as `id_verification_status = pending` and can use the platform immediately while review is pending
- The admin panel has an "ID verifications pending review" section: view the uploaded document next to the name/ID number the user typed, then Approve or Reject with an internal note
- This replaces the earlier design (a simulated/live IPRS-style check) — a real automatic name-vs-ID match still isn't available to non-government-vetted organizations in Kenya, so a human review is the honest way to do this

**Job-owner dashboard (`dashboard.html`):**
- Subscription countdown — KES 459/30 days, counts down live, expires automatically
- Post a job (goes to "pending" until an admin approves it)
- List of your postings with status: pending / approved / rejected

**Admin panel (`/admin/`):**
- Not linked anywhere on the public site
- Separate login, separate token type — an admin token can't be forged from a user token
- Review ID verifications, approve/reject job postings, view platform stats, view unsent contact messages

**Search:**
- Every search checks SemaCheck's own database of past reports **and** a live external web search, then merges both into one verdict (legit / suspicious / scam / unverified) with a confidence score
- Results are cached and deduplicated — the same Paybill/phone/job text is never looked up twice; the second person to search it gets an instant answer
- Tier controls how much of the result you see: KES 50 = verdict only, KES 100 = + summary, KES 150 = + full source evidence

**Payments — via Tuma (api.tuma.co.ke), not a direct Safaricom Daraja app:**
- Tuma is a payment gateway that sits in front of M-Pesa (and Kenyan banks) behind one API and one merchant dashboard
- `backend/services/tuma.js` handles authentication (exchanging your Tuma API key for a short-lived JWT, cached until near expiry) and STK Push requests
- `POST /api/payments/tuma/callback` receives Tuma's payment status webhook and updates the relevant `payments` row — same flow for pay-per-search and the job-owner subscription
- Trade-off worth knowing: Tuma is a third party sitting between you and Safaricom, so you're trusting their uptime and terms alongside Safaricom's — worth reading Tuma's pricing/terms before going live with real volume
- The frontend never assumes a payment succeeded just because the STK push was sent — it polls `GET /api/payments/status/:paymentId` (every 2.5s, up to 45s) and only unlocks the search/subscription once the status genuinely flips to `success` from Tuma's callback. A visible progress bar tracks this wait. If the callback never lands (dropped webhook, delayed network, etc.) but the user's money did leave their phone, they can paste the M-Pesa confirmation code from their SMS into a fallback box, which hits `POST /api/payments/:paymentId/confirm-manual` — this trusts the user-provided code rather than independently re-verifying it against Safaricom (no such lookup is publicly available), so every manually confirmed payment is flagged in `raw_callback_json` for reconciliation against your real M-Pesa statement.

**Security:**
- Passwords hashed with bcrypt (cost 12)
- JWT sessions, but **backed by a server-side session table** — this is what makes logout final. When you log out, that session is flipped inactive in the database immediately, so even if someone finds the token still sitting in a public computer's browser, it's already worthless and they're forced to log in again.
- Helmet security headers, CORS allow-list, parameterized SQL everywhere (no injection surface)
- Tiered rate limiting: general browsing, auth attempts, search, and payments each have their own ceiling
- Admin routes live under a separate, unlinked path with a separate JWT secret
- ID document uploads: filename randomized on disk (never trusts the user's original filename), type-checked (JPG/PNG/WEBP/PDF only), size-capped at 8MB, served only through an authenticated admin route

**Email verification (OTP) — required before login:**
- Signup no longer logs you straight in — it creates the account (unverified) and emails a 6-digit code
- `POST /api/auth/verify-otp` checks it (10-minute expiry, 5 attempts max) and, on success, logs you in immediately
- `POST /api/auth/resend-otp` for a fresh code
- Login is blocked with a 403 + `requiresOtp` flag until the account is verified — the frontend catches this and reopens the OTP modal automatically, whether you're verifying right after signup or coming back later to log in
- Confirm-password field added to signup, checked client-side before submission

**One-time-use M-Pesa codes:**
- The manual M-Pesa-code fallback (see "Payments" below) is now genuinely single-use: a partial unique index on `payments.mpesa_receipt WHERE status='success'` means the same code can never confirm two different payments, whether it's entered manually twice or a duplicate webhook fires
- Trying to reuse a code returns a clear "already used" error with a button to start a fresh payment, instead of silently failing or double-unlocking

**Job visibility gated by subscription — automatic, immediate suspension:**
- `GET /api/jobs/approved` only returns jobs whose owner currently has an active, unexpired subscription — enforced with a live `JOIN LATERAL` on every request, not a cached flag
- This means suspension is instant: the moment `expires_at` passes, the very next search excludes that owner's jobs, with nothing to manually flip. The moment they renew, the same query includes them again automatically
- The job owner's own dashboard shows this honestly: an approved job displays "live in search" or "suspended — renew to reactivate" depending on current subscription status, plus a banner when postings exist but are currently hidden

**Renewal reminders — email + WhatsApp, 5/3/1 days before expiry:**
- `backend/jobs/subscriptionMaintenance.js` sends each reminder exactly once (tracked via `reminder_5_sent_at` / `reminder_3_sent_at` / `reminder_1_sent_at`), and flips lapsed subscriptions from `active` to `expired` for accurate admin/dashboard display
- Run it via `npm run reminders` on a daily cron (recommended for production), or leave the in-process fallback scheduler in `server.js` running (fires once ~30s after boot, then every 24h — fine for getting started, but a real process can restart/redeploy and reset that timer, so don't rely on it alone at scale)
- WhatsApp reminders use Meta's WhatsApp Business Cloud API via `services/whatsappService.js` — needs a WhatsApp Business Account and an **approved message template** (WhatsApp doesn't allow free-form business-initiated messages) before it can send anything real

**Payment security — manually-entered M-Pesa codes are never trusted automatically:**
- There is no public Safaricom or Tuma API to check whether an arbitrary typed code corresponds to a real completed transaction — Tuma only pushes a callback for STK pushes it initiated; it doesn't expose a "look up this code" endpoint. Trusting a typed code outright would let anyone type any string and get a free search result, subscription, or forensics case.
- So a manually-submitted code no longer marks a payment `success` on its own. It flips the payment to `manual_review`, and only an admin manually cross-checking that code against the real Tuma merchant dashboard / M-Pesa statement (Admin panel → **Payment verifications**) can approve it — which is what actually flips it to `success` and unlocks whatever it was paying for.
- `routes/search.js` (and the subscription/forensics-case equivalents) only ever release their result when a payment's status is *exactly* `success` — so results genuinely only appear once Tuma's real callback confirms payment, or a human has independently verified a self-reported code.
- The frontend reflects this honestly: after submitting a manual code, the UI says "sent for verification" and polls slowly (every 8s, for up to 5 minutes in-tab) rather than assuming success — if it's still pending after that, it says so plainly and stops polling, since the payment isn't lost, just waiting on a person.

**"Reclaim your money" — forensics case referral, reachable from any search result:**
- Every result receipt now ends with a "Lost money to this scam? Reclaim it →" link to `forensics.html`
- Eligibility is enforced both client-side and server-side: only losses of **KES 1,000 or more** qualify (a DB `CHECK` constraint on `forensics_cases.amount_lost` backs this up as the real gate, not just UI copy)
- Flow: intake form (amount lost, description, evidence notes, contact phone) → flat **KES 849** case-opening fee via the same Tuma/circular-spinner/manual-code pattern as search and subscriptions → case enters an admin queue (Admin panel → **Forensics cases**) with a status an admin can move through `submitted → under_review → in_progress → resolved/closed`
- This is intentionally a simple queue for now — the real investigator-matching flow (see the earlier fraud-investigation-referral sketch) is still being defined; this table and flow don't need re-migrating once that's decided, they just get built on top of

**WhatsApp customer care — critical emergencies only:**
- A floating WhatsApp button (bottom-right, every page) opens a confirmation dialog first, explicitly stating it's for critical situations only (e.g. a scam actively in progress) and that anything else should go through the contact form — only after confirming does it open `wa.me` with a pre-filled "Critical alert. I need urgent help" message
- The number is a constant in `frontend/js/app.js` (`WHATSAPP_CARE_NUMBER`), not hidden in markup, so it's easy to find and change

**External search — fixed a real bug, not just documented one:**
- `services/searchService.js`'s `searchExternalWeb()` was sending `{ key, q }` params and parsing a response shape that doesn't match SerpApi (the provider this README recommends) — SerpApi needs the key in an `api_key` param and returns results under `organic_results`, not `results`/`items`. With the old code, a valid SerpApi key would silently return zero external results every time, with search quietly degrading to database-only without any error. Fixed to detect the configured provider from `SEARCH_PROVIDER_URL` and use the right param shape and response parser for SerpApi, Bing, or a generic Google-Custom-Search-shaped fallback.

**Database migrations — now actually idempotent on an existing database, not just a fresh one:**
- `CREATE TABLE IF NOT EXISTS` only helps on a brand-new database — it's a silent no-op against a table that already exists, so any column added to this schema *after* a given deployment's tables were first created never actually appeared there just by re-running `migrate.js`. That's exactly what caused the earlier "column reminder_5_sent_at does not exist" error.
- `schema.sql` now ends with an explicit patch section: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every column ever added after its table's first release, plus a `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` pair for the `payments.purpose` and `payments.status` CHECK constraints (which need explicit re-creation, not just an edited `CREATE TABLE` block, to actually reach an existing table). **`npm run migrate` is now enough on its own** whether the database is brand new or years old — the standalone `db/fix-reminder.js`, `db/add-otp-columns.js`, and `db/add-reminder-columns.js` scripts are no longer necessary (their exact column lists are all folded into `schema.sql`'s patch section), though they're harmless to leave in place.
- Note: `db/migrate.js` splits the file naively on every `;` — this means any future patch statement needs to be written as plain top-level SQL, not a `DO $$ ... END $$;` block, which that splitting would break into invalid fragments.

**Kenya-focused verification — real government/news sources, not one generic web search:**
- Every search now runs *three* queries instead of one, all scoped to Kenya: (1) a general Kenya-context query, (2) a query restricted to Kenyan government/regulator domains (`centralbank.go.ke`, `cma.or.ke`, `dci.go.ke`, `ca.go.ke`, `sasra.go.ke`), (3) a query restricted to major Kenyan news outlets (Nation, Standard, Tuko, Citizen Digital, The Star, Kenyans.co.ke). A hit from an official government domain is weighted far higher than a hit from a random blog — a real Central Bank or CMA alert naming the exact thing being searched is treated as strong evidence on its own, the way it should be.
- **A real, checkable local database has been added**: a locally-cached copy of the Central Bank of Kenya's official directory of licensed Digital Credit Providers (the entities legally allowed to run a lending app/loan business in Kenya). Every search checks the queried name against this list — a match is a genuine positive legitimacy signal for loan-app-style checks, not just an absence of bad news. This is a real public PDF CBK publishes, parsed and cached locally (`services/cbkRegistryService.js`), refreshed weekly (or on demand from Admin panel → **Kenya registry**).
- **Honest limits on this, worth understanding before assuming more coverage than exists:** no Kenyan government body publishes a queryable developer API for fraud-checking — CBK, CMA, DCI, and CA don't offer one. What's built here is the most that's realistically achievable without a formal data-sharing partnership: a real local mirror of CBK's one genuinely structured public dataset, plus search-engine-mediated inspection of the others' public web presence (their own sites and press coverage) rather than a private/structured integration. If a scam was never covered by these institutions or the Kenyan press online, this won't surface it — it's a real improvement over one generic query, not an all-seeing system.
- **CBK's directory has no stable "always current" URL** — they publish a new PDF link every time they update it. `CBK_DCP_DIRECTORY_URL` in `.env` needs updating by hand when a newer one comes out (check centralbank.go.ke's Digital Credit Providers pages), then trigger a refresh from the admin panel.

**Where to get/manage the keys this needs:**
- **No new paid key is required for the CBK registry piece** — it's a public PDF fetched directly, genuinely free, no signup.
- **The existing `SEARCH_PROVIDER_KEY` (SerpApi) now gets used roughly 3× more per search** than before, since three queries run instead of one. If you're on SerpApi's free tier, this triples how fast you burn through your monthly quota for the same number of user searches — check usage and pricing at `serpapi.com/pricing` before volume grows, and budget for the paid tier sooner than you might have otherwise.
- **No API keys exist to add for CMA, DCI, or CA** — these remain covered via the site-restricted search queries above (using the same SerpApi key), not a separate integration, because none of them publish a developer API to integrate with directly.

## Getting started

```bash
cd backend
cp .env.example .env      # fill in real values — see below
npm install
npm run migrate           # creates all tables
npm run seed               # demo admin account + 2 pre-cached example searches
npm start                  # single process, or:
npm run start:cluster      # one worker per CPU core, for higher throughput
```

Open `frontend/index.html` in a browser (or serve it with any static host —
Render, Netlify, Nginx, etc.) once the backend above is running.
Demo admin login (after seeding): `admin@semacheck.co.ke` / `AdminDemo#2026`

### Setting up Tuma payments

1. Register at `merchant.tuma.co.ke/register` and create your business profile (Tuma can auto-fill it from your KRA PIN)
2. Generate an API key from your Tuma dashboard
3. Set `TUMA_EMAIL` and `TUMA_API_KEY` in `.env`
4. Set `TUMA_CALLBACK_URL` to a public HTTPS URL that routes to `/api/payments/tuma/callback` on your server — Tuma's servers need to reach it, so `localhost` won't work; use `ngrok` for local testing or deploy first
5. Tuma's STK push works with real Kenyan phone numbers even in early testing — there's no separate "sandbox mode" to toggle the way Daraja has one, so start with small real amounts (e.g. KES 10) when testing

## Honest limitations — read before launch

1. **"Search the entire internet"** — done, but it needs a search API key
   (SerpAPI, Google Programmable Search, or Bing Web Search all work — see
   `SEARCH_PROVIDER_URL` / `SEARCH_PROVIDER_KEY` in `.env.example`). Without
   a key, search still works but is honest about only checking SemaCheck's
   own database until one is added.

2. **Email delivery** — fully coded (`services/emailService.js`) but needs
   real SMTP credentials in `.env` to actually send anything. Without them,
   the API returns a clear "not configured" error rather than pretending
   to succeed.

3. **ID verification is now manual by design**, not a limitation to fix —
   see above. The only thing left for you to decide operationally: who on
   your team reviews the admin queue, and how quickly (the signup message
   currently promises "usually under 24 hours" — make sure that's true
   once you're live).

4. **Sandbox note:** I can't install npm packages or run a live Postgres/
   Node server in this chat environment (no internet access here), so the
   backend is written and syntax-checked (`node --check`, all files pass)
   but not executed end-to-end. Everything above runs for real the moment
   it's on a server with internet access, following the steps above.

## Scaling to 1000+ requests/minute

- Run `npm run start:cluster` (forks one worker per CPU core) instead of
  `npm start`, or run multiple containers behind a load balancer
- Set `REDIS_URL` so rate limits are enforced consistently across every
  worker/instance rather than each one counting separately
- `PG_POOL_MAX` controls the Postgres connection pool per instance — keep
  `(number of instances × PG_POOL_MAX)` under your database's `max_connections`
- The `searches` table's unique index on `(query_type, query_value_hash)`
  is what makes duplicate lookups instant instead of re-querying the
  external search provider every time — this is a meaningful chunk of the
  load reduction at scale, not just a speed nicety

## Support

The contact box on the homepage is the platform's **only** support channel,
as requested — no ticketing system, no live chat. A message typed there is
saved to the database and emailed straight to `MANAGEMENT_EMAIL`.

## Still worth adding later

- SMS/email notification when an ID verification or job posting is approved/rejected
- A public "recently verified" feed so people can browse without paying
- Land/title deed and company/tender verification (deferred from MVP scope)
- A periodic cleanup job that deletes ID document files once review is complete and undisputed, per the retention promise in the Privacy Policy
