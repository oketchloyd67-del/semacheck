'use strict';
// backend/db/seedGuard.js — require this at the TOP of backend/db/seed.js
// 1. Refuses to run against production.
// 2. Never uses a fixed password: it generates one and prints it once.
const crypto = require('crypto');

function assertSafeToSeed(env = process.env) {
  const prod = String(env.NODE_ENV).toLowerCase() === 'production';
  const allowed = env.ALLOW_SEED_IN_PRODUCTION === 'yes-i-understand';
  if (prod && !allowed) {
    throw new Error('Refusing to seed: NODE_ENV is production. Demo accounts must never exist in production.');
  }
}

function randomPassword() {
  // 24 characters, letters and digits, at least one of each class
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const sym = '#$%&*+-=?@';
  const all = upper + lower + digits + sym;
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(sym)];
  while (chars.length < 24) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = { assertSafeToSeed, randomPassword };
