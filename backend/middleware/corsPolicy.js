'use strict';
// CORS policy for /api. Kept separate from server.js so the allowlist can be
// unit-tested: a wildcard in ALLOWED_ORIGIN must never turn the credentialed
// /api into an any-website endpoint.

// The admin panel is deployed at contsemacheck.vercel.app. Do NOT re-add
// semacheck-admin.vercel.app: that hostname answers DEPLOYMENT_NOT_FOUND, so a
// third party could claim it and inherit this credentialed allowlist.
const FIRST_PARTY_ORIGINS = [
  'https://contsemacheck.vercel.app',
  'https://semacheck.vercel.app',
  'https://semacheck.onrender.com',
];

const DEV_ORIGINS = [
  'http://localhost:4800',
  'http://127.0.0.1:4800',
  'http://localhost:3000',
  'http://localhost:5173',
];

function apiOriginSet(env = process.env) {
  const configured = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  return new Set([
    ...FIRST_PARTY_ORIGINS,
    ...configured,
    ...(isProduction ? [] : DEV_ORIGINS),
  ]);
}

function apiOriginAllowed(origin, env = process.env) {
  // Server-to-server callers (Tuma's callback, cron jobs) send no Origin.
  if (!origin) return true;
  return apiOriginSet(env).has(origin);
}

module.exports = { FIRST_PARTY_ORIGINS, DEV_ORIGINS, apiOriginSet, apiOriginAllowed };
