const pool = require('../db/pool');

function quotaMeter(req, res, next) {
  const accountId = Number(req.apiAccount && req.apiAccount.id);
  if (!accountId) return next();

  const period = String(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const limit = Number(req.apiAccount.monthlyQuota);

  pool.query(
    `INSERT INTO api_usage_monthly (account_id, period, checks_used)
     VALUES ($1, $2, 1)
     ON CONFLICT (account_id, period) DO UPDATE SET checks_used = api_usage_monthly.checks_used + 1
     RETURNING checks_used`,
    [accountId, period]
  )
    .then(({ rows }) => {
      const used = Number(rows[0].checks_used);
      res.setHeader('X-Quota-Limit', String(limit));
      res.setHeader('X-Quota-Remaining', String(Math.max(0, limit - used)));

      if (used > limit) {
        return res.status(429).json({ error: 'quota_exceeded', quotaLimit: limit, checksUsed: used });
      }
      next();
    })
    .catch((err) => {
      console.error('quotaMeter failed:', err.message);
      next(); // do not block the request if quota tracking is unavailable
    });
}

module.exports = { quotaMeter };
