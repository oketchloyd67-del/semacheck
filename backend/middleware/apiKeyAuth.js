const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_SECRET = process.env.API_KEY_HASH_SECRET || '';
const HASH_ALGO = 'sha256';

let missingSecretWarned = false;

function keyedHash(raw) {
  // Fail closed: with no secret we cannot verify any key, so every key is
  // invalid. Never throw — an exception here surfaced to callers as a 500,
  // which both leaks that the server is misconfigured and breaks the
  // "all bad keys get the same 401" contract (test D1).
  if (!HASH_SECRET) {
    if (!missingSecretWarned) {
      missingSecretWarned = true;
      console.error('[auth] API_KEY_HASH_SECRET is not configured — all API keys will be rejected.');
    }
    return null;
  }
  return crypto.createHmac(HASH_ALGO, HASH_SECRET).update(raw).digest('hex');
}

function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  return raw.trim();
}

async function lookupKey(hash) {
  const { rows } = await pool.query(
    `SELECT k.*, a.id AS account_id, a.user_id, a.company_name, a.website, a.plan_id, p.monthly_price_kes,
            p.monthly_quota, p.rate_limit_per_min, p.webhooks_enabled, p.batch_enabled, p.is_active AS plan_active,
            p.code AS plan_code, p.name AS plan_name
     FROM api_keys k
     JOIN api_accounts a ON a.id = k.account_id
     JOIN api_plans p ON p.id = a.plan_id
     WHERE k.key_hash = $1 AND k.status = 'active' AND p.is_active = TRUE AND a.status = 'active' AND a.status IS NOT NULL`,
    [hash]
  );
  return rows[0] || null;
}

async function apiKeyAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(\S+)/i);
  if (!match) {
    return res.status(401).json({ error: 'invalid_api_key', hint: 'Send Authorization: Bearer sk_live_xxxx (or sk_test_xxxx on the Free sandbox plan)' });
  }

  const raw = normalizeKey(match[1]);
  if (!raw || !/^sk_(test|live)_[A-Za-z0-9_-]{20,64}$/.test(raw)) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  const hash = keyedHash(raw);
  if (!hash) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  let key;
  try {
    key = await lookupKey(hash);
  } catch (err) {
    console.error('apiKeyAuth lookup failed:', err.message);
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  if (!key) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  const keyMode = key.mode === 'test' || raw.startsWith('sk_test_') ? 'test' : 'live';

  // The Free plan is sandbox-only. A live key on the free plan is an
  // upgrade requirement, not an auth failure — respond 402 so a client
  // can tell "pay or downgrade" apart from "bad key".
  if (keyMode === 'live' && key.plan_code === 'free') {
    return res.status(402).json({
      error: 'upgrade_required',
      message: 'Live checks are not included in the Free (sandbox) plan. Upgrade to Starter, Growth or Scale — or use an sk_test_ key for sandbox responses.',
    });
  }

  req.apiKey = raw;
  req.apiKeyMode = keyMode;
  req.apiAccount = {
    id: key.account_id,
    userId: key.user_id,
    companyName: key.company_name,
    website: key.website,
    planId: key.plan_id,
    planPriceKes: key.monthly_price_kes,
    monthlyQuota: key.monthly_quota,
    rateLimitPerMin: key.rate_limit_per_min,
    webhooksEnabled: key.webhooks_enabled,
    batchEnabled: key.batch_enabled,
    planCode: key.plan_code,
    planName: key.plan_name,
    status: key.status,
  };
  req.apiKeyId = key.id;
  req.apiKeyLastUsedAt = key.last_used_at;

  // Throttle last_used_at updates to once per minute per key.
  const now = Date.now();
  const last = req.apiKeyLastUsedAt ? new Date(req.apiKeyLastUsedAt).getTime() : 0;
  if (now - last >= 60 * 1000) {
    pool.query(
      `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
      [key.id]
    ).catch(() => {});
  }

  next();
}

module.exports = { apiKeyAuth, keyedHash, normalizeKey };
