// routes/search.js
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const searchService = require('../services/searchService');

const router = express.Router();

/**
 * A search is only unlocked after a successful payment. The frontend:
 *   1. POST /api/payments/search {tier, phone} -> gets paymentId, triggers STK push
 *   2. Polls GET /api/payments/status/:paymentId until status === 'success'
 *   3. POST /api/search {paymentId, queryType, queryValue} here to run/unlock it
 * If the same query is already cached (dedup), no new external lookup is
 * made even though the user still pays for their own unlock/tier — this
 * keeps the platform fast and avoids re-scraping the same number twice.
 */
router.post('/', requireAuth, searchLimiter, async (req, res) => {
  const { paymentId, queryType, queryValue } = req.body;
  if (!['paybill', 'phone', 'job_offer'].includes(queryType)) {
    return res.status(400).json({ error: 'queryType must be paybill, phone, or job_offer.' });
  }
  if (!queryValue || !queryValue.trim()) return res.status(400).json({ error: 'Enter something to search.' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND purpose='search'`,
      [paymentId, req.user.id]
    );
    const payment = rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.status !== 'success') return res.status(402).json({ error: 'Payment not yet confirmed.', status: payment.status });

    const { fromCache, result } = await searchService.performSearch({
      userId: req.user.id,
      queryType,
      queryValue: queryValue.trim(),
      tier: Number(payment.amount),
      amountPaid: Number(payment.amount),
    });

    res.json({ fromCache, result });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// A user's own search history (their unlocked results only)
router.get('/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, query_type, query_value, verdict, confidence_score, created_at
     FROM searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ history: rows });
});

module.exports = router;
