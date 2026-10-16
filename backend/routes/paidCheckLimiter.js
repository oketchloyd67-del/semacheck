// Abuse limits for the paid gate (POST /v1/gate):
//   1. STK prompts to the same phone number, and
//   2. gates opened by the same API key.
// Both answer HTTP 402 with `rate_limited` — docs.html defines 402 as
// "pay or wait", so a client can tell "try later" apart from a bad key (401).
//
// The route file only wires this in as `gateAbuseLimiter`; keep the policy
// (constants and messages) here so it is not duplicated in the route.
const { makeLimiter } = require('../middleware/rateLimiter');
const { normalizeKenyanPhone } = require('../utils/validators');

const PHONE_LIMIT_PER_HOUR = 3;
const KEY_LIMIT_PER_HOUR = 50;

function tooMany(req, res, message) {
  return res.status(402).json({ error: 'rate_limited', message });
}

// Keyed on the E.164 phone number in the request body: one person should not
// collect a screenful of STK prompts in an hour.
const phoneGateLimiter = makeLimiter(
  {
    windowMs: 60 * 60 * 1000,
    limit: PHONE_LIMIT_PER_HOUR,
    keyGenerator: (req) => `gate:phone:${normalizeKenyanPhone(req.body?.phone || '')}`,
    handler: (req, res) => tooMany(
      req, res,
      `Too many M-Pesa payment prompts were started for this phone in the last hour (${PHONE_LIMIT_PER_HOUR}). Wait a while and try again.`
    ),
    validate: false,
  },
  'gatephone'
);

// Keyed on the calling API key: one integration should not open more than
// this many gates per hour.
const keyGateLimiter = makeLimiter(
  {
    windowMs: 60 * 60 * 1000,
    limit: KEY_LIMIT_PER_HOUR,
    keyGenerator: (req) => `gate:key:${req.apiKeyId || 'unknown'}`,
    handler: (req, res) => tooMany(
      req, res,
      `This key has opened too many paid checks in the last hour (${KEY_LIMIT_PER_HOUR}). Wait a while and try again.`
    ),
    validate: false,
  },
  'gatekey'
);

function gateAbuseLimiter(req, res, next) {
  // Without a valid phone the route itself answers 400 (no STK push can be
  // sent), so the phone limit is skipped rather than sharing one bucket for
  // every malformed request.
  const phone = normalizeKenyanPhone(req.body?.phone || '');
  const runKeyLimit = () => keyGateLimiter(req, res, next);

  if (!phone) return runKeyLimit();
  // When the phone limit trips, its handler answers and `runKeyLimit` never
  // runs — the request stops here.
  phoneGateLimiter(req, res, runKeyLimit);
}

module.exports = { gateAbuseLimiter, PHONE_LIMIT_PER_HOUR, KEY_LIMIT_PER_HOUR };
