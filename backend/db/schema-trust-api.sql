-- ============================================================
-- SemaCheck Trust API — new tables + schema patches
--
-- Idempotent, migrate.js-safe. Every statement is a top-level
-- semicolon-terminated statement. No DO $$ blocks, no semicolons
-- inside string literals or comments.
-- ============================================================

-- ---------------------------------------------------------------------------
-- 5.1 New tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_plans (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(30) UNIQUE NOT NULL,
    name            VARCHAR(60) NOT NULL,
    monthly_price_kes INTEGER NOT NULL DEFAULT 0,
    monthly_quota     INTEGER NOT NULL,
    rate_limit_per_min INTEGER NOT NULL,
    webhooks_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    batch_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO api_plans (code, name, monthly_price_kes, monthly_quota, rate_limit_per_min, webhooks_enabled, batch_enabled)
VALUES ('free', 'Free', 0, 100, 10, FALSE, FALSE),
       ('starter', 'Starter', 5000, 2000, 60, FALSE, FALSE),
       ('growth', 'Growth', 20000, 10000, 180, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_accounts (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_name    VARCHAR(160) NOT NULL,
    website         VARCHAR(255),
    use_case        TEXT,
    plan_id         INTEGER NOT NULL REFERENCES api_plans(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'past_due', 'suspended', 'closed')),
    webhook_url     VARCHAR(500),
    webhook_secret_enc TEXT,
    plan_renews_on  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_accounts_user ON api_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_api_accounts_plan ON api_accounts(plan_id);
CREATE INDEX IF NOT EXISTS idx_api_accounts_status ON api_accounts(status);

CREATE TABLE IF NOT EXISTS api_keys (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    label           VARCHAR(80) NOT NULL,
    key_type        VARCHAR(12) NOT NULL CHECK (key_type IN ('secret', 'publishable')),
    key_prefix      VARCHAR(16) NOT NULL,
    key_hash        CHAR(64) UNIQUE NOT NULL,
    allowed_domains TEXT[],
    status          VARCHAR(12) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);

CREATE TABLE IF NOT EXISTS api_usage_log (
    id              BIGSERIAL PRIMARY KEY,
    request_id      VARCHAR(40) NOT NULL,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    key_id          INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
    endpoint        VARCHAR(40) NOT NULL,
    check_type      VARCHAR(20),
    subject_hash    CHAR(64),
    verdict         VARCHAR(20),
    cache_hit       BOOLEAN,
    status_code     INTEGER NOT NULL,
    latency_ms      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_account_time ON api_usage_log(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON api_usage_log(created_at);

CREATE TABLE IF NOT EXISTS api_usage_monthly (
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    period          CHAR(7) NOT NULL,
    checks_used     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, period)
);

CREATE TABLE IF NOT EXISTS api_invoices (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    plan_id         INTEGER NOT NULL REFERENCES api_plans(id),
    period          CHAR(7) NOT NULL,
    amount_kes      INTEGER NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'unpaid'
        CHECK (status IN ('unpaid', 'paid', 'void')),
    due_on          DATE NOT NULL,
    payment_id      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ,
    UNIQUE (account_id, period)
);

CREATE TABLE IF NOT EXISTS scam_reports (
    id              SERIAL PRIMARY KEY,
    report_type     VARCHAR(20) NOT NULL CHECK (report_type IN ('phone', 'paybill', 'business', 'website', 'job', 'other')),
    subject_value   VARCHAR(255) NOT NULL,
    subject_hash    CHAR(64) NOT NULL,
    subject_name    VARCHAR(160),
    description     TEXT NOT NULL,
    amount_lost_kes INTEGER,
    evidence_path   VARCHAR(255),
    reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reporter_email  VARCHAR(255),
    reporter_fingerprint CHAR(64) NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
    rejection_reason VARCHAR(255),
    reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_subject ON scam_reports(report_type, subject_hash, status);
CREATE INDEX IF NOT EXISTS idx_reports_status_time ON scam_reports(status, created_at);

CREATE TABLE IF NOT EXISTS report_disputes (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL REFERENCES scam_reports(id) ON DELETE CASCADE,
    submitter_name  VARCHAR(160) NOT NULL,
    submitter_email VARCHAR(255) NOT NULL,
    submitter_phone VARCHAR(20),
    relationship    VARCHAR(20) NOT NULL CHECK (relationship IN ('owner', 'authorised_rep')),
    message         TEXT NOT NULL,
    evidence_path   VARCHAR(255),
    status          VARCHAR(12) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'upheld', 'dismissed')),
    resolution_note VARCHAR(500),
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watch_subjects (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    check_type      VARCHAR(20) NOT NULL,
    subject_hash    CHAR(64) NOT NULL,
    reference       VARCHAR(120),
    last_verdict    VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, check_type, subject_hash)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    event           VARCHAR(40) NOT NULL,
    payload_json    JSONB NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_response_code INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhooks_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhooks_account_time ON webhook_deliveries(account_id, created_at);

-- delivery worker needs the HMAC signature and the target URL persisted
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS webhook_url VARCHAR(500);

-- ---------------------------------------------------------------------------
-- 5.2 Migration safety patches (existing tables)
-- ---------------------------------------------------------------------------

-- payments: link an invoice
ALTER TABLE payments ADD COLUMN IF NOT EXISTS api_invoice_id INTEGER;

-- payments.purpose CHECK: keep existing values + add api_invoice and alert_view
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check
    CHECK (purpose IN ('search', 'subscription', 'forensics_case', 'api_invoice', 'alert_view'));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference_int INTEGER;

-- payments: drop legacy status that no longer exists
UPDATE payments SET status = 'failed' WHERE status = 'manual_review';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
    CHECK (status IN ('initiated', 'pending', 'success', 'failed', 'cancelled'));

-- remove any legacy column
ALTER TABLE payments DROP COLUMN IF EXISTS manual_code_submitted;

-- users: keep the same audit columns already added by earlier patches
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_reverification BOOLEAN NOT NULL DEFAULT FALSE;

-- api_accounts: new signups wait for admin approval before their keys go live
ALTER TABLE api_accounts DROP CONSTRAINT IF EXISTS api_accounts_status_check;
ALTER TABLE api_accounts ADD CONSTRAINT api_accounts_status_check
    CHECK (status IN ('pending', 'active', 'past_due', 'suspended', 'closed'));

-- ---------------------------------------------------------------------------
-- Sect 9.1: keyed-hash utilities for API keys
-- (documented as a helper for apiKeyAuth - keys are stored keyed-hashed)
-- ---------------------------------------------------------------------------

-- users: admin deactivation keeps every record, payment and report for audit
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- users: two-factor authentication with an authenticator app (TOTP)
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  CHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- ---------------------------------------------------------------------------
-- 5.3 Trust API follow-up (October 2026 review)
-- ---------------------------------------------------------------------------

-- Organisation verification for API accounts (business registration number
-- plus a business document reviewed by the admin team, instead of a personal
-- national ID).
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS org_registration_no VARCHAR(80);
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS business_doc_path VARCHAR(255);
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS verification_note VARCHAR(255);
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- API plan renewal reminders (dedupe column)
ALTER TABLE api_accounts ADD COLUMN IF NOT EXISTS last_plan_reminder_at TIMESTAMPTZ;

-- Live vs test (sandbox) API keys
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mode VARCHAR(12) NOT NULL DEFAULT 'live';

-- Volume tier for high-throughput customers
INSERT INTO api_plans (code, name, monthly_price_kes, monthly_quota, rate_limit_per_min, webhooks_enabled, batch_enabled)
VALUES ('scale', 'Scale', 75000, 100000, 600, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- Free plan is sandbox-only from now on: no live checks are included.
UPDATE api_plans SET monthly_quota = 0 WHERE code = 'free';

-- Pay-gated checks: POST /v1/gate issues a check_token, the end user pays
-- by M-Pesa STK push, POST /v1/token/verify returns the verdict once paid.
CREATE TABLE IF NOT EXISTS paygate_checks (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
    token_hash      CHAR(64) UNIQUE NOT NULL,
    check_type      VARCHAR(20) NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    price_kes       INTEGER NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'awaiting_payment'
        CHECK (status IN ('awaiting_payment', 'paid', 'consumed', 'expired', 'failed')),
    payment_id      INTEGER,
    verdict         VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ,
    consumed_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
);
CREATE INDEX IF NOT EXISTS idx_paygate_account ON paygate_checks(account_id, created_at);
ALTER TABLE paygate_checks ADD COLUMN IF NOT EXISTS payment_id INTEGER;

-- payments.purpose gains api_paygate (pay-gated API checks)
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check
    CHECK (purpose IN ('search', 'subscription', 'forensics_case', 'api_invoice', 'alert_view', 'api_paygate'));

-- "Wrong verdict" feedback from result pages
CREATE TABLE IF NOT EXISTS verdict_feedback (
    id               SERIAL PRIMARY KEY,
    check_type       VARCHAR(20),
    subject_hash     CHAR(64),
    previous_verdict VARCHAR(20),
    message          TEXT NOT NULL,
    contact_email    VARCHAR(255),
    status           VARCHAR(12) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'reviewed')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verdict_feedback_status ON verdict_feedback(status, created_at);
