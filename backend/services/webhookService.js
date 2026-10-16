const crypto = require('crypto');
const pool = globalThis.__pool || require('../db/pool');
const axios = require('axios');

async function postWebhook(url, body, headers) {
  if (typeof globalThis.__webhookPost === 'function') {
    return globalThis.__webhookPost(url, body, headers);
  }
  const { status } = await axios({ method: 'POST', url, data: body, headers, timeout: 5000 });
  return { status };
}

const MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10);

function sign(secret, timestamp, body) {
  const data = `${timestamp}.${body}`;
  // base64url (URL-safe, no + / characters) to be embeddable in headers.
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function verifySignature(body, timestamp, expected, header) {
  if (!body || timestamp === undefined || expected === undefined || !header) return false;
  const parts = {};
  try {
    for (const segment of header.split(',')) {
      const eq = segment.indexOf('=');
      if (eq === -1) continue;
      parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
    }
  } catch {
    return false;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  if (Number.isFinite(Number(timestamp)) && Number(timestamp) !== t) return false;
  // expected is the HMAC secret; recompute the signature and compare to the
  // transmitted v1 signature (base64url, padding tolerated).
  const digest = crypto.createHmac('sha256', expected).update(`${t}.${body}`).digest('base64url');
  const expectedSig = parts.v1 || '';
  const a = Buffer.from(digest);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) {
    // tolerate base64url padding differences
    if (a.length - b.length !== 2 && a.length - b.length !== -2) return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// Notify a watched subject when its verdict changes (from a report approval,
// removal, or dispute). Enqueues a webhook_deliveries row if webhooks are
// enabled on the account's plan and the verdict actually differs.
async function notifySubjectChange(type, hash) {
  const { rows: watches } = await pool.query(
    `SELECT w.account_id, w.check_type, w.subject_hash, w.last_verdict, w.reference, a.webhook_url, a.webhook_secret_enc, p.webhooks_enabled
     FROM watch_subjects w
     JOIN api_accounts a ON a.id = w.account_id
     JOIN api_plans p ON p.id = a.plan_id
     WHERE w.check_type = $1 AND w.subject_hash = $2 AND p.webhooks_enabled = TRUE`,
    [type, hash]
  );

  let enqueued = 0;
  for (const w of watches) {
    const current = await recomputeVerdict(type, hash);
    if (!current) continue;
    const changed = (w.last_verdict || 'unverified') !== current.verdict;
    if (!changed) continue;

    const payload = {
      event: 'subject.verdict_changed',
      created_at: new Date().toISOString(),
      data: {
        type: w.check_type,
        value: null,
        reference: w.reference,
        previousVerdict: w.last_verdict || 'unverified',
        verdict: current.verdict,
        confidence: current.confidence_score,
      },
    };

    const secret = await decryptSecret(w.webhook_secret_enc);
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret, String(timestamp), raw);

    await pool.query(
      `INSERT INTO webhook_deliveries (account_id, event, payload_json, status, next_attempt_at, signature, webhook_url)
       VALUES ($1,$2,$3,'pending',now() + '60 seconds'::interval,$4,$5)`,
      [w.account_id, payload.event, raw, signature, w.webhook_url]
    );
    enqueued += 1;
  }
  return { enqueued };
}

async function decryptSecret(encrypted) {
  if (!encrypted) return null;
  try {
    return require('./cryptoService').decrypt(encrypted);
  } catch {
    return null;
  }
}

async function recomputeVerdict(type, hash) {
  const { rows } = await pool.query(
    `SELECT verdict, confidence_score FROM searches WHERE query_type=$1 AND query_value_hash=$2 ORDER BY last_verified_at DESC LIMIT 1`,
    [type, hash]
  );
  return rows[0] || null;
}

// Delivery worker: POST a webhook delivery row with the correct signature.
async function deliver(row) {
  const url = row.webhook_url;
  if (!url) return;

  // Re-check the URL right before sending (DNS can change after it was saved).
  try {
    const { checkWebhookUrl } = require('./ssrfGuard');
    const urlCheck = await checkWebhookUrl(url);
    if (!urlCheck.ok) {
      console.warn(`[webhook] blocked delivery ${row.id}: ${urlCheck.reason}`);
      await pool.query(
        `UPDATE webhook_deliveries SET status='failed', last_response_code=0, attempts=$1 WHERE id=$2`,
        [parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10), row.id]
      );
      return;
    }
  } catch (e) {
    console.warn('[webhook] URL check failed:', e.message);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = row.payload_json;
  const secret = (row.accountSecret && typeof row.accountSecret === 'function')
    ? await row.accountSecret()
    : (row.secret || '');
  const signature = `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'SemaCheck-Webhooks/1.0',
    'X-SemaCheck-Event': row.event,
    'X-SemaCheck-Delivery': String(row.id),
    'X-SemaCheck-Signature': signature,
  };
  row.headers = row.headers || {};
  row.headers['X-SemaCheck-Signature'] = signature;

  const result = { id: row.id, status: 500 };

  try {
    const { status } = await postWebhook(url, body, headers);
    result.status = status;
    if (status >= 200 && status < 300) {
      await pool.query(
        `UPDATE webhook_deliveries SET status='delivered', delivered_at=now(), last_response_code=$1, attempts=$2 WHERE id=$3`,
        [status, row.attempts || 0, row.id]
      );
    } else {
      await scheduleRetry(row.id);
    }
  } catch (err) {
    await scheduleRetry(row.id);
  }

  return result;
}

async function scheduleRetry(id) {
  const { rows: d } = await pool.query(
    `SELECT id, attempts, next_attempt_at FROM webhook_deliveries WHERE id=$1`,
    [id]
  );
  const delivery = d[0];
  if (!delivery) return;
  const attempts = (delivery.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE webhook_deliveries SET status='failed', last_response_code=NULL WHERE id=$1`,
      [id]
    );
    return;
  }
  const delay = Math.min(60 * Math.pow(2, attempts - 1), 3600);
  const next = new Date(Date.now() + delay * 1000);
  await pool.query(
    `UPDATE webhook_deliveries SET attempts=$1, next_attempt_at=$2 WHERE id=$3`,
    [attempts, next, id]
  );
}

module.exports = { sign, verifySignature, notifySubjectChange, deliver, scheduleRetry, MAX_ATTEMPTS };
