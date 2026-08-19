

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
    purpose                 VARCHAR(20) NOT NULL CHECK (purpose IN ('search', 'subscription')),
    reference_id             UUID,                    
    amount                   NUMERIC(10,2) NOT NULL,
    phone                    VARCHAR(15) NOT NULL,
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
