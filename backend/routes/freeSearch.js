const express = require('express');
const pool = require('../db/pool');
const searchService = require('../services/searchService');
const { searchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/', searchLimiter, async (req, res) => {
  const { queryType, queryValue, region } = req.body;
  if (!['paybill', 'phone', 'job_offer'].includes(queryType)) {
    return res.status(400).json({ error: 'queryType must be paybill, phone, or job_offer.' });
  }
  if (!queryValue || !queryValue.trim()) {
    return res.status(400).json({ error: 'Enter something to search.' });
  }

  const validRegion = ['kenya', 'international'].includes(region) ? region : 'kenya';

  let userId = 0;

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.sessionId) {
        const { rows } = await pool.query(
          `SELECT user_id FROM sessions WHERE id = $1 AND is_active = true`,
          [payload.sessionId]
        );
        if (rows[0]) userId = rows[0].user_id;
      }
    } catch { }
  }

  if (userId) {
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS cnt FROM searches WHERE user_id = $1`,
      [userId]
    );
    if (countRows[0].cnt > 0) {
      return res.status(403).json({
        error: 'Free search already used. Sign up or log in to continue searching.',
        requiresPayment: true,
      });
    }
  }

  try {
    const { fromCache, result } = await searchService.performSearch({
      userId,
      queryType,
      queryValue: queryValue.trim(),
      tier: 50,
      amountPaid: 0,
      region: validRegion,
    });

    res.json({ fromCache, result, free: true });
  } catch (err) {
    console.error('Free search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

module.exports = router;
