
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireJobOwner } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const tuma = require('../services/tuma');
const { normalizeKenyanPhone } = require('../utils/validators');

const router = express.Router();

const SEARCH_TIERS = [50, 100, 150]; 
const SUBSCRIPTION_AMOUNT = 459; 
const FORENSICS_CASE_FEE = 849; 


async function applyPaymentSuccessSideEffects(payment) {
  if (payment.purpose === 'subscription') {
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE subscriptions SET status='active', mpesa_receipt=$1, started_at=$2, expires_at=$3 WHERE id=$4`,
      [payment.mpesa_receipt, startedAt, expiresAt, payment.reference_id]
    );
  }
  if (payment.purpose === 'forensics_case') {
    await pool.query(`UPDATE forensics_cases SET status='submitted', updated_at=now() WHERE id=$1 AND status='awaiting_payment'`, [payment.reference_id]);
  }
  
  
}


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


router.post('/forensics-case', requireAuth, paymentLimiter, async (req, res) => {
  const { caseId, phone } = req.body;
  const normalizedPhone = normalizeKenyanPhone(phone) || normalizeKenyanPhone(req.user.phone);
  if (!normalizedPhone) return res.status(400).json({ error: 'A valid M-Pesa phone number is required.' });
  if (!caseId) return res.status(400).json({ error: 'caseId is required — submit the case intake form first.' });

  const { rows: caseRows } = await pool.query(
    `SELECT * FROM forensics_cases WHERE id=$1 AND user_id=$2`,
    [caseId, req.user.id]
  );
  const caseRow = caseRows[0];
  if (!caseRow) return res.status(404).json({ error: 'Case not found.' });
  if (caseRow.status !== 'awaiting_payment') {
    return res.status(409).json({ error: 'This case has already been paid for.' });
  }

  const { rows: payRows } = await pool.query(
    `INSERT INTO payments (user_id, purpose, reference_id, amount, phone, status)
     VALUES ($1,'forensics_case',$2,$3,$4,'initiated') RETURNING id`,
    [req.user.id, caseId, FORENSICS_CASE_FEE, normalizedPhone]
  );
  const paymentId = payRows[0].id;
  await pool.query(`UPDATE forensics_cases SET fee_payment_id=$1, updated_at=now() WHERE id=$2`, [paymentId, caseId]);

  try {
    const stk = await tuma.stkPush({ phone: normalizedPhone, amount: FORENSICS_CASE_FEE, description: `SemaCheck forensics case #${caseId}` });
    await pool.query(
      `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
      [stk.checkout_request_id, stk.merchant_request_id, paymentId]
    );
    res.json({ paymentId, caseId, checkoutRequestId: stk.checkout_request_id, message: stk.customer_message || 'STK push sent. Enter your M-Pesa PIN to submit your case.' });
  } catch (err) {
    await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
    res.status(502).json({ error: err.message, paymentId });
  }
});





router.post('/tuma/callback', express.json(), async (req, res) => {
  
  
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

    const { rows: updated } = await pool.query(
      `UPDATE payments SET status='success', mpesa_receipt=$1, raw_callback_json=$2, updated_at=now() WHERE id=$3 RETURNING *`,
      [mpesa_receipt_number || null, JSON.stringify(req.body), payment.id]
    );
    await applyPaymentSuccessSideEffects(updated[0]);
  } catch (err) {
    if (err.code === '23505') {
      console.warn(`Tuma callback: receipt already used by another payment — ignored as likely duplicate webhook delivery.`);
      return;
    }
    console.error('Tuma callback processing error:', err);
  }
});



router.get('/status/:paymentId', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, purpose, status, amount, reference_id FROM payments WHERE id=$1 AND user_id=$2', [req.params.paymentId, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Payment not found.' });
  res.json(rows[0]);
});

module.exports = router;
module.exports.applyPaymentSuccessSideEffects = applyPaymentSuccessSideEffects;
