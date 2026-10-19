// CHK: a credentialed /api must never reflect an arbitrary website origin.
const test = require('node:test');
const assert = require('node:assert/strict');

const { apiOriginAllowed } = require('../middleware/corsPolicy');

const prod = { NODE_ENV: 'production', ALLOWED_ORIGIN: '' };

test('first-party origins are allowed on /api', () => {
  assert.equal(apiOriginAllowed('https://semacheck.vercel.app', prod), true);
  assert.equal(apiOriginAllowed('https://contsemacheck.vercel.app', prod), true);
  assert.equal(apiOriginAllowed('https://semacheck.onrender.com', prod), true);
});

test('an unknown website is rejected in production', () => {
  assert.equal(apiOriginAllowed('https://evil.example', prod), false);
  assert.equal(apiOriginAllowed('https://semacheck.vercel.app.evil.example', prod), false);
  assert.equal(apiOriginAllowed('null', prod), false);
  // That hostname is unclaimed (DEPLOYMENT_NOT_FOUND), so allowing it would let
  // whoever registers it call the credentialed API.
  assert.equal(apiOriginAllowed('https://semacheck-admin.vercel.app', prod), false);
});

test('a wildcard in ALLOWED_ORIGIN does not open /api', () => {
  const env = { NODE_ENV: 'production', ALLOWED_ORIGIN: '*' };
  assert.equal(apiOriginAllowed('https://evil.example', env), false);
  assert.equal(apiOriginAllowed('https://semacheck.vercel.app', env), true);
});

test('explicitly configured production origins are allowed', () => {
  const env = { NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://partner.example, https://other.example' };
  assert.equal(apiOriginAllowed('https://partner.example', env), true);
  assert.equal(apiOriginAllowed('https://other.example', env), true);
  assert.equal(apiOriginAllowed('https://third.example', env), false);
});

test('localhost is only allowed outside production', () => {
  assert.equal(apiOriginAllowed('http://localhost:4800', { NODE_ENV: 'production' }), false);
  assert.equal(apiOriginAllowed('http://localhost:4800', { NODE_ENV: 'development' }), true);
});

test('server-to-server calls with no Origin are allowed', () => {
  assert.equal(apiOriginAllowed(undefined, prod), true);
  assert.equal(apiOriginAllowed('', prod), true);
});
