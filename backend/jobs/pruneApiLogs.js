const pool = require('../db/pool');

const RETENTION_DAYS = parseInt(process.env.API_LOG_RETENTION_DAYS || '90', 10);
const LOG_RETENTION_DAYS = RETENTION_DAYS;

async function run() {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000);
  await pool.query(
    `DELETE FROM api_usage_log WHERE created_at < $1`,
    [cutoff]
  );
  await pool.query(
    `DELETE FROM webhook_deliveries WHERE delivered_at < $1`,
    [cutoff]
  );
  await pool.query(
    `DELETE FROM scam_reports WHERE status='rejected' AND created_at < $1`,
    [cutoff]
  );
  console.log(`[pruneApiLogs] Removed usage logs older than ${LOG_RETENTION_DAYS} days.`);
}

if (require.main === module) {
  run().catch((err) => console.error('[pruneApiLogs] failed:', err));
  setInterval(() => run().catch((e) => console.error('[pruneApiLogs] failed:', e)), 24 * 60 * 60 * 1000);
}

module.exports = { run };
