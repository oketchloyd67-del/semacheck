const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeToSeed, randomPassword } = require('../db/seedGuard');

test('seeding refuses to run in production', () => {
  assert.throws(() => assertSafeToSeed({ NODE_ENV: 'production' }), /Refusing to seed/);
  // Even a capitalised value counts.
  assert.throws(() => assertSafeToSeed({ NODE_ENV: 'Production' }), /Refusing to seed/);
});

test('seeding requires an explicit opt-in to touch production', () => {
  assert.doesNotThrow(() => assertSafeToSeed({ NODE_ENV: 'production', ALLOW_SEED_IN_PRODUCTION: 'yes-i-understand' }));
  assert.doesNotThrow(() => assertSafeToSeed({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertSafeToSeed({}));
});

test('generated admin passwords are long, mixed and never the old demo password', () => {
  const passwords = new Set();
  for (let i = 0; i < 50; i++) {
    const p = randomPassword();
    assert.equal(p.length, 24);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[0-9]/);
    assert.match(p, /[#$%&*+\-=?@]/);
    assert.notEqual(p, 'AdminDemo#2026');
    passwords.add(p);
  }
  assert.equal(passwords.size, 50, 'every generated password should be unique');
});
