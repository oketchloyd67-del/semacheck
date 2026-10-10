const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_SECRET = process.env.API_KEY_HASH_SECRET || '';
const MAX_ACTIVE_SECRETS = parseInt(process.env.API_KEY_MAX_SECRETS || '5', 10);
const MAX_ACTIVE_PUBLISHABLES = parseInt(process.env.API_KEY_MAX_PUBLISHABLES || '3', 10);

const PREFIX_SECRET = 'sk_live_';
const PREFIX_PUBLISHABLE = 'pk_live_';
const KEY_LENGTH = 43;
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function randomSuffix() {
  let s = '';
  for (let i = 0; i < KEY_LENGTH; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}

function generateKey(label, type, allowedDomains) {
  if (!HASH_SECRET) throw new Error('API_KEY_HASH_SECRET is not configured in .env.');
  const suffix = randomSuffix();
  const raw = type === 'secret' ? PREFIX_SECRET + suffix : PREFIX_PUBLISHABLE + suffix;
  const hash = crypto.createHmac('sha256', HASH_SECRET).update(raw).digest('hex');
  const keyPrefix = raw.slice(0, 12);
  return { raw, hash, keyPrefix };
}

async function createKey(accountId, type, label, allowedDomains) {
  const countSql = `SELECT COUNT(*)::int AS n FROM api_keys WHERE account_id=$1 AND key_type=$2 AND status='active'`;
  const count = await pool.query(countSql, [accountId, type]);
  const current = Number(count.rows[0].n);

  if (type === 'secret' && current >= MAX_ACTIVE_SECRETS) {
    throw new Error(`Too many active secret keys (max ${MAX_ACTIVE_SECRETS}).`);
  }
  if (type === 'publishable' && current >= MAX_ACTIVE_PUBLISHABLES) {
    throw new Error(`Too many active publishable keys (max ${MAX_ACTIVE_PUBLISHABLES}).`);
  }

  const { raw, hash, keyPrefix } = generateKey(label, type, allowedDomains || []);
  const { rows } = await pool.query(
    `INSERT INTO api_keys (account_id, label, key_type, key_prefix, key_hash, allowed_domains, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id, key_type, key_prefix, status`,
    [accountId, label, type, keyPrefix, hash, allowedDomains || []]
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
    `SELECT id, key_type, key_prefix, status, last_used_at, revoked_at, label FROM api_keys
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
