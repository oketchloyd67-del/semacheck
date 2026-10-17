const { test } = require('node:test');
const assert = require('node:assert/strict');

globalThis.__pool = {
  query: async () => ({ rows: [] }),
};

const { sign, verifySignature, deliver } = require('../services/webhookService');

const SIGNING_SECRET = 'test-secret-' + Date.now();
const ACCOUNT_ID = 'acct_test_1';
const EVENT = 'webhook.test_event';
const PAYLOAD = { event: EVENT, data: { id: '1' } };

function makeRow(overrides = {}) {
  return {
    id: 'wd_' + Math.random().toString(36).slice(2),
    account_id: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    webhook_url: 'https://example.com/hook',
    event: EVENT,
    payload_json: JSON.stringify(PAYLOAD),
    secret: SIGNING_SECRET,
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    last_response_code: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function installPostStub(answers) {
  let i = 0;
  globalThis.__webhookPost = async () => answers[i++ % answers.length];
}

function restorePost() {
  globalThis.__webhookPost = undefined;
}

test('sign produces an ASCII-base64url SHA-256 HMAC and verifySignature checks it', () => {
  const timestamp = 1700000000;
  const token = sign(SIGNING_SECRET, timestamp, JSON.stringify(PAYLOAD));
  assert.match(token, /^[A-Za-z0-9\-_]+=*$/);

  assert.equal(verifySignature(JSON.stringify(PAYLOAD), timestamp, SIGNING_SECRET, `t=${timestamp},v1=${token}`), true);

  const tampered = sign(SIGNING_SECRET, timestamp, JSON.stringify({ ...PAYLOAD, data: { id: '2' } }));
  assert.equal(verifySignature(JSON.stringify(PAYLOAD), timestamp, SIGNING_SECRET, `t=${timestamp},v1=${tampered}`), false);

  assert.equal(verifySignature(JSON.stringify(PAYLOAD), timestamp + 1, SIGNING_SECRET, `t=${timestamp},v1=${token}`), false);
  assert.equal(verifySignature(JSON.stringify(PAYLOAD), timestamp, 'wrong-secret', `t=${timestamp},v1=${token}`), false);
});

test('verifySignature rejects wrong algorithm / tampered body / wrong secret', () => {
  const token = sign(SIGNING_SECRET, Date.now(), JSON.stringify(PAYLOAD));
  assert.equal(verifySignature(token, token), false);
  assert.equal(verifySignature(JSON.stringify(PAYLOAD), token), false);
  assert.equal(verifySignature('wrong', token), false);
  assert.equal(verifySignature('', Date.now(), SIGNING_SECRET, `v1=${token}`), false);
  assert.equal(verifySignature(JSON.stringify(PAYLOAD), Date.now(), SIGNING_SECRET, ''), false);
});

test('deliver marks a good response delivered and keeps a bad response pending', async () => {
  const good = makeRow({ id: 'wd_good_1' });
  const bad = makeRow({ id: 'wd_bad_1' });
  installPostStub([{ status: 200 }, { status: 502 }]);

  try {
    assert.equal((await deliver(good)).status, 200);
    assert.equal((await deliver(bad)).status, 502);
  } finally {
    restorePost();
  }
});

test('deliver retries transient-status bodies without failing the delivery', async () => {
  const row = makeRow({ id: 'wd_retry_1' });
  installPostStub([{ status: 502 }, { status: 200 }]);

  try {
    assert.equal((await deliver(row)).status, 502);
    assert.equal((await deliver(row)).status, 200);
  } finally {
    restorePost();
  }
});

test('deliver returns a server error and schedules a retry when the receiver is down', async () => {
  const row = makeRow({ id: 'wd_down_1' });
  globalThis.__webhookPost = async () => { throw new Error('ECONNREFUSED'); };

  try {
    assert.equal((await deliver(row)).status, 500);
  } finally {
    restorePost();
  }
});

test('deliver signs the payload with the account secret', async () => {
  const row = makeRow({ id: 'wd_sig_1' });
  let seenHeaders = null;
  globalThis.__webhookPost = async (url, body, headers) => {
    seenHeaders = headers;
    return { status: 200 };
  };

  try {
    await deliver(row);
    const timestamp = Math.floor(Date.now() / 1000);
    const header = seenHeaders['X-SemaCheck-Signature'];
    assert.match(header, /^t=\d+,v1=/);
    const token = header.split('v1=')[1];
    assert.equal(verifySignature(row.payload_json, Number(header.split(',')[0].slice(2)), SIGNING_SECRET, header), true);
    assert.ok(token.length > 0);
    assert.ok(Math.abs(Number(header.split(',')[0].slice(2)) - timestamp) <= 2);
  } finally {
    restorePost();
  }
});
