const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_SECRET = process.env.API_KEY_HASH_SECRET || '';
const HASH_ALGO = 'sha256';

function keyedHash(raw) {
  if (!HASH_SECRET) throw new Error('API_KEY_HASH_SECRET is not configured in .env.');
  const h = crypto.createHmac(HASH_ALGO, HASH_SECRET).update(raw).digest('hex');
  return h;
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
    return res.status(401).json({ error: 'invalid_api_key', hint: 'Send Authorization: Bearer sk_live_xxxx' });
  }

  const raw = normalizeKey(match[1]);
  if (!raw || !/^sk_live_[A-Za-z0-9_-]{20,64}$/.test(raw)) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  const hash = keyedHash(raw);
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

  req.apiKey = raw;
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
