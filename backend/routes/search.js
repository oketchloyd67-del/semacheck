const express = require('express');
const pool = require('../db/pool');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const searchService = require('../services/searchService');
const { notifySearchResults } = require('../services/pushNotificationService');

const router = express.Router();

// Regular users can search without an account: the payment row identifies
// the request. Logged-in users keep their history + push notifications.
router.post('/', optionalAuth, searchLimiter, async (req, res) => {
  const { paymentId, queryType, queryValue, region } = req.body;
  if (!['paybill', 'phone', 'job_offer', 'website'].includes(queryType)) {
    return res.status(400).json({ error: 'queryType must be paybill, phone, job_offer, or website.' });
  }
  if (!queryValue || !queryValue.trim()) return res.status(400).json({ error: 'Enter something to search.' });
  if (queryValue.trim().length > 2000) return res.status(400).json({ error: 'Search query too long (max 2000 characters).' });

  const validRegion = ['kenya', 'international'].includes(region) ? region : 'kenya';

  let subjectValue = queryValue.trim();
  if (queryType === 'website') {
    try {
      const normalize = require('../services/normalizeService');
      subjectValue = normalize.normalizeSubject('website', subjectValue).value;
    } catch (err) {
      const phrase = subjectValue.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s{2,}/g, ' ').trim();
      if (phrase.length < 3 || phrase.length > 160) {
        return res.status(400).json({ error: err.message || 'Enter a valid website, e.g. example.com.' });
      }
      subjectValue = phrase;
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE id=$1 AND purpose='search'`,
      [paymentId]
    );
    const payment = rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.user_id && (!req.user || String(req.user.id) !== String(payment.user_id))) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    if (payment.status !== 'success') return res.status(402).json({ error: 'Payment not yet confirmed.', status: payment.status });

    const ownerId = payment.user_id || null;

    const { fromCache, result } = await searchService.performSearch({
      userId: ownerId,
      queryType,
      queryValue: subjectValue,
      tier: Number(payment.amount),
      amountPaid: Number(payment.amount),
      region: validRegion,
    });

    res.json({ fromCache, result });

    if (ownerId) notifySearchResults(ownerId, queryType, subjectValue, result.verdict).catch(() => {});
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, query_type, query_value, region, verdict, confidence_score, created_at
     FROM searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ history: rows });
});

module.exports = router;
