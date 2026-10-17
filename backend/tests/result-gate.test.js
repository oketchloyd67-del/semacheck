const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../services/resultGate');

const SECRET = 'test-result-secret';
const NOW = 1_760_000_000_000;
const base = { accountId: 42, checkType: 'phone', subject: '254712345678', verdict: 'registered' };

function memoryConsume() {
  const used = new Set();
  return async (jti) => {
    if (used.has(jti)) return false;
    used.add(jti);
    return true;
  };
}

test('decide maps the canonical four onto allow / warn / block', () => {
  assert.equal(gate.decide('reported'), 'block');
  assert.equal(gate.decide('caution'), 'warn');
  assert.equal(gate.decide('registered'), 'allow');
  assert.equal(gate.decide('unverified'), 'warn');
  assert.equal(gate.decide('unverified', 'allow'), 'allow');
});

test('a registered check proceeds once, then the token is used', async () => {
  const consume = memoryConsume();
  const token = gate.issue(base, SECRET, NOW);
  const args = { accountId: 42, checkType: 'phone', subject: '254712345678' };

  const first = await gate.verify(token, args, SECRET, consume, NOW);
  assert.deepEqual(first, { ok: true, proceed: true, decision: 'allow', verdict: 'registered', reason: 'allowed' });

  const second = await gate.verify(token, args, SECRET, consume, NOW);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'token_used');
});

test('a forged or tampered token is rejected', async () => {
  const consume = memoryConsume();
  const token = gate.issue(base, SECRET, NOW);
  const args = { accountId: 42, checkType: 'phone', subject: '254712345678' };

  const forged = token.slice(0, -4) + 'AAAA';
  assert.equal((await gate.verify(forged, args, SECRET, consume, NOW)).reason, 'token_unknown');
  assert.equal((await gate.verify(token, args, 'other-secret', consume, NOW)).reason, 'token_unknown');
  assert.equal((await gate.verify('nope', args, SECRET, consume, NOW)).reason, 'token_unknown');
});

test('expired tokens, other accounts and changed numbers are rejected', async () => {
  const consume = memoryConsume();
  const token = gate.issue(base, SECRET, NOW);
  const args = { accountId: 42, checkType: 'phone', subject: '254712345678' };

  const expired = await gate.verify(token, args, SECRET, consume, NOW + (gate.TTL_SECONDS + 1) * 1000);
  assert.equal(expired.reason, 'token_expired');

  const otherCustomer = await gate.verify(token, { ...args, accountId: 7 }, SECRET, consume, NOW);
  assert.equal(otherCustomer.reason, 'token_unknown');

  const changedNumber = await gate.verify(token, { ...args, subject: '254799999999' }, SECRET, consume, NOW);
  assert.equal(changedNumber.reason, 'subject_mismatch');
});

test('caution needs an acknowledgement, reported never proceeds', async () => {
  const consume = memoryConsume();
  const caution = gate.issue({ ...base, verdict: 'caution' }, SECRET, NOW);
  const warn = await gate.verify(caution, { accountId: 42, checkType: 'phone', subject: base.subject }, SECRET, consume, NOW);
  assert.equal(warn.ok, true);
  assert.equal(warn.proceed, false);
  assert.equal(warn.reason, 'acknowledgement_required');

  const acked = gate.issue({ ...base, verdict: 'caution' }, SECRET, NOW);
  const acknowledged = await gate.verify(
    acked,
    { accountId: 42, checkType: 'phone', subject: base.subject, acknowledged: true },
    SECRET,
    consume,
    NOW
  );
  assert.equal(acknowledged.proceed, true);
  assert.equal(acknowledged.reason, 'acknowledged');

  const reported = gate.issue({ ...base, verdict: 'reported' }, SECRET, NOW);
  const blocked = await gate.verify(
    reported,
    { accountId: 42, checkType: 'phone', subject: base.subject, acknowledged: true },
    SECRET,
    consume,
    NOW
  );
  assert.equal(blocked.ok, true);
  assert.equal(blocked.proceed, false);
  assert.equal(blocked.reason, 'blocked');
});
