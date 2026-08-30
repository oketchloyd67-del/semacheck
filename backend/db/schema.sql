

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type        VARCHAR(20) NOT NULL CHECK (account_type IN ('regular', 'job_owner')),
    full_name           VARCHAR(150) NOT NULL,
    email               VARCHAR(150) UNIQUE NOT NULL,
    phone               VARCHAR(15) UNIQUE NOT NULL,         
    national_id         VARCHAR(20) UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
   
    email_verified       BOOLEAN NOT NULL DEFAULT FALSE,
    otp_code_hash         TEXT,
    otp_expires_at         TIMESTAMPTZ,
    otp_attempts            SMALLINT NOT NULL DEFAULT 0,
   
    id_document_filename    TEXT,                              
    id_verification_status  VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (id_verification_status IN ('pending', 'approved', 'rejected')),
    id_verification_reviewed_by  UUID,                        
    id_verification_reviewed_at  TIMESTAMPTZ,
    id_verification_notes        TEXT,                         
   
    business_name        VARCHAR(200),
    business_reg_number   VARCHAR(60),
    kra_pin              VARCHAR(20),
    business_verified    BOOLEAN DEFAULT FALSE,                 
    privacy_consent_at    TIMESTAMPTZ,                          
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_account_type ON users(account_type);


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


CREATE TABLE IF NOT EXISTS searches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    query_type          VARCHAR(20) NOT NULL CHECK (query_type IN ('paybill', 'phone', 'job_offer')),
    query_value         VARCHAR(150) NOT NULL,
    query_value_hash    VARCHAR(64) NOT NULL,       
    verdict             VARCHAR(20) CHECK (verdict IN ('legit', 'suspicious', 'scam', 'unverified')),
    confidence_score     SMALLINT,                 
    summary             TEXT,
    sources_json        JSONB,                       
    tier_paid           SMALLINT NOT NULL,            
    amount_paid          NUMERIC(10,2) NOT NULL,
    mpesa_receipt        VARCHAR(40),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_searches_dedup ON searches(query_type, query_value_hash);
CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id);


CREATE TABLE IF NOT EXISTS subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
    amount           NUMERIC(10,2) NOT NULL DEFAULT 459.00,
    mpesa_receipt     VARCHAR(40),
    started_at        TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ,
   
    reminder_30_sent_at TIMESTAMPTZ,
    reminder_25_sent_at TIMESTAMPTZ,
    reminder_20_sent_at TIMESTAMPTZ,
    reminder_15_sent_at TIMESTAMPTZ,
    reminder_10_sent_at TIMESTAMPTZ,
    reminder_5_sent_at TIMESTAMPTZ,
    reminder_3_sent_at TIMESTAMPTZ,
    reminder_1_sent_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);


CREATE TABLE IF NOT EXISTS payments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
    purpose                 VARCHAR(20) NOT NULL CHECK (purpose IN ('search', 'subscription', 'forensics_case')),
    reference_id             UUID,                    
    amount                   NUMERIC(10,2) NOT NULL,
    phone                    VARCHAR(15) NOT NULL,
    -- 'success' is only ever set from Tuma's own STK-push callback (see
    -- routes/payments.js /tuma/callback) — there is no manual/self-reported
    -- path that can mark a payment successful. If Tuma's callback never
    -- arrives, the payment simply stays 'pending'/'failed'; the user's
    -- recourse is the contact form or the critical-only WhatsApp line,
    -- not a code they type in themselves.
    status                   VARCHAR(20) NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'pending', 'success', 'failed', 'cancelled')),
    tuma_checkout_request_id  VARCHAR(60),                      
    tuma_merchant_request_id  VARCHAR(60),
    mpesa_receipt             VARCHAR(40),                      
    raw_callback_json         JSONB,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(tuma_checkout_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt_unique
    ON payments(mpesa_receipt) WHERE status = 'success' AND mpesa_receipt IS NOT NULL;


CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(200) NOT NULL,
    company_name     VARCHAR(200) NOT NULL,
    description       TEXT NOT NULL,
    contact_phone     VARCHAR(15),
    location          VARCHAR(120),
    status            VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by        UUID,                         
    reviewed_at         TIMESTAMPTZ,
    rejection_reason     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);


CREATE TABLE IF NOT EXISTS admins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name        VARCHAR(150) NOT NULL,
    email            VARCHAR(150) UNIQUE NOT NULL,
    password_hash     TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS contact_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(150) NOT NULL,
    message           TEXT NOT NULL,
    emailed_ok         BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- FORENSICS CASES — "lost money to a scam, want help reclaiming it"
-- referral flow, reached from a search result's receipt. A flat
-- KES 849 case-opening fee is charged once the eligibility check
-- (amount_lost >= 1000) passes; the case then sits in an admin/
-- investigator queue. Exact investigator-assignment flow is still
-- being defined — this table intentionally stays a simple queue with
-- an editable status for now, so it doesn't need re-migrating once
-- that flow is decided.
-- ============================================================
CREATE TABLE IF NOT EXISTS forensics_cases (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_lost        NUMERIC(12,2) NOT NULL CHECK (amount_lost >= 1000),
    scam_description    TEXT NOT NULL,
    evidence_notes       TEXT,
    contact_phone         VARCHAR(15),
    status                 VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                            CHECK (status IN ('awaiting_payment', 'submitted', 'under_review', 'in_progress', 'resolved', 'closed')),
    fee_payment_id           UUID REFERENCES payments(id),
    admin_notes                TEXT,
    reviewed_by                  UUID,
    reviewed_at                   TIMESTAMPTZ,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forensics_cases_user ON forensics_cases(user_id);
CREATE INDEX IF NOT EXISTS idx_forensics_cases_status ON forensics_cases(status);


-- ============================================================
-- CBK LICENSED DIGITAL CREDIT PROVIDERS — a local, periodically
-- refreshed cache of the Central Bank of Kenya's official directory of
-- licensed digital lenders (a real, structured public PDF — no login,
-- no key, just a fetch — see services/cbkRegistryService.js). Used to
-- give a real positive/negative signal on loan-app scam checks: "is
-- this actually a CBK-licensed lender, or not on the list at all."
-- CBK republishes this PDF at a new URL each update rather than one
-- stable "latest" link, so CBK_DCP_DIRECTORY_URL in .env needs updating
-- by hand whenever a newer directory is published — see the README.
-- ============================================================
CREATE TABLE IF NOT EXISTS cbk_licensed_dcps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name          TEXT NOT NULL,
    phone_raw               TEXT,
    email_raw                 TEXT,
    physical_address            TEXT,
    date_licensed_raw             TEXT,
    source_pdf_url                  TEXT,
    fetched_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cbk_dcps_name ON cbk_licensed_dcps(company_name);


-- ============================================================
-- PATCH SECTION — safe to re-run against an already-existing database
-- ============================================================
-- CREATE TABLE IF NOT EXISTS only helps on a brand-new database — it's
-- a no-op against a table that already exists, so any column added to
-- a table's definition above AFTER that table was first created on a
-- given deployment never actually appears there just by re-running
-- this file. That's exactly what caused the "column reminder_5_sent_at
-- does not exist" error: the subscriptions table already existed from
-- an earlier deploy, so re-running migrate.js didn't add the columns
-- that were added to the CREATE TABLE text later.
--
-- ADD COLUMN IF NOT EXISTS does not have that problem — it actually
-- alters an existing table, and is a safe no-op if the column is
-- already there. Every column ever added to this schema after its
-- table's first release is repeated here so `npm run migrate` is
-- always enough on its own, on a fresh database or an old one.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document_filename TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_reviewed_by UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_notes TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_30_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_25_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_20_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_15_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_10_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_5_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_3_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_1_sent_at TIMESTAMPTZ;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS tuma_checkout_request_id VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tuma_merchant_request_id VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_callback_json JSONB;

-- CHECK constraints DO need dropping and recreating explicitly — unlike
-- a plain column, "just editing the CREATE TABLE text" never reaches an
-- existing table at all, silently or otherwise. DROP...IF EXISTS then
-- ADD as two separate statements (not a DO block — db/migrate.js splits
-- this file naively on every semicolon, which would break a $$-quoted
-- block into invalid fragments) is idempotent on its own: the DROP is a
-- no-op if there's nothing to drop, and by the time ADD runs the old
-- constraint is already gone, so it succeeds cleanly every run.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('search', 'subscription', 'forensics_case'));

-- Manual M-Pesa code verification has been removed entirely — there is
-- no longer any self-reported-code path, so 'manual_review' is no
-- longer a valid status and the column that held a submitted code is
-- gone too. Any payment a previous version of this app left sitting in
-- 'manual_review' is moved to 'failed' first, since it never actually
-- got confirmed — this has to run BEFORE tightening the CHECK
-- constraint below, or that ALTER would fail against that old data.
UPDATE payments SET status='failed', updated_at=now() WHERE status='manual_review';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('initiated', 'pending', 'success', 'failed', 'cancelled'));

ALTER TABLE payments DROP COLUMN IF EXISTS manual_code_submitted;
