const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/recent-scams', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT query_type, query_value, verdict, created_at
       FROM searches
       WHERE verdict IN ('scam', 'suspicious')
         AND created_at > now() - INTERVAL '14 days'
       ORDER BY created_at DESC
       LIMIT 20`
    );

    const redacted = rows.map((r) => ({
      type: r.query_type,
      value: r.query_value.length > 6
        ? r.query_value.slice(0, 3) + '***' + r.query_value.slice(-3)
        : r.query_value.slice(0, 2) + '***',
      verdict: r.verdict,
      reported_at: r.created_at,
    }));

    res.json({ scams: redacted });
  } catch (err) {
    console.error('recent-scams error:', err);
    res.json({ scams: [] });
  }
});

module.exports = router;
