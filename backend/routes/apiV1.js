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

const router = express.Router();

const API_ROOT = '/v1';

// ── Sandbox responses for test keys ─────────────────────────────────────────
// sk_test_ keys never touch live data or the database. The response shape is
// identical to /v1/check so integration code can be built before going live.
// The subject text picks the verdict: include "scam", "suspect" or
// "unverified" to preview each verdict; anything else returns legit.
function sandboxCheck(checkType, subject) {
  const s = String(subject).toLowerCase();
  let verdict = 'legit';
  let confidence = 0.55;
  let displayVerdict = 'LEGIT (SANDBOX)';
  if (s.includes('scam') || s.includes('fraud')) {
    verdict = 'scam'; confidence = 0.98; displayVerdict = 'SCAM (SANDBOX)';
  } else if (s.includes('suspect') || s.includes('caution')) {
    verdict = 'suspicious'; confidence = 0.6; displayVerdict = 'SUSPICIOUS (SANDBOX)';
  } else if (s.includes('unverified') || s.includes('unknown')) {
    verdict = 'unverified'; confidence = 0.2; displayVerdict = 'UNVERIFIED (SANDBOX)';
  }
  return {
    verdict,
    confidence,
    displayVerdict,
    reasons: [{ verdict, source: 'sandbox', label: 'Test-key response — no live data was consulted and nothing was billed.' }],
    summary: `Sandbox response for a ${checkType} check. Include "scam", "suspect" or "unverified" in the subject to preview other verdicts.`,
  };
}

// ── Pay-gating: /v1/gate → check_token → /v1/token/verify ──────────────────
// A developer charges their own end user per check. /v1/gate opens a
// 15-minute window and fires an M-Pesa STK push; /v1/token/verify returns
// "pending" until the payment callback confirms, then the verdict once.
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

// POST /v1/gate — open a pay-gated check. Live keys on paid plans only.
router.post('/gate', apiKeyAuth, apiRateLimit, paymentLimiter, async (req, res) => {
  if (req.apiKeyMode === 'test') {
    return res.status(402).json({ error: 'sandbox_key', message: 'Pay-gating charges a real M-Pesa user, so it needs a live key on a paid plan.' });
  }
  const { checkType, subject, phone } = req.body;
  if (!checkType || !subject) {
    return res.status(400).json({ error: 'missing_parameter', message: 'checkType and subject are required.' });
  }
  if (!['phone', 'paybill', 'business', 'website', 'job'].includes(checkType)) {
    return res.status(400).json({ error: 'invalid_check_type', message: 'checkType must be phone, paybill, business, website or job.' });
  }
  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'missing_parameter', message: 'phone is required — the end user pays by M-Pesa STK push.' });
  }

  const token = 'chk_' + crypto.randomBytes(24).toString('base64url');
  const { rows: gateRows } = await pool.query(
    `INSERT INTO paygate_checks (account_id, token_hash, check_type, subject, price_kes, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)
     RETURNING id, price_kes, expires_at`,
    [Number(req.apiAccount.id), hashGateToken(token), checkType, String(subject).slice(0, 255), GATE_PRICE_KES, String(GATE_TTL_MINUTES)]
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
      description: `SemaCheck gated check #${gate.id}`,
    });
    await pool.query(
      `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
      [stk.checkout_request_id, stk.merchant_request_id, paymentId]
    );
    res.status(201).json({
      check_token: token,
      status: 'awaiting_payment',
      price_kes: GATE_PRICE_KES,
      expires_at: gate.expires_at,
      message: stk.customer_message || 'STK push sent. The verdict is released once payment confirms.',
    });
  } catch (err) {
    console.error('gate STK push failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
    await pool.query(`UPDATE paygate_checks SET status='failed' WHERE id=$1`, [gate.id]);
    res.status(502).json({ error: 'payment_start_failed', message: 'Could not start the M-Pesa payment. Please try again.' });
  }
});

// POST /v1/token/verify — poll a check_token. Returns "awaiting_payment"
// until the callback confirms, then the verdict (once, then "consumed").
router.post('/token/verify', apiKeyAuth, apiRateLimit, async (req, res) => {
  const { check_token: checkToken } = req.body;
  if (!checkToken) {
    return res.status(400).json({ error: 'missing_parameter', message: 'check_token is required.' });
  }
  const { rows } = await pool.query(
    `SELECT id, check_type, subject, status, verdict, price_kes, expires_at FROM paygate_checks
     WHERE token_hash=$1 AND account_id=$2`,
    [hashGateToken(checkToken), Number(req.apiAccount.id)]
  );
  const gate = rows[0];
  if (!gate) return res.status(404).json({ error: 'token_not_found', message: 'check_token is not valid for this account.' });

  if (gate.status === 'awaiting_payment' && new Date(gate.expires_at) < new Date()) {
    await pool.query(`UPDATE paygate_checks SET status='expired' WHERE id=$1`, [gate.id]);
    return res.status(402).json({ error: 'token_expired', message: `The ${GATE_TTL_MINUTES}-minute payment window elapsed. Call /v1/gate again.` });
  }
  if (gate.status === 'awaiting_payment') {
    return res.json({ status: 'awaiting_payment', price_kes: gate.price_kes, expires_at: gate.expires_at });
  }
  if (gate.status === 'expired') {
    return res.status(402).json({ error: 'token_expired', message: `The ${GATE_TTL_MINUTES}-minute payment window elapsed. Call /v1/gate again.` });
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
