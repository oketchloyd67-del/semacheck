// Uptime history for the public status page.
//
// The honesty rules here matter more than the maths:
//   * Uptime is computed only from probes that were actually received. A window
//     with few probes is reported as low *coverage*, never as 100% uptime.
//   * Incidents are derived from consecutive failed probes, so they cannot be
//     quietly edited away — the underlying probe rows stay.
//   * A gap in monitoring is not silently counted as downtime; it is counted as
//     "no data", because we genuinely cannot tell.

const pool = require('../db/pool');

const CADENCE_MINUTES = Math.max(1, parseInt(process.env.STATUS_PROBE_CADENCE_MINUTES || '5', 10));
// Probes are kept well past the 90-day bar chart so a day's evidence still
// exists if a rollup is questioned. The nightly job prunes beyond this.
const PROBE_RETENTION_DAYS = Math.max(90, parseInt(process.env.STATUS_PROBE_RETENTION_DAYS || '120', 10));
// Consecutive failures closer together than this belong to the same incident.
const INCIDENT_GAP_MINUTES = Math.max(CADENCE_MINUTES, parseInt(process.env.STATUS_INCIDENT_GAP_MINUTES || '20', 10));
const MAX_WINDOW_DAYS = 90;

async function recordProbe({ ok, latencyMs, statusCode, error, source, component }) {
  const { rows } = await pool.query(
    `INSERT INTO status_probes (ok, latency_ms, status_code, error, source, component)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, checked_at, ok`,
    [
      Boolean(ok),
      Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
      Number.isFinite(statusCode) ? Math.round(statusCode) : null,
      error ? String(error).slice(0, 300) : null,
      String(source || 'external').slice(0, 40),
      String(component || 'api').slice(0, 20),
    ]
  );
  return rows[0];
}

async function recentProbes(limit = 20) {
  const { rows } = await pool.query(
    `SELECT checked_at, ok, latency_ms, status_code, source, error
     FROM status_probes ORDER BY checked_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 500)]
  );
  return rows;
}

// Uptime math runs on the EXTERNAL prober's rows only: a probe inside this
// process cannot observe this process being down, so mixing the two series in
// one uptime figure would inflate it. Internal rows are reported separately.
async function fetchProbesSince(days, { includeInternal = false } = {}) {
  const { rows } = await pool.query(
    `SELECT checked_at, ok, latency_ms
     FROM status_probes
     WHERE checked_at > now() - ($1 || ' days')::interval
       ${includeInternal ? '' : "AND source <> 'internal'"}
     ORDER BY checked_at ASC`,
    [String(days)]
  );
  return rows;
}

async function internalProbeStatus() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS probes, count(*) filter (where NOT ok)::int AS failed,
            max(checked_at) AS last_checked_at
     FROM status_probes WHERE source = 'internal'`
  );
  return rows[0] || { probes: 0, failed: 0, last_checked_at: null };
}

async function listNotices(days) {
  const { rows } = await pool.query(
    `SELECT id, component, severity, title, body, started_at, resolved_at
     FROM status_notices
     WHERE started_at > now() - ($1 || ' days')::interval
        OR resolved_at IS NULL
     ORDER BY started_at DESC LIMIT 50`,
    [String(days)]
  );
  return rows;
}

async function createNotice({ component, severity, title, body, startedAt, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO status_notices (component, severity, title, body, started_at, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6)
     RETURNING id, component, severity, title, body, started_at, resolved_at`,
    [
      String(component || 'api').slice(0, 20),
      String(severity || 'incident').slice(0, 16),
      String(title || '').slice(0, 140),
      body ? String(body).slice(0, 4000) : null,
      startedAt || null,
      createdBy ? String(createdBy).slice(0, 120) : null,
    ]
  );
  return rows[0];
}

async function resolveNotice(id, { resolvedAt } = {}) {
  const { rows } = await pool.query(
    `UPDATE status_notices SET resolved_at = COALESCE($2::timestamptz, now())
     WHERE id = $1 AND resolved_at IS NULL
     RETURNING id, component, severity, title, started_at, resolved_at`,
    [Number(id), resolvedAt || null]
  );
  return rows[0] || null;
}

async function pruneOldProbes() {
  const { rowCount } = await pool.query(
    `DELETE FROM status_probes WHERE checked_at < now() - ($1 || ' days')::interval`,
    [String(PROBE_RETENTION_DAYS)]
  );
  return rowCount;
}

// ---- pure helpers (unit-tested, no database) ----

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function latencyStats(probes) {
  const values = probes.map((p) => Number(p.latency_ms)).filter((v) => Number.isFinite(v));
  if (!values.length) return { avg: null, p50: null, p95: null, samples: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / values.length),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    samples: values.length,
  };
}

function windowStats(probes, hours, now) {
  const from = now - hours * 3600 * 1000;
  const inWindow = probes.filter((p) => {
    const t = toTime(p.checked_at);
    return t !== null && t >= from && t <= now;
  });
  const ok = inWindow.filter((p) => p.ok).length;
  const expected = Math.round((hours * 60) / CADENCE_MINUTES);
  const coveragePct = expected > 0 ? Math.round((inWindow.length / expected) * 1000) / 10 : null;
  return {
    windowHours: hours,
    probes: inWindow.length,
    ok,
    failed: inWindow.length - ok,
    // null, not 100: with no probes we know nothing about this window.
    uptimePct: inWindow.length ? Math.round((ok / inWindow.length) * 1000) / 10 : null,
    coveragePct: coveragePct === null ? null : Math.min(coveragePct, 100),
    latency: latencyStats(inWindow),
  };
}

// Daily buckets, oldest first, so the page can draw one bar per day.
function buildDailyBuckets(probes, days, now) {
  const todayStart = startOfUtcDay(now);
  const expectedPerDay = Math.round((24 * 60) / CADENCE_MINUTES);
  const buckets = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = todayStart - i * 86400000;
    buckets.push({
      date: dayKey(new Date(dayStart)),
      startMs: dayStart,
      probes: 0,
      ok: 0,
      partial: i === 0, // today is still in progress
      uptimePct: null,
      coveragePct: null,
      avgLatencyMs: null,
    });
  }

  const byDate = new Map(buckets.map((b) => [b.date, b]));
  for (const probe of probes) {
    const t = toTime(probe.checked_at);
    if (t === null || t < buckets[0].startMs || t > now) continue;
    const bucket = byDate.get(dayKey(new Date(t)));
    if (!bucket) continue;
    bucket.probes += 1;
    if (probe.ok) bucket.ok += 1;
  }

  for (const bucket of buckets) {
    if (bucket.probes > 0) {
      bucket.uptimePct = Math.round((bucket.ok / bucket.probes) * 1000) / 10;
    }
    const expected = bucket.partial
      ? Math.max(1, Math.round(((now - bucket.startMs) / 60000) / CADENCE_MINUTES))
      : expectedPerDay;
    bucket.coveragePct = Math.min(100, Math.round((bucket.probes / expected) * 1000) / 10);
  }
  return buckets;
}

// Group consecutive failed probes into incidents. `noDataGap: true` flags an
// incident whose end we cannot see because monitoring stopped answering, so the
// end time is a lower bound rather than a measurement.
function deriveIncidents(probes, { now = Date.now(), gapMinutes = INCIDENT_GAP_MINUTES } = {}) {
  const gapMs = gapMinutes * 60000;
  const incidents = [];
  let current = null;
  let lastFailureMs = null;

  for (const probe of probes) {
    const t = toTime(probe.checked_at);
    if (t === null || t > now) continue;

    if (!probe.ok) {
      if (current && lastFailureMs !== null && t - lastFailureMs <= gapMs) {
        current.failedProbes += 1;
        current.lastFailureMs = t;
      } else {
        if (current) incidents.push(current);
        current = { startedMs: t, lastFailureMs: t, failedProbes: 1, resolvedMs: null, noDataGap: false };
      }
      lastFailureMs = t;
      continue;
    }

    if (current) {
      current.resolvedMs = t;
      current.noDataGap = t - current.lastFailureMs > gapMs;
      incidents.push(current);
      current = null;
      lastFailureMs = null;
    }
  }

  if (current) {
    current.ongoing = true;
    incidents.push(current);
  }

  return incidents
    .map((incident) => ({
      startedAt: new Date(incident.startedMs).toISOString(),
      resolvedAt: incident.resolvedMs === null ? null : new Date(incident.resolvedMs).toISOString(),
      ongoing: Boolean(incident.ongoing),
      noDataGap: Boolean(incident.noDataGap),
      failedProbes: incident.failedProbes,
      durationMinutes: Math.max(
        1,
        Math.round(((incident.resolvedMs === null ? now : incident.resolvedMs) - incident.startedMs) / 60000)
      ),
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 30);
}

async function summary({ days = MAX_WINDOW_DAYS, now = Date.now() } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || MAX_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
  const probes = await fetchProbesSince(windowDays);
  const notices = await listNotices(windowDays);
  let internal = { probes: 0, failed: 0, last_checked_at: null };
  try {
    internal = await internalProbeStatus();
  } catch (err) {
    console.error('Internal probe status failed:', err.message);
  }

  const buckets = buildDailyBuckets(probes, windowDays, now);
  const incidents = deriveIncidents(probes, { now });
  const daysWithProbes = buckets.filter((b) => b.probes > 0).length;
  const firstProbeMs = probes.length ? toTime(probes[0].checked_at) : null;

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    cadenceMinutes: CADENCE_MINUTES,
    windows: {
      '24h': windowStats(probes, 24, now),
      '7d': windowStats(probes, 24 * 7, now),
      '30d': windowStats(probes, 24 * 30, now),
    },
    days: buckets,
    incidents,
    notices: notices.map((n) => ({
      id: n.id,
      component: n.component,
      severity: n.severity,
      title: n.title,
      body: n.body,
      startedAt: n.started_at,
      resolvedAt: n.resolved_at,
    })),
    monitoring: {
      prober: 'github-actions',
      // Uptime above is external probing only; this is the API's own self-check.
      selfCheck: {
        probes: internal.probes || 0,
        failed: internal.failed || 0,
        lastCheckedAt: internal.last_checked_at || null,
      },
      daysWithProbes,
      // Everything the page shows starts here, so a visitor can tell the
      // difference between "up for 30 days" and "we only started measuring".
      historyStartsAt: firstProbeMs === null ? null : new Date(firstProbeMs).toISOString(),
      probesInWindow: probes.length,
      externalProbingConfigured: probes.length > 0,
    },
  };
}

module.exports = {
  CADENCE_MINUTES,
  PROBE_RETENTION_DAYS,
  INCIDENT_GAP_MINUTES,
  MAX_WINDOW_DAYS,
  recordProbe,
  recentProbes,
  fetchProbesSince,
  internalProbeStatus,
  listNotices,
  createNotice,
  resolveNotice,
  pruneOldProbes,
  buildDailyBuckets,
  deriveIncidents,
  windowStats,
  latencyStats,
  summary,
};
