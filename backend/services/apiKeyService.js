const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_SECRET = process.env.API_KEY_HASH_SECRET || '';
const MAX_ACTIVE_SECRETS = parseInt(process.env.API_KEY_MAX_SECRETS || '5', 10);
const MAX_ACTIVE_PUBLISHABLES = parseInt(process.env.API_KEY_MAX_PUBLISHABLES || '3', 10);

// Live keys (sk_live_/pk_live_) call real data and consume paid quota.
// Test keys (sk_test_/pk_test_) return deterministic sandbox responses and
// are the only keys the Free plan can use.
const PREFIXES = {
  secret: { live: 'sk_live_', test: 'sk_test_' },
  publishable: { live: 'pk_live_', test: 'pk_test_' },
};
const KEY_LENGTH = 43;
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function randomSuffix() {
  let s = '';
  for (let i = 0; i < KEY_LENGTH; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}

function generateKey(type, mode) {
  if (!HASH_SECRET) throw new Error('API_KEY_HASH_SECRET is not configured in .env.');
  const suffix = randomSuffix();
  const raw = PREFIXES[type][mode] + suffix;
  const hash = crypto.createHmac('sha256', HASH_SECRET).update(raw).digest('hex');
  const keyPrefix = raw.slice(0, 12);
  return { raw, hash, keyPrefix };
}

async function createKey(accountId, type, label, allowedDomains, mode, planCode) {
  type = type === 'publishable' ? 'publishable' : 'secret';
  mode = mode === 'test' ? 'test' : 'live';

  // The Free plan is sandbox-only: its accounts can only hold test keys.
  if (mode === 'live' && planCode === 'free') {
    throw new Error('The Free plan includes sandbox (test) keys only. Upgrade to a paid plan to create live keys.');
  }

  const countSql = `SELECT COUNT(*)::int AS n FROM api_keys WHERE account_id=$1 AND key_type=$2 AND status='active'`;
  const count = await pool.query(countSql, [accountId, type]);
  const current = Number(count.rows[0].n);

  if (type === 'secret' && current >= MAX_ACTIVE_SECRETS) {
    throw new Error(`Too many active secret keys (max ${MAX_ACTIVE_SECRETS}).`);
  }
  if (type === 'publishable' && current >= MAX_ACTIVE_PUBLISHABLES) {
    throw new Error(`Too many active publishable keys (max ${MAX_ACTIVE_PUBLISHABLES}).`);
  }

  const { raw, hash, keyPrefix } = generateKey(type, mode);
  const { rows } = await pool.query(
    `INSERT INTO api_keys (account_id, label, key_type, key_prefix, key_hash, allowed_domains, status, mode)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING id, key_type, key_prefix, status, mode`,
    [accountId, label, type, keyPrefix, hash, allowedDomains || [], mode]
  );
  return { raw, ...rows[0] };
}

async function revokeKey(accountId, keyId) {
  const { rows } = await pool.query(
    `UPDATE api_keys SET status='revoked', revoked_at=now() WHERE account_id=$1 AND id=$2 AND status='active' RETURNING id, status`,
    [accountId, keyId]
  );
  if (!rows[0]) throw new Error('Key not found or not active.');
  return rows[0];
}

async function listKeys(accountId) {
  const { rows } = await pool.query(
    `SELECT id, key_type, key_prefix, status, last_used_at, revoked_at, label, mode FROM api_keys
     WHERE account_id=$1 ORDER BY created_at DESC`,
    [accountId]
  );
  return rows;
}

async function verifyKey(raw) {
  if (!HASH_SECRET) return null;
  const hash = crypto.createHmac('sha256', HASH_SECRET).update(String(raw || '')).digest('hex');
  const { rows } = await pool.query(
    `SELECT k.*, a.id AS account_id, a.user_id, a.company_name, a.website, a.plan_id, p.monthly_price_kes,
            p.monthly_quota, p.rate_limit_per_min, p.webhooks_enabled, p.batch_enabled, p.is_active AS plan_active,
            p.code AS plan_code, p.name AS plan_name
     FROM api_keys k
     JOIN api_accounts a ON a.id = k.account_id
     JOIN api_plans p ON p.id = a.plan_id
     WHERE k.key_hash = $1 AND k.status = 'active' AND p.is_active = TRUE`,
    [hash]
  );
  return rows[0] || null;
}

module.exports = { createKey, revokeKey, listKeys, verifyKey, generateKey };
