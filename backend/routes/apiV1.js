const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const tuma = require('../services/tuma');
const { normalizeKenyanPhone } = require('../utils/validators');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { apiRateLimit, apiRateLimit: widgetRateLimit } = require('../middleware/apiRateLimit');
const { quotaMeter, quotaMeter: widgetQuotaMeter } = require('../middleware/quotaMeter');
const { widgetOrigin } = require('../middleware/widgetOrigin');
const checkService = require('../services/checkService');
const usageService = require('../services/usageService');
const { reportAbuseGuard } = require('../middleware/reportAbuseGuard');
const { submitReport } = require('../services/reportService');
const { gateAbuseLimiter } = require('./paidCheckLimiter');
// Paid-check token abuse limits: STK prompts to the same phone too often, and
// paid checks started by one key too fast in an hour, both get a hard 402
// plan_expired reply so a client can tell "try later" from "bad key" (401).
//
// The policy is kept in paidCheckLimiter.js so the route file stays a thin
// wiring layer. Do not duplicate the constants or the gate logic here.

const router = express.Router();

const API_ROOT = '/v1';

// ── Sandbox responses for test keys ─────────────────────────────────────────
// sk_test_ keys never touch live data or the database. The response shape is
// The response shape is
// identical to /v1/check so integration code can be built before going live.
// The subject text picks the verdict: include "scam", "suspect" or
// "unverified" to preview each verdict; anything else returns legit.
// The subject text picks the verdict: include "scam", "suspect" or
// "unverified" to preview each verdict; anything else returns registered.
// Values are the canonical four (reported / caution / registered / unverified)
// and confidence is 0-100, exactly like a live check.
function sandboxCheck(checkType, subject) {
  const s = String(subject).toLowerCase();
  let verdict = 'registered';
  let confidence = 55;
  let displayVerdict = 'REGISTERED (SANDBOX)';
  if (s.includes('scam') || s.includes('fraud')) {
    verdict = 'reported'; confidence = 98; displayVerdict = 'REPORTED (SANDBOX)';
  } else if (s.includes('suspect') || s.includes('caution')) {
    verdict = 'caution'; confidence = 60; displayVerdict = 'CAUTION (SANDBOX)';
  } else if (s.includes('unverified') || s.includes('unknown')) {
    verdict = 'unverified'; confidence = 20; displayVerdict = 'UNVERIFIED (SANDBOX)';
  }
  return {
    verdict,
    confidence,
    displayVerdict,
    reasons: [{ verdict, source: 'sandbox', label: 'Test-key response — no live data was consulted and nothing was billed.' }],
    summary: `Sandbox response for a ${checkType} check. Include "scam", "suspect" or "unverified" in the subject to preview other verdicts.`,
  };
}

// ── Pay-gating: /v1/gate (or /v1/paid-check) → checkToken → /v1/token/verify ─
// /v1/gate charges the API customer's own account (STK push to the billing
// phone on the account); /v1/paid-check charges an end user KES 30 in the
// integration's own checkout. Both open a 15-minute window and
// /v1/token/verify answers "awaiting_payment" until the payment callback
// confirms, then the verdict once.
const GATE_PRICE_KES = 30;
const GATE_TTL_MINUTES = 15;

function hashGateToken(token) {
  const secret = process.env.API_KEY_HASH_SECRET || '';
  return crypto.createHmac('sha256', secret || 'gate-fallback').update(String(token)).digest('hex');
}

// POST /v1/check — API key (secret), authenticated developer
router.post('/check', apiKeyAuth, apiRateLimit, quotaMeter, async (req, res) => {
  const { checkType, subject, region } = req.body;
  if (!checkType || !subject) {
    return res.status(400).json({ error: 'checkType and subject are required.' });
  }
  if (!['phone', 'paybill', 'business', 'website', 'job'].includes(checkType)) {
    return res.status(400).json({ error: 'checkType must be phone, paybill, business, website or job.' });
  }

  const requestId = req.id;
  const start = Date.now();

  // Sandbox keys get deterministic canned responses — no DB, no quota.
  if (req.apiKeyMode === 'test') {
    const sandbox = sandboxCheck(checkType, subject);
    res.setHeader('X-Request-Id', requestId);
    return res.json({
      requestId,
      mode: 'sandbox',
      cached: false,
      verdict: sandbox.verdict,
      confidence: sandbox.confidence,
      displayVerdict: sandbox.displayVerdict,
      reasons: sandbox.reasons,
      summary: sandbox.summary,
      disputed: false,
      subject,
      region,
      meta: { plan: req.apiAccount.planName, planCode: req.apiAccount.planCode, sandbox: true },
    });
  }

  try {
    const result = await checkService.run({ userId: req.apiAccount.userId, checkType, rawValue: subject, region: region || 'kenya' });
    const latency = Date.now() - start;
    const accountId = Number(req.apiAccount.id);
    const keyId = Number(req.apiKeyId);

    await usageService.logUsage({
      requestId,
      accountId,
      keyId,
      endpoint: '/v1/check',
      checkType,
      subjectHash: result.cached ? null : result.result.query_value_hash,
      verdict: result.result.verdict,
      cacheHit: result.cached,
      statusCode: 200,
      latencyMs: latency,
    });

    res.setHeader('X-Request-Id', requestId);
    res.json({
      requestId,
      cached: result.cached,
      verdict: result.result.verdict,
      confidence: result.result.confidence,
      displayVerdict: result.result.displayVerdict,
      reasons: result.result.reasons,
      summary: result.result.summary,
      disputed: Boolean(result.result.disputed),
      subject: result.result.query_value,
      region,
      meta: { plan: req.apiAccount.planName, planCode: req.apiAccount.planCode },
    });
  } catch (err) {
    const latency = Date.now() - start;
    console.error('check failed:', err);
    res.setHeader('X-Request-Id', requestId);
    res.status(500).json({ error: 'check_failed', message: err.message });
  }
});

// GET /v1/usage — account usage history
router.get('/usage', apiKeyAuth, apiRateLimit, quotaMeter, async (req, res) => {
  const accountId = Number(req.apiAccount.id);
  const { days = 30 } = req.query;
  const series = await usageService.getDailySeries(accountId, Number(days));
  const month = await usageService.getMonthUsage(accountId);
  res.json({ series, month, plan: req.apiAccount.planName });
});

// POST /v1/batch — Growth plan only (optional per spec recommendation).
router.post('/batch', apiKeyAuth, apiRateLimit, quotaMeter, async (req, res) => {
  if (!req.apiAccount.batchEnabled) {
    return res.status(402).json({ error: 'batch_not_enabled', plan: req.apiAccount.planName });
  }
  const { subjects } = req.body;
  if (!Array.isArray(subjects)) return res.status(400).json({ error: 'subjects array required.' });
  const results = [];
  for (const s of subjects) {
    const r = await checkService.run({ userId: req.apiAccount.userId, checkType: s.type, rawValue: s.value });
    results.push({ type: s.type, value: s.value, verdict: r.result.verdict, confidence: r.result.confidence });
  }
  res.json({ results });
});

// POST /v1/widget/check — publishable key, origin-checked
router.post('/widget/check', apiKeyAuth, widgetRateLimit, widgetQuotaMeter, widgetOrigin, async (req, res) => {
  const { subject, region } = req.body;
  if (!subject) return res.status(400).json({ error: 'subject is required.' });
  const requestId = req.id;
  const start = Date.now();
  try {
    const result = await checkService.run({ userId: null, checkType: 'phone', rawValue: subject, region: region || 'kenya' });
    const latency = Date.now() - start;
    const accountId = Number(req.apiAccount.id);
    const keyId = Number(req.apiKeyId);
    await usageService.logUsage({
      requestId,
      accountId,
      keyId,
      endpoint: '/v1/widget/check',
      checkType: 'phone',
      subjectHash: result.cached ? null : result.result.query_value_hash,
      verdict: result.result.verdict,
      cacheHit: result.cached,
      statusCode: 200,
      latencyMs: latency,
    });
    res.setHeader('X-Request-Id', requestId);
    res.json({
      requestId,
      verdict: result.result.verdict,
      confidence: result.result.confidence,
      displayVerdict: result.result.displayVerdict,
      reasons: result.result.reasons,
      summary: result.result.summary,
    });
  } catch (err) {
    const latency = Date.now() - start;
    console.error('widget check failed:', err);
    res.setHeader('X-Request-Id', requestId);
    res.status(500).json({ error: 'widget_check_failed', message: err.message });
  }
});

// ── Pay-gating ───────────────────────────────────────────────────────────
// One token flow, two payment directions:
//
//   POST /v1/gate       — the API customer’s OWN payment. The STK push goes
//                         to the M-Pesa number on the account, so the
//                         integrator pays for the check, not their visitor.
//   POST /v1/paid-check — the KES 30 end-user charge (this flow used to be
//                         called /v1/gate): an STK push to any phone the
//                         integration supplies for its own checkout.
//
// Both issue a camelCase `checkToken` with a 15-minute window, polled at
// POST /v1/token/verify. The payment callback releases the verdict.
async function openPaidCheck(req, res, { phone, payer }) {
  const { checkType, subject } = req.body;
  if (!checkType || !subject) {
    return res.status(400).json({ error: 'missing_parameter', message: 'checkType and subject are required.' });
  }
  if (!['phone', 'paybill', 'business', 'website', 'job'].includes(checkType)) {
    return res.status(400).json({ error: 'invalid_check_type', message: 'checkType must be phone, paybill, business, website or job.' });
  }
  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) {
    const detail = phone === undefined || phone === null || phone === ''
      ? 'phone is required — the payer pays by M-Pesa STK push.'
      : 'phone must be a valid Kenyan M-Pesa number.';
    return res.status(400).json({ error: 'missing_parameter', message: detail });
  }

  const checkToken = 'chk_' + crypto.randomBytes(24).toString('base64url');
  const { rows: gateRows } = await pool.query(
    `INSERT INTO paygate_checks (account_id, token_hash, check_type, subject, price_kes, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)
     RETURNING id, price_kes, expires_at`,
    [Number(req.apiAccount.id), hashGateToken(checkToken), checkType, String(subject).slice(0, 255), GATE_PRICE_KES, String(GATE_TTL_MINUTES)]
  );
  const gate = gateRows[0];

  const { rows: payRows } = await pool.query(
    `INSERT INTO payments (user_id, purpose, reference_int, amount, phone, status)
     VALUES ($1,'api_paygate',$2,$3,$4,'initiated') RETURNING id`,
    [req.apiAccount.userId, gate.id, GATE_PRICE_KES, normalizedPhone]
  );
  const paymentId = payRows[0].id;
  await pool.query(`UPDATE paygate_checks SET payment_id=$2 WHERE id=$1`, [gate.id, paymentId]);

  try {
    const stk = await tuma.stkPush({
      phone: normalizedPhone,
      amount: GATE_PRICE_KES,
      description: payer === 'account' ? `SemaCheck API check #${gate.id}` : `SemaCheck end-user check #${gate.id}`,
    });
    await pool.query(
      `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
      [stk.checkout_request_id, stk.merchant_request_id, paymentId]
    );
    res.status(201).json({
      checkToken,
      status: 'awaiting_payment',
      payer,
      priceKes: GATE_PRICE_KES,
      expiresAt: gate.expires_at,
      message: stk.customer_message || 'STK push sent. The verdict is released once payment confirms.',
    });
  } catch (err) {
    console.error('paid check STK push failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
    await pool.query(`UPDATE paygate_checks SET status='failed' WHERE id=$1`, [gate.id]);
    res.status(502).json({ error: 'payment_start_failed', message: 'Could not start the M-Pesa payment. Please try again.' });
  }
}

// POST /v1/gate — gate a check behind the API customer’s own payment.
// Live keys on paid plans only; the STK push goes to the account’s own
// M-Pesa number (the account owner’s phone), never to a visitor.
router.post('/gate', apiKeyAuth, apiRateLimit, paymentLimiter, gateAbuseLimiter, async (req, res) => {
  if (req.apiKeyMode === 'test') {
    return res.status(402).json({ error: 'sandbox_key', message: 'Gating a check takes a real M-Pesa payment from your own account, so it needs a live key on a paid plan.' });
  }
  const { rows } = await pool.query('SELECT phone FROM users WHERE id = $1', [req.apiAccount.userId]);
  const billingPhone = rows[0] ? rows[0].phone : null;
  if (!normalizeKenyanPhone(billingPhone)) {
    return res.status(402).json({
      error: 'billing_phone_missing',
      message: 'This account has no M-Pesa number to charge. Add your billing phone in the API dashboard, then call /v1/gate again.',
    });
  }
  return openPaidCheck(req, res, { phone: billingPhone, payer: 'account' });
});

// POST /v1/paid-check — charge an end user KES 30 by STK push, then poll
// /v1/token/verify for the verdict. This is the original pay-per-check
// flow, renamed so /v1/gate can mean "the customer’s own payment".
router.post('/paid-check', apiKeyAuth, apiRateLimit, paymentLimiter, gateAbuseLimiter, async (req, res) => {
  if (req.apiKeyMode === 'test') {
    return res.status(402).json({ error: 'sandbox_key', message: 'Charging an end user takes a real M-Pesa payment, so it needs a live key on a paid plan.' });
  }
  return openPaidCheck(req, res, { phone: req.body.phone, payer: 'end_user' });
});

// POST /v1/token/verify — poll a checkToken. Returns "awaiting_payment"
// until the callback confirms, then the verdict (once, then "consumed").
router.post('/token/verify', apiKeyAuth, apiRateLimit, async (req, res) => {
  const { checkToken } = req.body;
  if (!checkToken) {
    return res.status(400).json({ error: 'missing_parameter', message: 'checkToken is required.' });
  }
  const { rows } = await pool.query(
    `SELECT id, check_type, subject, status, verdict, price_kes, expires_at FROM paygate_checks
     WHERE token_hash=$1 AND account_id=$2`,
    [hashGateToken(checkToken), Number(req.apiAccount.id)]
  );
  const gate = rows[0];
  if (!gate) return res.status(404).json({ error: 'token_not_found', message: 'checkToken is not valid for this account.' });

  if (gate.status === 'awaiting_payment' && new Date(gate.expires_at) < new Date()) {
    await pool.query(`UPDATE paygate_checks SET status='expired' WHERE id=$1`, [gate.id]);
    return res.status(402).json({ error: 'token_expired', message: `The ${GATE_TTL_MINUTES}-minute payment window elapsed. Call /v1/gate (or /v1/paid-check) again.` });
  }
  if (gate.status === 'awaiting_payment') {
    return res.json({ status: 'awaiting_payment', priceKes: gate.price_kes, expiresAt: gate.expires_at });
  }
  if (gate.status === 'expired') {
    return res.status(402).json({ error: 'token_expired', message: `The ${GATE_TTL_MINUTES}-minute payment window elapsed. Call /v1/gate (or /v1/paid-check) again.` });
  }
  if (gate.status === 'failed') {
    return res.status(402).json({ error: 'payment_failed', message: 'The M-Pesa payment did not complete.' });
  }

  // Paid: run the real check on first read, cache the verdict on the gate row.
  if (gate.status === 'paid') {
    try {
      const result = await checkService.run({ userId: req.apiAccount.userId, checkType: gate.check_type, rawValue: gate.subject });
      const r = result.result;
      await pool.query(`UPDATE paygate_checks SET status='consumed', consumed_at=now(), verdict=$2 WHERE id=$1`, [gate.id, r.verdict]);
      return res.json({
        status: 'paid',
        verdict: r.verdict,
        confidence: r.confidence,
        displayVerdict: r.displayVerdict,
        reasons: r.reasons,
        summary: r.summary,
        subject: r.query_value,
        meta: { plan: req.apiAccount.planName, planCode: req.apiAccount.planCode },
      });
    } catch (err) {
      console.error('gate verify check failed:', err);
      return res.status(500).json({ error: 'check_failed', message: 'Paid, but the check failed. Retry /v1/token/verify.' });
    }
  }

  // consumed — return the stored verdict so a lost response is recoverable.
  return res.json({ status: 'consumed', verdict: gate.verdict, message: 'This check was already delivered. Gate a new check for a fresh verdict.' });
});

// Public report form endpoints (Section 11)
router.post('/reports', apiKeyAuth, reportAbuseGuard, async (req, res) => {
  try {
    const fp = req.reportFingerprint || req.headers['x-forwarded-for'] || req.ip || '';
    const rec = await submitReport(req.body, null, fp);
    res.status(201).json({ report: rec, message: 'Report received. It goes to our moderation queue.' });
  } catch (err) {
    console.error('report failed:', err);
    res.status(400).json({ error: 'report_invalid', message: err.message });
  }
});

module.exports = router;
