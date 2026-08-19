// routes/payments.js — payments via the Tuma gateway (see services/tuma.js)
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireJobOwner } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const tuma = require('../services/tuma');
const { normalizeKenyanPhone } = require('../utils/validators');

const router = express.Router();

const SEARCH_TIERS = [50, 100, 150]; // KES — basic / standard / full unlock
const SUBSCRIPTION_AMOUNT = 459; // KES / 30 days

// ---- initiate: pay-per-search ----
router.post('/search', requireAuth, paymentLimiter, async (req, res) => {
  const { tier, phone } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone) || normalizeKenyanPhone(req.user.phone);
  if (!SEARCH_TIERS.includes(Number(tier))) {
    return res.status(400).json({ error: `tier must be one of ${SEARCH_TIERS.join(', ')}` });
  }
  if (!normalizedPhone) return res.status(400).json({ error: 'A valid M-Pesa phone number is required.' });

  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, purpose, amount, phone, status)
     VALUES ($1,'search',$2,$3,'initiated') RETURNING id`,
    [req.user.id, tier, normalizedPhone]
  );
  const paymentId = rows[0].id;

  try {
    const stk = await tuma.stkPush({ phone: normalizedPhone, amount: tier, description: `SemaCheck search #${paymentId}` });
    await pool.query(
      `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
      [stk.checkout_request_id, stk.merchant_request_id, paymentId]
    );
    res.json({ paymentId, checkoutRequestId: stk.checkout_request_id, message: stk.customer_message || 'STK push sent. Enter your M-Pesa PIN to complete payment.' });
  } catch (err) {
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
    res.status(502).json({ error: err.message, paymentId });
  }
});

// ---- initiate: job-owner monthly subscription ----
router.post('/subscription', requireAuth, requireJobOwner, paymentLimiter, async (req, res) => {
  const normalizedPhone = normalizeKenyanPhone(req.body.phone) || normalizeKenyanPhone(req.user.phone);
  if (!normalizedPhone) return res.status(400).json({ error: 'A valid M-Pesa phone number is required.' });

  const { rows: subRows } = await pool.query(
    `INSERT INTO subscriptions (user_id, amount, status) VALUES ($1,$2,'pending') RETURNING id`,
    [req.user.id, SUBSCRIPTION_AMOUNT]
  );
  const subscriptionId = subRows[0].id;

  const { rows: payRows } = await pool.query(
    `INSERT INTO payments (user_id, purpose, reference_id, amount, phone, status)
     VALUES ($1,'subscription',$2,$3,$4,'initiated') RETURNING id`,
    [req.user.id, subscriptionId, SUBSCRIPTION_AMOUNT, normalizedPhone]
  );
  const paymentId = payRows[0].id;

  try {
    const stk = await tuma.stkPush({ phone: normalizedPhone, amount: SUBSCRIPTION_AMOUNT, description: `SemaCheck subscription #${subscriptionId}` });
    await pool.query(
      `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
      [stk.checkout_request_id, stk.merchant_request_id, paymentId]
    );
    res.json({ paymentId, subscriptionId, checkoutRequestId: stk.checkout_request_id, message: stk.customer_message || 'STK push sent. Enter your M-Pesa PIN to activate your subscription.' });
  } catch (err) {
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
    res.status(502).json({ error: err.message, paymentId });
  }
});

// ---- Tuma callback webhook (Tuma's servers call this, not the browser) ----
router.post('/tuma/callback', express.json(), async (req, res) => {
  // Acknowledge immediately, process asynchronously — same pattern as
  // Daraja: don't make the gateway wait on our DB writes.
  res.json({ received: true });

  try {
    const { status, checkout_request_id, result_code, mpesa_receipt_number, failure_reason } = req.body || {};
    if (!checkout_request_id) return;

    const { rows } = await pool.query('SELECT * FROM payments WHERE tuma_checkout_request_id = $1', [checkout_request_id]);
    const payment = rows[0];
    if (!payment) return;

    if (status !== 'completed' || result_code !== 0) {
      await pool.query(
        `UPDATE payments SET status='failed', raw_callback_json=$1, updated_at=now() WHERE id=$2`,
        [JSON.stringify({ ...req.body, failure_reason }), payment.id]
      );
      return;
    }

    await pool.query(
      `UPDATE payments SET status='success', mpesa_receipt=$1, raw_callback_json=$2, updated_at=now() WHERE id=$3`,
      [mpesa_receipt_number || null, JSON.stringify(req.body), payment.id]
    );

    if (payment.purpose === 'subscription') {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      await pool.query(
        `UPDATE subscriptions SET status='active', mpesa_receipt=$1, started_at=$2, expires_at=$3 WHERE id=$4`,
        [mpesa_receipt_number || null, startedAt, expiresAt, payment.reference_id]
      );
    }
    // 'search' purpose payments are picked up by routes/search.js, which
    // checks payment status before releasing the unlocked result.
  } catch (err) {
    if (err.code === '23505') {
      console.warn(`Tuma callback: receipt already used by another payment (checkout_request_id involved) — ignored as likely duplicate webhook delivery.`);
      return;
    }
    console.error('Tuma callback processing error:', err);
  }
});

// ---- poll payment status (frontend uses this while waiting on STK) ----
router.get('/status/:paymentId', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, purpose, status, amount, reference_id FROM payments WHERE id=$1 AND user_id=$2', [req.params.paymentId, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found.' });
  res.json(rows[0]);
});

// ---- manual fallback: user pastes in the M-Pesa code from their SMS ----
// Covers the case where the STK push genuinely succeeded (money left the
// user's phone) but Tuma's callback was delayed, dropped, or never
// reached us — a real possibility on any webhook-based integration.
// This is a pragmatic trust-the-user-provided-code path, not a live
// verification against Safaricom — every manually confirmed payment is
// flagged for reconciliation so it can be checked against the real M-Pesa
// statement later.
router.post('/:paymentId/confirm-manual', requireAuth, paymentLimiter, async (req, res) => {
  const { mpesaCode } = req.body;
  const code = String(mpesaCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,15}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the M-Pesa confirmation code from your SMS (e.g. QAR7XJ2KLM).' });
  }

  const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1 AND user_id=$2', [req.params.paymentId, req.user.id]);
  const payment = rows[0];
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status === 'success') return res.json({ message: 'Payment was already confirmed.', payment });

  try {
    const { rows: updated } = await pool.query(
      `UPDATE payments SET status='success', mpesa_receipt=$1, raw_callback_json=$2, updated_at=now()
       WHERE id=$3 RETURNING *`,
      [code, JSON.stringify({ manualConfirmation: true, enteredCode: code, confirmedAt: new Date().toISOString(), note: 'Flagged for reconciliation against the real M-Pesa statement — not independently verified.' }), payment.id]
    );

    if (payment.purpose === 'subscription') {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      await pool.query(
        `UPDATE subscriptions SET status='active', mpesa_receipt=$1, started_at=$2, expires_at=$3 WHERE id=$4`,
        [code, startedAt, expiresAt, payment.reference_id]
      );
    }

    res.json({ message: 'Payment confirmed manually. This has been flagged for reconciliation.', payment: updated[0] });
  } catch (err) {
    // The partial unique index on payments(mpesa_receipt) WHERE status='success'
    // is what makes a code usable exactly once — this is what fires when
    // someone tries to reuse a code that already unlocked a different payment.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'This M-Pesa code has already been used for a previous payment and cannot be used again.',
        alreadyUsed: true,
      });
    }
    console.error('Manual payment confirmation error:', err);
    res.status(500).json({ error: 'Could not confirm payment. Please try again.' });
  }
});

module.exports = router;
