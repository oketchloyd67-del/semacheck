const pool = require('../db/pool');
const { deliver } = require('../services/webhookService');

const INTERVAL_MS = 60 * 1000;

async function run() {
  const { rows } = await pool.query(
    `SELECT id, account_id, event, payload_json, status, attempts, next_attempt_at, last_response_code, created_at, delivered_at, webhook_url, signature
     FROM webhook_deliveries
     WHERE status='pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 20`
  );

  for (const row of rows) {
    await deliver(row);
  }
  console.log(`[deliverWebhooks] checked ${rows.length} due deliveries.`);
}

if (require.main === module) {
  run().catch((err) => console.error('[deliverWebhooks] failed:', err));
  setInterval(() => run().catch((e) => console.error('[deliverWebhooks] failed:', e)), INTERVAL_MS);
}

module.exports = { run };
