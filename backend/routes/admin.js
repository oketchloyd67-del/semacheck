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
    pool.query(`SELECT count(*)::int AS n FROM users WHERE id_verification_status='pending'`),
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

// ---- ID verification review (replaces any automatic name/ID matching) ----

router.get('/id-verifications/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_document_filename, created_at
     FROM users WHERE id_verification_status='pending' ORDER BY created_at ASC`
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

module.exports = router;
