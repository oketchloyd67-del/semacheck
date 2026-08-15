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

**Security:**
- Passwords hashed with bcrypt (cost 12)
- JWT sessions, but **backed by a server-side session table** — this is what makes logout final. When you log out, that session is flipped inactive in the database immediately, so even if someone finds the token still sitting in a public computer's browser, it's already worthless and they're forced to log in again.
- Helmet security headers, CORS allow-list, parameterized SQL everywhere (no injection surface)
- Tiered rate limiting: general browsing, auth attempts, search, and payments each have their own ceiling
- Admin routes live under a separate, unlinked path with a separate JWT secret
- ID document uploads: filename randomized on disk (never trusts the user's original filename), type-checked (JPG/PNG/WEBP/PDF only), size-capped at 8MB, served only through an authenticated admin route

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
