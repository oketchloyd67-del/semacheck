const express = require('express');
const pool = require('../db/pool');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');
const { apiRateLimit, apiRateLimit: widgetRateLimit } = require('../middleware/apiRateLimit');
const { quotaMeter, quotaMeter: widgetQuotaMeter } = require('../middleware/quotaMeter');
const { widgetOrigin } = require('../middleware/widgetOrigin');
const checkService = require('../services/checkService');
const usageService = require('../services/usageService');
const { reportAbuseGuard } = require('../middleware/reportAbuseGuard');
const { submitReport } = require('../services/reportService');

const router = express.Router();

const API_ROOT = '/v1';

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
