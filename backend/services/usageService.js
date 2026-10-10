const pool = require('../db/pool');
const { registryStatus } = require('./cbkRegistryService');
const { internationalLookupStatus } = require('./internationalScamDatabases');

async function logUsage({ requestId, accountId, keyId, endpoint, checkType, subjectHash, verdict, cacheHit, statusCode, latencyMs }) {
  try {
    await pool.query(
      `INSERT INTO api_usage_log (request_id, account_id, key_id, endpoint, check_type, subject_hash, verdict, cache_hit, status_code, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [requestId, accountId, keyId, endpoint, checkType, subjectHash, verdict, cacheHit, statusCode, latencyMs]
    );
  } catch (err) {
    console.error('usageService.log failed:', err.message);
  }
}

async function getMonthUsage(accountId) {
  const { rows } = await pool.query(
    `SELECT period, checks_used FROM api_usage_monthly WHERE account_id=$1 ORDER BY period DESC LIMIT 12`,
    [accountId]
  );
  return rows;
}

async function getDailySeries(accountId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { rows } = await pool.query(
    `SELECT DATE(created_at)::text AS day, COUNT(*)::int AS n FROM api_usage_log
     WHERE account_id=$1 AND created_at >= $2
     GROUP BY day ORDER BY day ASC`,
    [accountId, since]
  );
  return rows;
}

async function getPlatformStats() {
  const [
    usageRows,
    reportsRows,
    verdictRows,
    accountRows,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM api_usage_log'),
    pool.query('SELECT COUNT(*)::int AS n FROM scam_reports WHERE status=\'approved\''),
    pool.query(`SELECT verdict, COUNT(*)::int AS n FROM searches GROUP BY verdict`),
    pool.query('SELECT COUNT(*)::int AS n FROM api_accounts WHERE status=\'active\''),
  ]);
  const daily = await pool.query(
    `SELECT DATE(created_at)::text AS day, COUNT(*)::int AS n FROM api_usage_log
     WHERE created_at >= now() - interval '7 days'
     GROUP BY day ORDER BY day ASC`
  );
  const latencyP50 = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50 FROM api_usage_log WHERE latency_ms IS NOT NULL`
  );
  const latencyP95 = await pool.query(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95 FROM api_usage_log WHERE latency_ms IS NOT NULL`
  );

  return {
    checksServed: usageRows.rows[0].n,
    approvedReports: reportsRows.rows[0].n,
    verdictMix: verdictRows.rows,
    activeAccounts: accountRows.rows[0].n,
    dailySeries: daily.rows,
    latencyP50: Number(latencyP50.rows[0].p50) || 0,
    latencyP95: Number(latencyP95.rows[0].p95) || 0,
  };
}

module.exports = { logUsage, getMonthUsage, getDailySeries, getPlatformStats };
