-- Admin security additions.
-- Run through migrate.js, which splits on every semicolon, so keep statements
-- plain and avoid semicolons inside comments.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'super_admin';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Every privileged action (and every ID/business document opened) is recorded
-- here. Rows are append-only: the admin UI exposes no delete endpoint.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        UUID REFERENCES admins(id) ON DELETE SET NULL,
    admin_email     VARCHAR(150),
    action          VARCHAR(60) NOT NULL,
    target_type     VARCHAR(40),
    target_id       VARCHAR(80),
    detail          JSONB,
    ip              VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_time
    ON admin_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin
    ON admin_audit_log (admin_id, created_at DESC);

-- Successful and failed admin sign-ins, including the reason a sign-in failed.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(150),
    ok              BOOLEAN NOT NULL,
    reason          VARCHAR(40),
    ip              VARCHAR(64),
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_time
    ON admin_login_attempts (created_at DESC);
