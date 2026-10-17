'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

globalThis.__pool = { query: async () => ({ rows: [] }) };

const { normalizeSubject, ValidationError, REPORT_TYPES, hashSubject } = require('../services/normalizeService');
const { verdictMapper, VERDICT_LABELS } = require('../services/verdictMapper');
const { sign, verifySignature, deliver } = require('../services/webhookService');
const { sendOtpEmail, sendContactMessageToManagement, sendSubscriptionReminderEmail } = require('../services/emailService');

function signals(over = {}) {
  return {
    scamVotes: 0,
    legitVotes: 0,
    cbkMatch: false,
    internationalScamScore: 0,
    externalBreachScore: 0,
    hasGovernmentScamHit: false,
    externalAvailable: false,
    hasDispute: false,
    ...over,
  };
}

test('contract: normalize registers the six report types', () => {
  assert.equal(REPORT_TYPES.length, 6);
  for (const t of ['phone', 'paybill', 'business', 'website', 'job', 'other']) {
    assert.ok(REPORT_TYPES.includes(t), `missing ${t}`);
  }
  assert.equal(normalizeSubject('phone', '0712345678').value, '254712345678');
  assert.equal(normalizeSubject('business', '  Acme Corp  ').value, 'Acme Corp');
  assert.equal(normalizeSubject('website', 'example.co.ke').value, 'example.co.ke');
  assert.equal(normalizeSubject('other', 'suspicious till number').value, 'suspicious till number');
});

test('contract: normalize rejects invalid payloads with coded errors', () => {
  const bad = [
    () => normalizeSubject('bank', '12345'),
    () => normalizeSubject('business', 'a'),
    () => normalizeSubject('website', 'localhost'),
    () => normalizeSubject('phone', 'not-a-phone'),
    () => normalizeSubject('other', 'hi'),
  ];
  for (const fn of bad) {
    assert.throws(fn, ValidationError);
    try { fn(); } catch (e) { assert.equal(typeof e.code, 'string'); }
  }
});

test('contract: verdict vocabulary matches the spec', () => {
  assert.deepEqual(Object.keys(VERDICT_LABELS).sort(), ['caution', 'registered', 'reported', 'unverified']);
});

test('contract: verdict mapper rules', () => {
  assert.equal(verdictMapper(signals({})).verdict, 'unverified');
  assert.equal(verdictMapper(signals({ scamVotes: 5, legitVotes: 0 })).verdict, 'reported');
  assert.equal(verdictMapper(signals({ hasGovernmentScamHit: true })).verdict, 'reported');
  assert.equal(verdictMapper(signals({ cbkMatch: true })).verdict, 'registered');
  assert.equal(verdictMapper(signals({ scamVotes: 5, hasDispute: true })).verdict, 'caution');
  const out = verdictMapper(signals({ scamVotes: 5, hasDispute: true }));
  assert.ok(out.reasons.some((r) => r.code === 'disputed'));
});

test('contract: sign and verifySignature wire up with the account secret', () => {
  const body = JSON.stringify({ event: 'report.created', id: 'r-1' });
  const ts = Math.floor(Date.now() / 1000);
  const secret = 'whsec_test_key_32bytes!!!';
  const sig = sign(secret, ts, body);
  assert.equal(typeof sig, 'string');
  assert.match(sig, /^[A-Za-z0-9\-_]+=*$/);
  assert.equal(verifySignature(body, ts, secret, `t=${ts},v1=${sig}`), true);
  assert.equal(verifySignature(body, ts, 'other-secret', `t=${ts},v1=${sig}`), false);
  assert.equal(verifySignature(body + 'x', ts, secret, `t=${ts},v1=${sig}`), false);
});

test('contract: deliver posts once without touching the network in tests', async () => {
  let calls = 0;
  globalThis.__webhookPost = async () => { calls += 1; return { status: 200 }; };
  try {
    const row = {
      id: 'wd_contract_1',
      webhook_url: 'https://example.com/hook',
      event: 'report.created',
      payload_json: JSON.stringify({ event: 'report.created' }),
      secret: 'whsec_test',
      attempts: 0,
    };
    const out = await deliver(row);
    assert.equal(out.status, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.__webhookPost = undefined;
  }
});

test('contract: emailService exposes the admin send paths', () => {
  assert.equal(typeof sendOtpEmail, 'function');
  assert.equal(typeof sendContactMessageToManagement, 'function');
  assert.equal(typeof sendSubscriptionReminderEmail, 'function');
});

test('contract: subject hashes are stable and typed', () => {
  const a = hashSubject('paybill', '400200');
  assert.equal(a, hashSubject('paybill', '400200'));
  assert.notEqual(a, hashSubject('phone', '400200'));
  assert.match(a, /^[0-9a-f]{64}$/);
});
