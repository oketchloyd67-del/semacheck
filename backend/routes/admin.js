// routes/admin.js
// Mounted at /api/admin — nothing on the public site links here.
// The admin login page (admin/login.html) is a separate, unlinked
// static page; treat its URL as a shared secret in addition to the
// credential check (put it behind an obscure path or basic-auth at
// the reverse-proxy layer in production — see README).
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/adminAuth');
const { authLimiter } = require('../middleware/rateLimiter');
const { UPLOAD_DIR } = require('../middleware/upload');

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

// ?status=pending|approved|rejected — full listing for the Jobs tab
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

router.get('/stats', requireAdmin, async (req, res) => {
  const [users, searches, jobsPending, subsActive, contactUnread, idPending] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM users'),
    pool.query('SELECT count(*)::int AS n FROM searches'),
    pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status='pending'`),
    pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status='active' AND expires_at > now()`),
    pool.query(`SELECT count(*)::int AS n FROM contact_messages WHERE emailed_ok = FALSE`),
    pool.query(`SELECT count(*)::int AS n FROM users WHERE account_type='job_owner' AND id_verification_status='pending'`),
  ]);
  res.json({
    totalUsers: users.rows[0].n,
    totalSearches: searches.rows[0].n,
    pendingJobs: jobsPending.rows[0].n,
    activeSubscriptions: subsActive.rows[0].n,
    contactMessagesNeedingAttention: contactUnread.rows[0].n,
    idVerificationsPending: idPending.rows[0].n,
  });
});

// ---- Full accounts list — every user who has ever signed up ----
// This is what was missing before: there was no way to simply browse
// every registered account. Supports optional filters so the list
// stays usable once you have real volume.
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

// ---- ID verification review (replaces any automatic name/ID matching) ----
// Job owners only — their approval gates whether their job postings can go
// live. Regular users are pre-approved at signup and never appear here
// (see routes/auth.js /signup); the account_type filter below is a
// defensive second layer so this stays true even if that ever changes.
// ?status=pending|approved|rejected — defaults to pending for the queue view

router.get('/id-verifications', requireAdmin, async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_document_filename, id_verification_status, id_verification_notes, business_name, business_reg_number, kra_pin, created_at
     FROM users WHERE account_type='job_owner' AND id_verification_status=$1 ORDER BY created_at ASC`,
    [status]
  );
  res.json({ users: rows });
});

// kept for backwards compatibility with the previous endpoint name
router.get('/id-verifications/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_document_filename, business_name, business_reg_number, kra_pin, created_at
     FROM users WHERE account_type='job_owner' AND id_verification_status='pending' ORDER BY created_at ASC`
  );
  res.json({ users: rows });
});

// Streams the uploaded ID photo/PDF to an authenticated admin only —
// never exposed as a public static URL (see middleware/upload.js).
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

// ---- settings: change the logged-in admin's own credentials ----
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

module.exports = router;
