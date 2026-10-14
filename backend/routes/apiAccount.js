const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const tuma = require('../services/tuma');
const { normalizeKenyanPhone } = require('../utils/validators');
const { createKey, revokeKey, listKeys } = require('../services/apiKeyService');
const { encrypt, decrypt } = require('../services/cryptoService');
const { changePlan } = require('../services/billingService');
const { getMonthUsage } = require('../services/usageService');
const checkService = require('../services/checkService');

const router = express.Router();

// Requires verified email.
async function ensureVerified(req, res, next) {
  const { rows } = await pool.query('SELECT email_verified FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0] || !rows[0].email_verified) {
    return res.status(403).json({ error: 'Verify your email (OTP) before using API features.' });
  }
  next();
}

// Attach the caller's API account (if any) to the request.
async function loadApiAccount(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.user_id, a.company_name, a.website, a.use_case, a.status, a.plan_id,
              a.webhook_url, a.plan_renews_on,
              p.code AS plan_code, p.name AS plan_name, p.monthly_price_kes, p.monthly_quota,
              p.rate_limit_per_min, p.webhooks_enabled, p.batch_enabled
       FROM api_accounts a JOIN api_plans p ON p.id = a.plan_id
       WHERE a.user_id = $1`,
      [req.user.id]
    );
    req.apiAccount = rows[0] ? {
      id: rows[0].id,
      userId: rows[0].user_id,
      companyName: rows[0].company_name,
      website: rows[0].website,
      status: rows[0].status,
      planId: rows[0].plan_id,
      planCode: rows[0].plan_code,
      planName: rows[0].plan_name,
      planPriceKes: rows[0].monthly_price_kes,
      monthlyQuota: rows[0].monthly_quota,
      rateLimitPerMin: rows[0].rate_limit_per_min,
      webhooksEnabled: rows[0].webhooks_enabled,
      batchEnabled: rows[0].batch_enabled,
      webhookUrl: rows[0].webhook_url,
      planRenewsOn: rows[0].plan_renews_on,
    } : null;
    next();
  } catch (err) {
    console.error('loadApiAccount failed:', err);
    res.status(500).json({ error: 'Could not load your API account.' });
  }
}

function requireAccount(req, res, next) {
  if (!req.apiAccount) {
    return res.status(404).json({ error: 'No API account yet. Create one to get started.' });
  }
  next();
}

// POST /api/account/api/signup — self-serve API account.
// Requires a registered, OTP-verified account. New API accounts wait for
// admin approval before their keys start authenticating.
router.post('/signup', requireAuth, ensureVerified, async (req, res) => {
  const { companyName, website, useCase } = req.body;
  if (!companyName || companyName.trim().length < 2) {
    return res.status(400).json({ error: 'Enter your company name.' });
  }
  if (website && !/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?\.[a-z]{2,}$/iu.test(String(website).trim().replace(/^https?:\/\//, ''))) {
    return res.status(400).json({ error: 'Enter a valid website (e.g. company.com).' });
  }

  const existing = await pool.query('SELECT id, status FROM api_accounts WHERE user_id=$1', [req.user.id]);
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'You already have an API account. Check your dashboard.' });
  }

  const planId = 1; // free plan
  const { rows: account } = await pool.query(
    `INSERT INTO api_accounts (user_id, company_name, website, use_case, plan_id, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id, company_name, website, use_case, plan_id, status, created_at`,
    [req.user.id, companyName.trim(), website || null, useCase || null, planId]
  );

  res.status(201).json({
    account: {
      id: account[0].id,
      companyName: account[0].company_name,
      status: account[0].status,
      plan: 'Free',
      planCode: 'free',
      created: account[0].created_at,
    },
    message: 'API account created. It is now waiting for admin approval — you can create your keys in the meantime.',
  });
});

// GET /api/account/api/overview
router.get('/overview', requireAuth, ensureVerified, loadApiAccount, async (req, res) => {
  if (!req.apiAccount) return res.json({ account: null });

  const usage = await getMonthUsage(req.apiAccount.id);
  res.json({ account: req.apiAccount, usage, plan: req.apiAccount.planCode });
});

// GET /api/account/api/keys
router.get('/keys', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  const keys = await listKeys(Number(req.apiAccount.id));
  res.json({ keys });
});

// POST /api/account/api/keys
router.post('/keys', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  try {
    const { label, type, allowedDomains } = req.body;
    const key = await createKey(Number(req.apiAccount.id), type || 'secret', label || 'Main key', allowedDomains || []);
    res.status(201).json({ key: { raw: key.raw, prefix: key.key_prefix, type: key.key_type, status: key.status } });
  } catch (err) {
    // Never surface raw configuration errors (e.g. a missing env var) to
    // clients — log the detail server-side and return a generic message.
    if (err && /not configured/i.test(err.message || '')) {
      console.error('[api-keys] create failed:', err.message);
      return res.status(503).json({ error: 'Key service temporarily unavailable. Please try again later.' });
    }
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/account/api/keys/:keyId
router.delete('/keys/:keyId', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  try {
    const key = await revokeKey(Number(req.apiAccount.id), Number(req.params.keyId));
    res.json({ key, message: 'Key revoked.' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// PUT /api/account/api/webhook
router.put('/webhook', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  const { url, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'Enter a webhook URL.' });
  if (secret && secret.length > 300) return res.status(400).json({ error: 'Secret too long.' });
  // SSRF guard: a webhook URL must never point at a private, loopback or
  // cloud-metadata address. Checked again right before each delivery.
  const { checkWebhookUrl } = require('../services/ssrfGuard');
  const urlCheck = await checkWebhookUrl(String(url));
  if (!urlCheck.ok) {
    const messages = {
      invalid_url: 'Enter a valid URL.',
      https_required: 'Webhook URL must start with https://.',
      credentials_in_url: 'Remove the username/password from the URL.',
      port_not_allowed: 'Only the standard https port (443) is allowed.',
      host_not_allowed: 'That host is not allowed.',
      private_address: 'That address is not allowed (private or internal network).',
      dns_failed: 'Could not resolve that hostname.',
    };
    return res.status(400).json({ error: messages[urlCheck.reason] || 'That webhook URL is not allowed.' });
  }
  const encryptedSecret = secret ? encrypt(secret) : null;
  const { rows } = await pool.query(
    `UPDATE api_accounts SET webhook_url=$2, webhook_secret_enc=$3 WHERE id=$1 RETURNING id, webhook_url`,
    [Number(req.apiAccount.id), url, encryptedSecret]
  );
  res.json({ account: rows[0] });
});

// POST /api/account/api/webhook/test
router.post('/webhook/test', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT webhook_secret_enc, webhook_url FROM api_accounts WHERE id=$1`,
    [Number(req.apiAccount.id)]
  );
  const secret = await decrypt(rows[0]?.webhook_secret_enc || '');
  if (!secret) return res.status(503).json({ error: 'Webhook secret not set.' });
  const payload = JSON.stringify({ event: 'webhook.test', created_at: new Date().toISOString(), data: { test: true, plan: req.apiAccount.planName } });
  const signature = require('../services/webhookService').sign(secret, String(Math.floor(Date.now() / 1000)), payload);
  res.json({ signature, url: rows[0].webhook_url, payload });
});

// GET /api/account/api/deliveries
router.get('/deliveries', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, event, status, attempts, next_attempt_at, last_response_code, created_at FROM webhook_deliveries
     WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [Number(req.apiAccount.id)]
  );
  res.json({ deliveries: rows });
});

// GET /api/account/api/invoices
router.get('/invoices', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, plan_id, period, amount_kes, status, due_on, paid_at, payment_id FROM api_invoices
     WHERE account_id=$1 ORDER BY created_at DESC`,
    [Number(req.apiAccount.id)]
  );
  res.json({ invoices: rows });
});

// POST /api/account/api/plan — buy/switch a plan.
// Free plan switches immediately. Paid plans take an M-Pesa STK push; the
// plan goes live when the payment callback confirms it.
router.post('/plan', requireAuth, ensureVerified, loadApiAccount, requireAccount, paymentLimiter, async (req, res) => {
  try {
    const { planCode, phone } = req.body;
    const { rows: planRows } = await pool.query(
      `SELECT id, code, name, monthly_price_kes, monthly_quota FROM api_plans WHERE code=$1 AND is_active=TRUE`,
      [String(planCode || '')]
    );
    if (!planRows[0]) return res.status(400).json({ error: 'Plan not found or inactive.' });
    const plan = planRows[0];

    if (!plan.monthly_price_kes) {
      const freePlan = await changePlan(Number(req.apiAccount.id), plan.code);
      return res.json({
        account: req.apiAccount,
        plan: { id: freePlan.id, code: freePlan.code, name: freePlan.name, price: freePlan.monthly_price_kes, quota: freePlan.monthly_quota },
        message: 'Plan updated.',
      });
    }

    // Paid plan: collect the month's fee via M-Pesa first.
    const normalizedPhone = normalizeKenyanPhone(phone) || normalizeKenyanPhone(req.user.phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'A valid M-Pesa phone number is required.' });
    }

    const period = String(new Date().toISOString().slice(0, 7));
    const dueOn = new Date().toISOString().slice(0, 10);
    const { rows: invRows } = await pool.query(
      `INSERT INTO api_invoices (account_id, plan_id, period, amount_kes, status, due_on)
       VALUES ($1,$2,$3,$4,'unpaid',$5)
       ON CONFLICT (account_id, period) DO UPDATE SET plan_id=EXCLUDED.plan_id, amount_kes=EXCLUDED.amount_kes
       RETURNING id`,
      [Number(req.apiAccount.id), plan.id, period, plan.monthly_price_kes, dueOn]
    );
    const invoiceId = invRows[0].id;

    const { rows: payRows } = await pool.query(
      `INSERT INTO payments (user_id, purpose, reference_id, api_invoice_id, amount, phone, status)
       VALUES ($1,'api_invoice',NULL,$2,$3,$4,'initiated') RETURNING id`,
      [req.user.id, invoiceId, plan.monthly_price_kes, normalizedPhone]
    );
    const paymentId = payRows[0].id;

    try {
      const stk = await tuma.stkPush({
        phone: normalizedPhone,
        amount: plan.monthly_price_kes,
        description: `SemaCheck API ${plan.name} plan #${invoiceId}`,
      });
      await pool.query(
        `UPDATE payments SET status='pending', tuma_checkout_request_id=$1, tuma_merchant_request_id=$2, updated_at=now() WHERE id=$3`,
        [stk.checkout_request_id, stk.merchant_request_id, paymentId]
      );
      res.json({
        paymentId,
        invoiceId,
        plan: { id: plan.id, code: plan.code, name: plan.name, price: plan.monthly_price_kes, quota: plan.monthly_quota },
        message: stk.customer_message || 'STK push sent. Enter your M-Pesa PIN to activate your plan.',
      });
    } catch (err) {
      console.error('STK push failed:', err.response ? JSON.stringify(err.response.data) : err.message);
      await pool.query(`UPDATE payments SET status='failed', updated_at=now() WHERE id=$1`, [paymentId]);
      res.status(502).json({ error: err.message, paymentId });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/account/api/playground — run a check and show the verdict.
router.post('/playground', requireAuth, ensureVerified, loadApiAccount, requireAccount, async (req, res) => {
  try {
    const { checkType, subject } = req.body;
    if (!checkType || !subject) return res.status(400).json({ error: 'checkType and subject are required.' });
    const result = await checkService.run({ userId: req.apiAccount.userId, checkType, rawValue: subject });
    const r = result.result || {};
    res.json({
      cached: result.cached,
      verdict: r.verdict,
      confidence: r.confidence,
      displayVerdict: r.displayVerdict,
      reasons: r.reasons,
      summary: r.summary,
      subject: r.query_value,
      plan: req.apiAccount.planName,
    });
  } catch (err) {
    console.error('playground failed:', err);
    res.status(500).json({ error: 'Check failed. Please try again.' });
  }
});

module.exports = router;
