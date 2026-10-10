const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function redactSearchValue(value) {
  return value.length > 6
    ? value.slice(0, 3) + '***' + value.slice(-3)
    : value.slice(0, 2) + '***';
}

function redactReportValue(type, value) {
  if (type === 'phone') return redactSearchValue(value);
  if (type === 'paybill') return value;
  if (type === 'website') {
    const parts = value.split('.');
    if (parts.length > 2) return `${parts[0]}...${parts[parts.length - 1]}`;
    return value;
  }
  return null; // job / business / other — the caller falls back to the name
}

// Homepage feed: paid-search verdicts + admin-approved community reports.
// Only approved scam_reports ever appear here — pending/rejected ones stay
// in the admin moderation queue.
router.get('/recent-scams', async (req, res) => {
  try {
    const [searches, reports] = await Promise.all([
      pool.query(
        `SELECT query_type, query_value, verdict, created_at
         FROM searches
         WHERE verdict IN ('scam', 'suspicious')
           AND created_at > now() - INTERVAL '14 days'
         ORDER BY created_at DESC
         LIMIT 20`
      ),
      pool.query(
        `SELECT report_type, subject_value, subject_name, description, amount_lost_kes, created_at
         FROM scam_reports
         WHERE status = 'approved'
           AND created_at > now() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT 20`
      ),
    ]);

    const fromSearches = searches.rows.map((r) => ({
      type: r.query_type,
      value: redactSearchValue(r.query_value),
      verdict: r.verdict,
      reported_at: r.created_at,
      source: 'search',
    }));

    const fromReports = reports.rows.map((r) => ({
      type: r.report_type,
      value: redactReportValue(r.report_type, r.subject_value) || (r.subject_name ? r.subject_name.slice(0, 28) : 'Reported'),
      verdict: 'scam',
      reported_at: r.created_at,
      source: 'report',
      name: r.subject_name,
      description: r.description ? r.description.slice(0, 140) : null,
      amountLostKes: r.amount_lost_kes,
    }));

    const merged = fromSearches.concat(fromReports)
      .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
      .slice(0, 20);

    res.json({ scams: merged });
  } catch (err) {
    console.error('recent-scams error:', err);
    res.json({ scams: [] });
  }
});

module.exports = router;
