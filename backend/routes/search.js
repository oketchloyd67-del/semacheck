const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const searchService = require('../services/searchService');

const router = express.Router();

router.post('/', requireAuth, searchLimiter, async (req, res) => {
  const { paymentId, queryType, queryValue, region } = req.body;
  if (!['paybill', 'phone', 'job_offer'].includes(queryType)) {
    return res.status(400).json({ error: 'queryType must be paybill, phone, or job_offer.' });
  }
  if (!queryValue || !queryValue.trim()) return res.status(400).json({ error: 'Enter something to search.' });
  if (queryValue.trim().length > 2000) return res.status(400).json({ error: 'Search query too long (max 2000 characters).' });

  const validRegion = ['kenya', 'international'].includes(region) ? region : 'kenya';

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
      region: validRegion,
    });

    res.json({ fromCache, result });
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
