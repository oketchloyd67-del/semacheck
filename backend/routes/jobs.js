// routes/jobs.js
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireJobOwner } = require('../middleware/auth');
const { normalizeKenyanPhone } = require('../utils/validators');

const router = express.Router();

async function activeSubscription(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id=$1 AND status='active' AND expires_at > now()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// Job owner posts a job — held for admin approval, requires active subscription
router.post('/', requireAuth, requireJobOwner, async (req, res) => {
  const sub = await activeSubscription(req.user.id);
  if (!sub) return res.status(402).json({ error: 'An active subscription is required to post jobs. Subscribe for KES 459/30 days.' });

  const { title, companyName, description, contactPhone, location } = req.body;
  if (!title || !companyName || !description) return res.status(400).json({ error: 'Title, company name, and description are required.' });

  const normalizedPhone = contactPhone ? normalizeKenyanPhone(contactPhone) : null;
  const { rows } = await pool.query(
    `INSERT INTO jobs (owner_id, title, company_name, description, contact_phone, location)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.id, title.trim(), companyName.trim(), description.trim(), normalizedPhone, location || null]
  );
  res.status(201).json({ job: rows[0], message: 'Job submitted. It will appear once an admin approves it.' });
});

// Job owner's own postings + status
router.get('/mine', requireAuth, requireJobOwner, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE owner_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ jobs: rows });
});

// Job owner dashboard summary: subscription countdown + job stats
router.get('/dashboard-summary', requireAuth, requireJobOwner, async (req, res) => {
  const sub = await activeSubscription(req.user.id);
  const { rows: counts } = await pool.query(
    `SELECT status, count(*)::int AS n FROM jobs WHERE owner_id=$1 GROUP BY status`,
    [req.user.id]
  );
  const daysRemaining = sub ? Math.max(0, Math.ceil((new Date(sub.expires_at) - new Date()) / 86400000)) : 0;
  res.json({
    subscription: sub ? { status: sub.status, expiresAt: sub.expires_at, daysRemaining } : { status: 'none', daysRemaining: 0 },
    jobCounts: counts,
  });
});

// Publicly approved jobs only (what appears in search / listings)
router.get('/approved', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, company_name, location, created_at FROM jobs WHERE status='approved' ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ jobs: rows });
});

module.exports = router;
