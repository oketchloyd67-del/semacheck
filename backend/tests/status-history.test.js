// The status page used to say "historical uptime and incident history are
// coming". These tests pin down the two rules that make the replacement honest:
// a window with no probes reports null (not 100%) uptime, and incidents come out
// of the recorded failures themselves.
const test = require('node:test');
const assert = require('node:assert/strict');

// Hermetic: the pure helpers must not need a database.
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};

const statusHistory = require('../services/statusHistory');
const statusRoutes = require('../routes/status');

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 18 Oct 2026 12:00 UTC
const MIN = 60 * 1000;

function probe(minutesAgo, ok, latencyMs = 100) {
  return { checked_at: new Date(NOW - minutesAgo * MIN), ok, latency_ms: latencyMs };
}

test('a window with no probes reports null uptime, not a perfect score', () => {
  const stats = statusHistory.windowStats([], 24, NOW);
  assert.equal(stats.probes, 0);
  assert.equal(stats.uptimePct, null);
  assert.equal(stats.coveragePct, 0);
  assert.equal(stats.latency.samples, 0);
});

test('window stats count probes received and cap coverage at 100%', () => {
  const probes = [];
  for (let i = 0; i < 6; i += 1) probes.push(probe(5 + i * 5, i !== 3, 120 + i));
  const stats = statusHistory.windowStats(probes, 1, NOW); // 1h at 5-min cadence => 12 expected
  assert.equal(stats.probes, 6);
  assert.equal(stats.ok, 5);
  assert.equal(stats.uptimePct, 83.3);
  assert.equal(stats.coveragePct, 50);
  assert.ok(stats.latency.samples === 6);
});

test('daily buckets carry a no-data day as no data', () => {
  const probes = [probe(10, true, 90), probe(20, false, 90), probe(30, true, 90), probe(60 * 30, true, 90)];
  const buckets = statusHistory.buildDailyBuckets(probes, 3, NOW);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[2].date, '2026-10-18');
  assert.equal(buckets[2].probes, 3);
  assert.equal(buckets[2].uptimePct, 66.7);
  assert.equal(buckets[2].partial, true);
  // The 30-hours-ago probe falls on yesterday, so the oldest day received
  // nothing — and a day with no probes must say so instead of showing 100%.
  assert.equal(buckets[1].probes, 1);
  assert.equal(buckets[0].probes, 0);
  assert.equal(buckets[0].uptimePct, null);
  assert.equal(buckets[0].coveragePct, 0);
});

test('consecutive failures become one incident with the failures counted', () => {
  const probes = [
    probe(60, true),
    probe(40, false),
    probe(35, false),
    probe(30, false),
    probe(25, true),
    probe(20, true),
  ];
  const incidents = statusHistory.deriveIncidents(probes, { now: NOW });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].failedProbes, 3);
  assert.equal(incidents[0].ongoing, false);
  assert.equal(incidents[0].durationMinutes, 15);
  assert.equal(incidents[0].startedAt, new Date(NOW - 40 * MIN).toISOString());
  assert.equal(incidents[0].resolvedAt, new Date(NOW - 25 * MIN).toISOString());
});

test('failures far apart are separate incidents, and an unresolved one stays open', () => {
  const probes = [
    probe(200, false),
    probe(195, true),
    probe(60, false),
    probe(55, false),
  ];
  const incidents = statusHistory.deriveIncidents(probes, { now: NOW });
  assert.equal(incidents.length, 2);
  const [newest, oldest] = incidents; // sorted newest first
  assert.equal(newest.ongoing, true);
  assert.equal(newest.resolvedAt, null);
  assert.equal(newest.durationMinutes, 60);
  assert.equal(oldest.failedProbes, 1);
  assert.equal(oldest.ongoing, false);
});

test('a monitoring gap after a failure is flagged rather than hidden', () => {
  const probes = [probe(120, false), probe(5, true)];
  const [incident] = statusHistory.deriveIncidents(probes, { now: NOW });
  assert.equal(incident.noDataGap, true, 'the gap must be visible: the end time is a lower bound');
});

test('probe ingest refuses an unset or wrong secret', () => {
  const original = process.env.STATUS_PROBE_SECRET;
  delete process.env.STATUS_PROBE_SECRET;
  assert.equal(statusRoutes.matchesSecret({ get: () => 'anything' }), false);
  process.env.STATUS_PROBE_SECRET = 'probe-secret-value';
  assert.equal(statusRoutes.matchesSecret({ get: () => 'probe-secret-value' }), true);
  assert.equal(statusRoutes.matchesSecret({ get: () => 'probe-secret-valuX' }), false);
  assert.equal(statusRoutes.matchesSecret({ get: () => '' }), false);
  if (original === undefined) delete process.env.STATUS_PROBE_SECRET;
  else process.env.STATUS_PROBE_SECRET = original;
});
