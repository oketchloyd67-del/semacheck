const express = require('express');
const crypto = require('crypto');
const statusHistory = require('../services/statusHistory');

const router = express.Router();

// Public page cache: the underlying data only changes once per probe cycle.
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheExpiry = 0;
let cacheDays = null;

function secretMatches(provided) {
  const expected = process.env.STATUS_PROBE_SECRET;
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function matchesSecret(req) {
  return secretMatches(req.get('x-status-probe-secret') || req.get('X-Status-Probe-Secret'));
}

// POST /api/status/probe — called by the external prober (see
// .github/workflows/uptime-probe.yml). Recording is deliberately outside the
// API process: a process cannot report its own death.
router.post('/probe', async (req, res) => {
  if (!process.env.STATUS_PROBE_SECRET) {
    return res.status(503).json({ error: 'probe_endpoint_disabled', message: 'STATUS_PROBE_SECRET is not configured.' });
  }
  if (!matchesSecret(req)) {
    return res.status(401).json({ error: 'invalid_probe_secret' });
  }

  const { ok, latencyMs, statusCode, error, source, component } = req.body || {};
  if (typeof ok !== 'boolean') {
    return res.status(400).json({ error: 'ok (boolean) is required.' });
  }

  try {
    const row = await statusHistory.recordProbe({ ok, latencyMs, statusCode, error, source, component });
    // A new probe lands immediately, so drop the cached page data.
    cache = null;
    cacheExpiry = 0;
    res.json({ recorded: true, id: row.id, checkedAt: row.checked_at });
  } catch (err) {
    console.error('Recording status probe failed:', err.message);
    res.status(500).json({ error: 'probe_not_recorded' });
  }
});

// GET /api/status/history?days=90 — public uptime history for status.html.
router.get('/history', async (req, res) => {
  const requestedDays = Math.min(Math.max(parseInt(req.query.days, 10) || statusHistory.MAX_WINDOW_DAYS, 1), statusHistory.MAX_WINDOW_DAYS);
  try {
    if (cache && cacheExpiry > Date.now() && cacheDays === requestedDays) {
      res.json(cache);
      return;
    }
    const data = await statusHistory.summary({ days: requestedDays });
    const [lastProbe] = await statusHistory.recentProbes(1);
    const body = {
      ...data,
      lastProbe: lastProbe
        ? {
            checkedAt: lastProbe.checked_at,
            ok: lastProbe.ok,
            latencyMs: lastProbe.latency_ms,
            source: lastProbe.source,
            error: lastProbe.error,
          }
        : null,
      note:
        'Uptime is measured from probes actually received. Days with few probes are reported with low coverage rather than as full uptime, and a gap in monitoring is shown as no data, not as downtime.',
    };
    cache = body;
    cacheDays = requestedDays;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(body);
  } catch (err) {
    console.error('Status history failed:', err.message);
    res.status(503).json({ error: 'history_unavailable', message: 'Uptime history is temporarily unavailable.' });
  }
});

module.exports = router;
module.exports.matchesSecret = matchesSecret;
