// In-process self-check: pings this API over HTTP and touches the database on a
// fixed cadence, and prunes probes past the retention window once a day.
//
// This is deliberately NOT the uptime series shown on the status page. A probe
// that runs inside this process cannot see this process being down, so treating
// its results as uptime would be a flattering lie. It is recorded as
// source='internal' and reported separately — it catches "the API is up but the
// database is refusing queries", which the external prober cannot see.
require('dotenv').config();
const http = require('http');
const pool = require('../db/pool');
const statusHistory = require('../services/statusHistory');

const PING_TIMEOUT_MS = parseInt(process.env.STATUS_SELF_CHECK_TIMEOUT_MS || '10000', 10);

function pingSelf(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: PING_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const ok = res.statusCode === 200 && body.includes('"pong":true');
        resolve({
          ok,
          latencyMs: Date.now() - started,
          statusCode: res.statusCode,
          error: ok ? null : `HTTP ${res.statusCode}: ${body.slice(0, 120)}`,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('self-check timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, latencyMs: Date.now() - started, statusCode: 0, error: err.message });
    });
  });
}

async function run({ port = process.env.PORT || 4800 } = {}) {
  const ping = await pingSelf(port);

  let dbOk = true;
  let dbError = null;
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    dbOk = false;
    dbError = `database: ${err.message}`;
  }

  const ok = ping.ok && dbOk;
  const error = ping.error || dbError;
  const row = await statusHistory.recordProbe({
    ok,
    latencyMs: ping.latencyMs,
    statusCode: ping.statusCode,
    error,
    source: 'internal',
    component: 'api',
  });

  if (!ok) console.error('Self-check probe failed:', error);
  return { ok, latencyMs: ping.latencyMs, statusCode: ping.statusCode, error, id: row && row.id };
}

async function prune() {
  const deleted = await statusHistory.pruneOldProbes();
  if (deleted) console.log(`Pruned ${deleted} status probes older than ${statusHistory.PROBE_RETENTION_DAYS} days.`);
  return deleted;
}

if (require.main === module) {
  run()
    .then(() => prune())
    .then(() => pool.end())
    .catch((err) => {
      console.error('Status probe job failed:', err.message);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { run, prune, pingSelf };
