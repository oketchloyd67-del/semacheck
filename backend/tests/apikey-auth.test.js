// apiKeyAuth must separate "your key is wrong" (401) from "your account needs
// paying or waiting on" (402). docs.html promises 402 always means pay or wait
// and is never an authentication failure — so a suspended or past_due account
// holding a valid key has to reach the 402 branch, not the 401 fallthrough.
const test = require('node:test');
const assert = require('node:assert');

process.env.API_KEY_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'test-hash-secret';

// Hermetic: apiKeyAuth only reads through pool.query, so register a stub in
// require.cache *before* the middleware loads. Otherwise this test depends on
// a live database connection and dies with the process when the remote DB is
// slow to answer.
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};

const pool = require('../db/pool');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');

const REAL_KEY = 'sk_live_' + 'a'.repeat(24);
const SANDBOX_KEY = 'sk_test_' + 'b'.repeat(24);

function accountRow(overrides = {}) {
  return {
    id: 'key-1',
    mode: 'live',
    status: 'active',
    last_used_at: null,
    account_id: 'acct-1',
    user_id: 'user-1',
    company_name: 'Acme Ltd',
    website: 'https://acme.co.ke',
    plan_id: 'plan-1',
    account_status: 'active',
    monthly_price_kes: 5000,
    monthly_quota: 2000,
    rate_limit_per_min: 60,
    webhooks_enabled: true,
    batch_enabled: false,
    plan_active: true,
    plan_code: 'starter',
    plan_name: 'Starter',
    ...overrides,
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function stubPool(row) {
  const original = pool.query;
  pool.query = async (sql) => {
    if (String(sql).includes('FROM api_keys k')) return { rows: row ? [row] : [] };
    return { rows: [] }; // last_used_at throttle update
  };
  return () => { pool.query = original; };
}

function request(key = REAL_KEY) {
  return { headers: { authorization: `Bearer ${key}` }, body: {} };
}

async function run(row, key) {
  const restore = stubPool(row);
  const res = fakeRes();
  let passed = false;
  try {
    await apiKeyAuth(request(key), res, () => { passed = true; });
  } finally {
    restore();
  }
  return { res, passed };
}

test('missing or malformed key is 401 invalid_api_key', async () => {
  const restore = stubPool(null);
  try {
    const noAuth = fakeRes();
    await apiKeyAuth({ headers: {}, body: {} }, noAuth, () => assert.fail('must not pass'));
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.body.error, 'invalid_api_key');

    const bad = fakeRes();
    await apiKeyAuth(request('nonsense'), bad, () => assert.fail('must not pass'));
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.body.error, 'invalid_api_key');
  } finally {
    restore();
  }
});

test('unknown or revoked key is 401 invalid_api_key', async () => {
  const { res, passed } = await run(null);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invalid_api_key');
});

test('suspended account with a live key is 402 plan_expired', async () => {
  const { res, passed } = await run(accountRow({ account_status: 'suspended' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'plan_expired');
  assert.match(res.body.message, /suspended/i);
});

test('past_due account with a live key is 402 plan_expired', async () => {
  const { res, passed } = await run(accountRow({ account_status: 'past_due' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'plan_expired');
});

test('pending (under review) account with a live key is 402, not 401', async () => {
  const { res, passed } = await run(accountRow({ account_status: 'pending' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'account_pending');
});

test('sandbox test keys keep working while billing blocks live keys', async () => {
  // docs.html promises test keys are not suspended by billing, and that
  // pending accounts can build with test keys while documents are reviewed.
  for (const status of ['pending', 'past_due', 'suspended']) {
    const { res, passed } = await run(accountRow({ account_status: status }), SANDBOX_KEY);
    assert.equal(passed, true, `test key should pass while account is ${status}`);
    assert.equal(res.statusCode, 200);
  }
});

test('every key of a closed account is 402 account_closed', async () => {
  const { res, passed } = await run(accountRow({ account_status: 'closed' }), SANDBOX_KEY);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'account_closed');
});

test('live key on the Free (sandbox) plan is 402 upgrade_required', async () => {
  const { res, passed } = await run(accountRow({ plan_code: 'free', plan_name: 'Free' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'upgrade_required');
});

test('retired plan with a live key is 402 plan_unavailable', async () => {
  const { res, passed } = await run(accountRow({ plan_active: false }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'plan_unavailable');
});

test('active account on a paid plan passes through', async () => {
  const { res, passed } = await run(accountRow());
  assert.equal(passed, true);
  assert.equal(res.statusCode, 200);
});
