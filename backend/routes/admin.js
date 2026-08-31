





const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/adminAuth');
const { authLimiter } = require('../middleware/rateLimiter');
const { UPLOAD_DIR } = require('../middleware/upload');
const { registryStatus, refreshCbkRegistry } = require('../services/cbkRegistryService');
const internationalDb = require('../services/internationalScamDatabases');

const router = express.Router();

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM admins WHERE email=$1', [String(email || '').trim().toLowerCase()]);
    const admin = rows[0];
    const dummyHash = '$2a$12$C6UzMDM.H6dfI/f/IKcEeOoJ6/Q3s4v9K1S8kX6qzxKvZ3z6z6z6a';
    const ok = await bcrypt.compare(password || '', admin ? admin.password_hash : dummyHash);
    if (!admin || !ok) return res.status(401).json({ error: 'Incorrect credentials.' });

    const token = jwt.sign({ type: 'admin', adminId: admin.id }, process.env.ADMIN_JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, admin: { id: admin.id, fullName: admin.full_name, email: admin.email } });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.get('/jobs/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.*, u.business_name, u.business_reg_number, u.kra_pin, u.email AS owner_email
     FROM jobs j JOIN users u ON u.id = j.owner_id
     WHERE j.status='pending' ORDER BY j.created_at ASC`
  );
  res.json({ jobs: rows });
});


router.get('/jobs', requireAdmin, async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT j.*, u.business_name, u.business_reg_number, u.kra_pin, u.email AS owner_email
     FROM jobs j JOIN users u ON u.id = j.owner_id
     WHERE j.status=$1 ORDER BY j.created_at DESC`,
    [status]
  );
  res.json({ jobs: rows });
});

router.post('/jobs/:id/approve', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE jobs SET status='approved', reviewed_by=$1, reviewed_at=now() WHERE id=$2 RETURNING *`,
    [req.admin.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: rows[0] });
});

router.post('/jobs/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE jobs SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
    [req.admin.id, reason || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: rows[0] });
});

router.get('/revenue', requireAdmin, async (req, res) => {
  try {
    const [total, byPurpose, last7, last30, recent] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success'`),
      pool.query(`SELECT purpose, COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' GROUP BY purpose ORDER BY total DESC`),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' AND created_at > now() - INTERVAL '7 days'`),
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' AND created_at > now() - INTERVAL '30 days'`),
      pool.query(`SELECT p.id, p.purpose, p.amount, p.phone, p.mpesa_receipt, p.status, p.created_at, u.full_name, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 50`),
    ]);
    res.json({
      totalRevenue: Number(total.rows[0].total),
      totalTransactions: total.rows[0].count,
      byPurpose: byPurpose.rows.map((r) => ({ purpose: r.purpose, total: Number(r.total), count: r.count })),
      last7Days: { total: Number(last7.rows[0].total), count: last7.rows[0].count },
      last30Days: { total: Number(last30.rows[0].total), count: last30.rows[0].count },
      recentPayments: recent.rows,
    });
  } catch (err) {
    console.error('Revenue query error:', err);
    res.status(500).json({ error: 'Failed to load revenue data.' });
  }
});

router.get('/stats', requireAdmin, async (req, res) => {
  const [users, searches, jobsPending, subsActive, contactUnread, idPending, forensicsSubmitted] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM users'),
    pool.query('SELECT count(*)::int AS n FROM searches'),
    pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status='pending'`),
    pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status='active' AND expires_at > now()`),
    pool.query(`SELECT count(*)::int AS n FROM contact_messages WHERE emailed_ok = FALSE`),
    pool.query(`SELECT count(*)::int AS n FROM users WHERE account_type='job_owner' AND id_verification_status='pending'`),
    pool.query(`SELECT count(*)::int AS n FROM forensics_cases WHERE status='submitted'`),
  ]);
  res.json({
    totalUsers: users.rows[0].n,
    totalSearches: searches.rows[0].n,
    pendingJobs: jobsPending.rows[0].n,
    activeSubscriptions: subsActive.rows[0].n,
    contactMessagesNeedingAttention: contactUnread.rows[0].n,
    idVerificationsPending: idPending.rows[0].n,
    forensicsCasesAwaitingReview: forensicsSubmitted.rows[0].n,
  });
});





router.get('/users', requireAdmin, async (req, res) => {
  const { accountType, verificationStatus, q } = req.query;
  const conditions = [];
  const params = [];

  if (accountType && ['regular', 'job_owner'].includes(accountType)) {
    params.push(accountType);
    conditions.push(`account_type = $${params.length}`);
  }
  if (verificationStatus && ['pending', 'approved', 'rejected'].includes(verificationStatus)) {
    params.push(verificationStatus);
    conditions.push(`id_verification_status = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length} OR national_id ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_verification_status,
            business_name, business_reg_number, kra_pin, created_at
     FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  res.json({ users: rows });
});

router.get('/users/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_verification_status,
            id_verification_notes, business_name, business_reg_number, kra_pin, created_at
     FROM users WHERE id=$1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

  const [subs, searches, jobs] = await Promise.all([
    pool.query(`SELECT status, expires_at FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]),
    pool.query(`SELECT count(*)::int AS n FROM searches WHERE user_id=$1`, [req.params.id]),
    pool.query(`SELECT count(*)::int AS n FROM jobs WHERE owner_id=$1`, [req.params.id]),
  ]);

  res.json({
    user: rows[0],
    subscription: subs.rows[0] || null,
    searchCount: searches.rows[0].n,
    jobCount: jobs.rows[0].n,
  });
});








router.get('/id-verifications', requireAdmin, async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_document_filename, id_verification_status, id_verification_notes, business_name, business_reg_number, kra_pin, created_at
     FROM users WHERE account_type='job_owner' AND id_verification_status=$1 ORDER BY created_at ASC`,
    [status]
  );
  res.json({ users: rows });
});


router.get('/id-verifications/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_document_filename, business_name, business_reg_number, kra_pin, created_at
     FROM users WHERE account_type='job_owner' AND id_verification_status='pending' ORDER BY created_at ASC`
  );
  res.json({ users: rows });
});



router.get('/id-verifications/:userId/document', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id_document_filename FROM users WHERE id=$1', [req.params.userId]);
  const filename = rows[0]?.id_document_filename;
  if (!filename) return res.status(404).json({ error: 'No document on file for this user.' });

  const filePath = path.join(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  res.sendFile(filePath);
});

router.post('/id-verifications/:userId/approve', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET id_verification_status='approved', id_verification_reviewed_by=$1, id_verification_reviewed_at=now(), id_verification_notes=NULL
     WHERE id=$2 RETURNING id, full_name, id_verification_status`,
    [req.admin.id, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: rows[0] });
});

router.post('/id-verifications/:userId/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE users SET id_verification_status='rejected', id_verification_reviewed_by=$1, id_verification_reviewed_at=now(), id_verification_notes=$2
     WHERE id=$3 RETURNING id, full_name, id_verification_status`,
    [req.admin.id, reason || null, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: rows[0] });
});

router.get('/contact-messages', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100');
  res.json({ messages: rows });
});


router.get('/settings/me', requireAdmin, async (req, res) => {
  res.json({ admin: { id: req.admin.id, fullName: req.admin.full_name, email: req.admin.email } });
});

router.post('/settings/credentials', requireAdmin, authLimiter, async (req, res) => {
  const { currentPassword, newEmail, newPassword, newFullName } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM admins WHERE id=$1', [req.admin.id]);
    const admin = rows[0];
    const ok = await bcrypt.compare(currentPassword || '', admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

    const updates = [];
    const params = [];

    if (newFullName && newFullName.trim()) {
      params.push(newFullName.trim());
      updates.push(`full_name = $${params.length}`);
    }
    if (newEmail && newEmail.trim()) {
      const email = newEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      const dupe = await pool.query('SELECT 1 FROM admins WHERE email=$1 AND id<>$2', [email, req.admin.id]);
      if (dupe.rows[0]) return res.status(409).json({ error: 'Another admin already uses that email.' });
      params.push(email);
      updates.push(`email = $${params.length}`);
    }
    if (newPassword) {
      if (newPassword.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
      const newHash = await bcrypt.hash(newPassword, 12);
      params.push(newHash);
      updates.push(`password_hash = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(req.admin.id);
    const { rows: updated } = await pool.query(
      `UPDATE admins SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING id, full_name, email`,
      params
    );
    res.json({ admin: updated[0], message: 'Credentials updated.' });
  } catch (err) {
    console.error('Admin credentials update error:', err);
    res.status(500).json({ error: 'Could not update credentials.' });
  }
});





router.get('/forensics-cases', requireAdmin, async (req, res) => {
  const validStatuses = ['awaiting_payment', 'submitted', 'under_review', 'in_progress', 'resolved', 'closed'];
  const status = validStatuses.includes(req.query.status) ? req.query.status : 'submitted';
  const { rows } = await pool.query(
    `SELECT fc.id, fc.amount_lost, fc.scam_description, fc.evidence_notes, fc.contact_phone, fc.status,
            fc.admin_notes, fc.created_at, fc.updated_at,
            u.full_name, u.email, u.phone
     FROM forensics_cases fc JOIN users u ON u.id = fc.user_id
     WHERE fc.status=$1 ORDER BY fc.created_at ASC`,
    [status]
  );
  res.json({ cases: rows });
});

router.post('/forensics-cases/:caseId/status', requireAdmin, async (req, res) => {
  const validStatuses = ['under_review', 'in_progress', 'resolved', 'closed'];
  const { status, note } = req.body;
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${validStatuses.join(', ')}` });
  }
  const { rows } = await pool.query(
    `UPDATE forensics_cases SET status=$1, admin_notes=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
     WHERE id=$4 RETURNING id, status`,
    [status, note || null, req.admin.id, req.params.caseId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Case not found.' });
  res.json({ case: rows[0] });
});


router.get('/kenya-registry/status', requireAdmin, async (req, res) => {
  const status = await registryStatus();
  res.json({
    entryCount: status.n,
    lastFetched: status.last_fetched,
    sourceUrl: status.source_url,
    configuredUrl: process.env.CBK_DCP_DIRECTORY_URL || null,
  });
});

router.post('/kenya-registry/refresh', requireAdmin, async (req, res) => {
  try {
    const result = await refreshCbkRegistry();
    res.json({ message: `Refreshed — ${result.count} licensed entities cached.`, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});


router.get('/international-databases/status', requireAdmin, async (req, res) => {
  try {
    const status = await internationalDb.internationalLookupStatus();
    res.json({ totalLookups: status.total, matchedScams: status.matched, lastChecked: status.last_checked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/international-databases/lookup', requireAdmin, async (req, res) => {
  const { queryValue, queryType } = req.body;
  if (!queryValue || !queryValue.trim()) return res.status(400).json({ error: 'queryValue is required.' });
  try {
    const result = await internationalDb.lookupAllInternationalDatabases(queryValue.trim(), queryType || 'phone');
    await internationalDb.cacheInternationalLookup(queryType || 'phone', queryValue.trim(), result);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
