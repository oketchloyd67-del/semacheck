'use strict';
// backend/services/resultGate.js
// A signed, short-lived, single-use "result token" so a customer's SERVER can
// confirm that a check really happened and what it decided, before it starts
// the END USER's payment.
//
// This is NOT the pay-gating token. `checkToken` (POST /v1/gate,
// /v1/paid-check → /v1/token/verify) is a PAYMENT token for charging per
// check. `resultToken` proves a check result, costs no quota to verify, and is
// bound to one account, one number and 10 minutes.
const crypto = require('crypto');

const TTL_SECONDS = 600;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

// verdict -> decision. "unverified" defaults to warn; change
// UNVERIFIED_DECISION to 'allow' if a customer prefers.
function decide(verdict, unverifiedDecision = 'warn') {
  if (verdict === 'reported') return 'block';
  if (verdict === 'caution') return 'warn';
  if (verdict === 'registered') return 'allow';
  return unverifiedDecision;
}

function subjectHash(checkType, subject, secret) {
  return crypto.createHmac('sha256', secret)
    .update(checkType + ':' + String(subject).trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function issue({ accountId, checkType, subject, verdict }, secret, now = Date.now()) {
  const payload = {
    j: crypto.randomBytes(12).toString('hex'),          // unique id, used for single use
    a: accountId,
    s: subjectHash(checkType, subject, secret),
    d: decide(verdict),
    v: verdict,
    e: Math.floor(now / 1000) + TTL_SECONDS,
  };
  const body = b64(JSON.stringify(payload));
  const sig = b64(crypto.createHmac('sha256', secret).update(body).digest());
  return 'rt_' + body + '.' + sig;
}

// consume(jti) must return true only the FIRST time (a unique insert in the database).
async function verify(token, { accountId, checkType, subject, acknowledged = false }, secret, consume, now = Date.now()) {
  const fail = (reason) => ({ ok: false, proceed: false, reason });
  if (typeof token !== 'string' || !token.startsWith('rt_') || token.length > 600) return fail('token_unknown');
  const [body, sig] = token.slice(3).split('.');
  if (!body || !sig) return fail('token_unknown');

  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail('token_unknown');

  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return fail('token_unknown');
  }

  if (p.a !== accountId) return fail('token_unknown');                                   // another customer's token
  if (Math.floor(now / 1000) > p.e) return fail('token_expired');
  if (p.s !== subjectHash(checkType, subject, secret)) return fail('subject_mismatch');  // number changed after the check
  if (!(await consume(p.j))) return fail('token_used');

  const proceed = p.d === 'allow' || (p.d === 'warn' && acknowledged === true);
  return {
    ok: true,
    proceed,
    decision: p.d,
    verdict: p.v,
    reason: proceed
      ? (p.d === 'warn' ? 'acknowledged' : 'allowed')
      : (p.d === 'warn' ? 'acknowledgement_required' : 'blocked'),
  };
}

module.exports = { issue, verify, decide, subjectHash, TTL_SECONDS };
