-- Status page history: uptime probes and human-posted incident notices.
--
-- Before this, the status page checked each component live in the browser and
-- stopped there — "historical uptime and incident history are coming" was still
-- on the page. A live probe cannot tell a visitor whether the API was up last
-- Tuesday, which is exactly what someone about to integrate asks.

-- One row per probe. Written by the external prober
-- (POST /api/status/probe, source 'github-actions') and by the API's own
-- in-process probe (source 'internal'). An internal probe cannot detect the
-- process being down, so the external rows are the authoritative ones.
CREATE TABLE IF NOT EXISTS status_probes (
    id           BIGSERIAL PRIMARY KEY,
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    component    VARCHAR(20) NOT NULL DEFAULT 'api',
    ok           BOOLEAN NOT NULL,
    latency_ms   INTEGER,
    status_code  INTEGER,
    source       VARCHAR(40) NOT NULL DEFAULT 'external',
    error        VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_status_probes_checked_at ON status_probes (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_probes_failures ON status_probes (checked_at DESC) WHERE NOT ok;

-- Incidents we post ourselves (planned maintenance, a known upstream fault, a
-- post-mortem). Probe-derived outages are computed from status_probes so they
-- cannot be edited away.
CREATE TABLE IF NOT EXISTS status_notices (
    id           SERIAL PRIMARY KEY,
    component    VARCHAR(20) NOT NULL DEFAULT 'api',
    severity     VARCHAR(16) NOT NULL DEFAULT 'incident'
        CHECK (severity IN ('incident', 'maintenance', 'resolved')),
    title        VARCHAR(140) NOT NULL,
    body         TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ,
    created_by   VARCHAR(120),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_status_notices_started_at ON status_notices (started_at DESC);
