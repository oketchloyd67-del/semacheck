const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSubject, ValidationError, hashSubject, REPORT_TYPES } = require('../services/normalizeService');

const norm = (type, value) => normalizeSubject(type, value).value;

test('REPORT_TYPES covers the six registered types', () => {
  assert.deepEqual([...REPORT_TYPES].sort(), ['business', 'job', 'other', 'paybill', 'phone', 'website'].sort());
});

test('normalize.phone accepts valid Kenyan formats and returns E.164', () => {
  assert.equal(norm('phone', '0712 345 678'), '254712345678');
  assert.equal(norm('phone', '254712345678'), '254712345678');
  assert.equal(norm('phone', '0712345678'), '254712345678');
  assert.equal(norm('phone', '+254 712 345 678'), '254712345678');
});

test('normalize.phone rejects invalid digits and lengths', () => {
  for (const bad of ['071234567890', '00254712345678', '07123456789', '2547123456790', '25471234567', 'not-a-phone', '']) {
    assert.throws(() => norm('phone', bad), { code: 'invalid_phone' }, `should reject ${JSON.stringify(bad)}`);
  }
});

test('normalize.paybill requires 5-7 digits', () => {
  assert.equal(norm('paybill', ' 400 200 '), '400200');
  assert.throws(() => norm('paybill', '40'), { code: 'invalid_paybill' });
  assert.throws(() => norm('paybill', '12345678'), { code: 'invalid_paybill' });
});

test('normalize.business trims and enforces length', () => {
  assert.equal(norm('business', '  Tech Solutions Ltd  '), 'Tech Solutions Ltd');
  assert.throws(() => norm('business', 'ab'), { code: 'invalid_business' });
  assert.throws(() => norm('business', 'x'.repeat(121)), { code: 'invalid_business' });
});

test('normalize.website accepts http(s) and returns lowercase public host', () => {
  assert.equal(norm('website', 'Example.co.KE'), 'example.co.ke');
  assert.equal(norm('website', 'https://www.agency.com/path?q=1'), 'www.agency.com');
  assert.equal(norm('website', 'deals-ke.com'), 'deals-ke.com');
  assert.throws(() => norm('website', 'http://10.0.0.1'), { code: 'invalid_website' });
  assert.throws(() => norm('website', 'localhost'), { code: 'invalid_website' });
  assert.throws(() => norm('website', 'nodot'), { code: 'invalid_website' });
  assert.throws(() => norm('website', ''), { code: 'invalid_website' });
});

test('normalize.job enforces range', () => {
  assert.equal(norm('job', '  M-KOPA  '), 'M-KOPA');
  assert.throws(() => norm('job', 'ab'), { code: 'invalid_job' });
});

test('normalize.other validates length', () => {
  assert.equal(norm('other', '  suspicious message  '), 'suspicious message');
  assert.throws(() => norm('other', 'hi'), { code: 'invalid_value' });
});

test('normalizer rejects unknown types', () => {
  assert.throws(() => normalizeSubject('bank', '12345'), { code: 'invalid_type' });
});

test('ValidationError carries a machine-readable code', () => {
  const err = new ValidationError('invalid_phone', 'bad');
  assert.equal(err.code, 'invalid_phone');
  assert.equal(err.name, 'ValidationError');
  assert.ok(err instanceof Error);
});

test('hashSubject produces deterministic HMAC-style digests', () => {
  const a = hashSubject('paybill', '400200');
  const b = hashSubject('paybill', '400200');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hashSubject('phone', '400200'));
});
