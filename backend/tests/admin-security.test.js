// Admin security: mandatory TOTP, role gates and payment re-query parsing.
const test = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../services/totp');
const { requireRole } = require('../middleware/adminAuth');
const { interpretTumaStatus } = require('../services/paymentReconcile');

// RFC 6238 Appendix B secret ("12345678901234567890"), 6-digit truncations of
// the published 8-digit vectors.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.codeAt(RFC_SECRET, seconds * 1000), expected, `at ${seconds}s`);
    assert.equal(totp.verify(RFC_SECRET, expected, seconds * 1000), true);
  }
});

test('TOTP tolerates one step of drift but not a stale code', () => {
  const at = 1700000000000;
  const code = totp.codeAt(RFC_SECRET, at);
  assert.equal(totp.verify(RFC_SECRET, code, at + 29000), true);
  assert.equal(totp.verify(RFC_SECRET, code, at + 10 * 60000), false);
});

test('TOTP rejects malformed codes and a different secret', () => {
  const at = 1700000000000;
  const code = totp.codeAt(RFC_SECRET, at);
  assert.equal(totp.verify(RFC_SECRET, '12345', at), false);
  assert.equal(totp.verify(RFC_SECRET, 'abcdef', at), false);
  assert.equal(totp.verify(totp.generateSecret(), code, at), false);
});

test('base32 round-trips and the otpauth URL names the issuer', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(totp.base32Decode(totp.base32Encode(bytes)), bytes);
  const url = totp.otpauthUrl(RFC_SECRET, 'semacheck254@gmail.com');
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /issuer=SemaCheck/);
  assert.match(url, /secret=/);
  assert.match(url, /digits=6/);
});

test('requireRole allows only the listed roles', () => {
  const run = (role) => {
    const req = { admin: { role } };
    let status = null;
    let body = null;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    let passed = false;
    requireRole('super_admin', 'reviewer')(req, res, () => { passed = true; });
    return { passed, status, body };
  };

  assert.equal(run('super_admin').passed, true);
  assert.equal(run('reviewer').passed, true);
  const support = run('support');
  assert.equal(support.passed, false);
  assert.equal(support.status, 403);
  assert.match(support.body.error, /cannot perform this action/);
});

test('Tuma status parsing never turns an unknown reply into success', () => {
  assert.equal(interpretTumaStatus({ data: { status: 'completed', result_code: 0, mpesa_receipt_number: 'ABC123' } }).state, 'success');
  assert.equal(interpretTumaStatus({ success: true, data: { status: 'completed', result_code: 0 } }).receipt, null);
  assert.equal(interpretTumaStatus({ data: { status: 'failed', result_code: 1032, failure_reason: 'cancelled by user' } }).state, 'failed');
  assert.equal(interpretTumaStatus({ data: { status: 'pending' } }).state, 'pending');
  assert.equal(interpretTumaStatus({ data: { status: 'completed', result_code: 1 } }).state, 'failed');
  assert.equal(interpretTumaStatus({ data: { status: 'something_new' } }).state, 'unknown');
  assert.equal(interpretTumaStatus({}).state, 'pending');
});
