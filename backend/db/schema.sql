-- SemaCheck Database Schema
-- PostgreSQL

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS (regular users + job owners share this table, flagged
-- by account_type so we don't duplicate auth logic)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type        VARCHAR(20) NOT NULL CHECK (account_type IN ('regular', 'job_owner')),
    full_name           VARCHAR(150) NOT NULL,
    email               VARCHAR(150) UNIQUE NOT NULL,
    phone               VARCHAR(15) UNIQUE NOT NULL,          -- normalized 2547XXXXXXXX
    national_id         VARCHAR(20) UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    -- Email verification via one-time code sent at signup (see routes/auth.js
    -- /signup, /verify-otp, /resend-otp). Login is blocked until verified.
    email_verified       BOOLEAN NOT NULL DEFAULT FALSE,
    otp_code_hash         TEXT,
    otp_expires_at         TIMESTAMPTZ,
    otp_attempts            SMALLINT NOT NULL DEFAULT 0,
    -- ID verification is manual, not automatic: the user uploads a photo
    -- of their ID at signup and an admin reviews it against the name they
    -- gave (see routes/admin.js "ID verifications" endpoints).
    id_document_filename    TEXT,                               -- stored filename under backend/uploads/id-documents/
    id_verification_status  VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (id_verification_status IN ('pending', 'approved', 'rejected')),
    id_verification_reviewed_by  UUID,                          -- admins.id
    id_verification_reviewed_at  TIMESTAMPTZ,
    id_verification_notes        TEXT,                          -- admin's reason if rejected
    -- job owner specific fields (NULL for regular users)
    business_name        VARCHAR(200),
    business_reg_number   VARCHAR(60),
    kra_pin              VARCHAR(20),
    business_verified    BOOLEAN DEFAULT FALSE,                 -- admin sign-off on business documents
    privacy_consent_at    TIMESTAMPTZ,                           -- when they ticked "I agree to the Privacy Policy" at signup — proof of consent for DPA purposes
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_account_type ON users(account_type);

-- ============================================================
-- SESSIONS — server-side session registry so logout truly kills
-- access (public-computer safety requirement). Every login issues
-- a session row; the JWT embeds session_id; auth middleware checks
-- the row is still marked active on every request. Logout (or
-- "log out everywhere") flips is_active to false immediately.
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    ip_address      VARCHAR(64),
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);

-- ============================================================
-- SEARCHES — every verification lookup a user pays for/performs.
-- Results are cached here so the same query (e.g. same paybill or
-- phone number) is served instantly next time without re-querying
-- external sources or charging a duplicate fee for the SAME
-- unlocked result within its freshness window.
-- ============================================================
CREATE TABLE IF NOT EXISTS searches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    query_type          VARCHAR(20) NOT NULL CHECK (query_type IN ('paybill', 'phone', 'job_offer')),
    query_value         VARCHAR(150) NOT NULL,
    query_value_hash    VARCHAR(64) NOT NULL,       -- sha256 of normalized query_value, for fast unique lookups
    verdict             VARCHAR(20) CHECK (verdict IN ('legit', 'suspicious', 'scam', 'unverified')),
    confidence_score     SMALLINT,                   -- 0-100
    summary             TEXT,
    sources_json        JSONB,                       -- structured evidence: db matches + external source snippets/links
    tier_paid           SMALLINT NOT NULL,            -- 50 / 100 / 150 KES tier that unlocked this result
    amount_paid          NUMERIC(10,2) NOT NULL,
    mpesa_receipt        VARCHAR(40),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_searches_dedup ON searches(query_type, query_value_hash);
CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id);

-- ============================================================
-- SUBSCRIPTIONS — job owner monthly access (KES 459 / 30 days)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
    amount           NUMERIC(10,2) NOT NULL DEFAULT 459.00,
    mpesa_receipt     VARCHAR(40),
    started_at        TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ,
    -- Renewal reminder tracking (see jobs/subscriptionReminders.js) — each
    -- column is stamped once that specific reminder has been sent, so the
    -- daily reminder job never sends the same one twice.
    reminder_5_sent_at TIMESTAMPTZ,
    reminder_3_sent_at TIMESTAMPTZ,
    reminder_1_sent_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ============================================================
-- PAYMENTS — every STK push attempt (search unlock or subscription)
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
    purpose                 VARCHAR(20) NOT NULL CHECK (purpose IN ('search', 'subscription')),
    reference_id             UUID,                    -- links to searches.id or subscriptions.id once resolved
    amount                   NUMERIC(10,2) NOT NULL,
    phone                    VARCHAR(15) NOT NULL,
    status                   VARCHAR(20) NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'pending', 'success', 'failed', 'cancelled')),
    tuma_checkout_request_id  VARCHAR(60),                       -- Tuma's checkout_request_id (their proxy for the underlying M-Pesa CheckoutRequestID)
    tuma_merchant_request_id  VARCHAR(60),
    mpesa_receipt             VARCHAR(40),                       -- still an M-Pesa receipt number even though Tuma is the gateway
    raw_callback_json         JSONB,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(tuma_checkout_request_id);
-- A single M-Pesa code can only ever confirm ONE successful payment —
-- whether that confirmation came from Tuma's real callback or a user's
-- manual code entry (see routes/payments.js /confirm-manual). This is
-- what makes a manually-entered code a true one-time-use voucher: once
-- it has unlocked one result, pasting the same code into a different
-- payment is rejected at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt_unique
    ON payments(mpesa_receipt) WHERE status = 'success' AND mpesa_receipt IS NOT NULL;

-- ============================================================
-- JOBS — job owner postings, held for admin approval before they
-- can appear anywhere searchable/public
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(200) NOT NULL,
    company_name     VARCHAR(200) NOT NULL,
    description       TEXT NOT NULL,
    contact_phone     VARCHAR(15),
    location          VARCHAR(120),
    status            VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by        UUID,                          -- admins.id
    reviewed_at         TIMESTAMPTZ,
    rejection_reason     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ============================================================
-- ADMINS — separate credential table, never exposed via public API
-- ============================================================
CREATE TABLE IF NOT EXISTS admins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name        VARCHAR(150) NOT NULL,
    email            VARCHAR(150) UNIQUE NOT NULL,
    password_hash     TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CONTACT MESSAGES — the single support channel: a message box
-- that emails the management directly (see services/emailService.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(150) NOT NULL,
    message           TEXT NOT NULL,
    emailed_ok         BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
