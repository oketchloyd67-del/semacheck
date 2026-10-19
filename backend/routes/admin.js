





const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAdmin, requireRole } = require('../middleware/adminAuth');
const { authLimiter } = require('../middleware/rateLimiter');
const totp = require('../services/totp');
const audit = require('../services/adminAudit');
const tuma = require('../services/tuma');
const { interpretTumaStatus } = require('../services/paymentReconcile');
const { applyPaymentSuccessSideEffects } = require('./payments');
const { UPLOAD_DIR } = require('../middleware/upload');
const { saveAdminSubscription, removeSubscription, broadcastToUsers, sendToAdmins } = require('../services/pushNotificationService');
const reportService = require('../services/reportService');
const checkService = require('../services/checkService');
const webhookService = require('../services/webhookService');
const billingService = require('../services/billingService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(paramName) {
  return (req, res, next) => {
    if (!UUID_RE.test(req.params[paramName] || '')) {
      return res.status(400).json({ error: 'Invalid ID format.' });
    }
    next();
  };
}
// Serial (integer) primary keys: scam_reports, report_disputes, api_accounts.
function requireInt(paramName) {
  return (req, res, next) => {
    if (!/^\d+$/.test(req.params[paramName] || '')) {
      return res.status(400).json({ error: 'Invalid ID format.' });
    }
    next();
  };
}
const { registryStatus, refreshCbkRegistry } = require('../services/cbkRegistryService');
const internationalDb = require('../services/internationalScamDatabases');
const statusHistory = require('../services/statusHistory');

const router = express.Router();

// Admin responses carry personal data and must never be cached by a browser or
// an intermediary. (CHK: short, non-cacheable sessions.)
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const ADMIN_SESSION = '4h';
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeOoJ6/Q3s4v9K1S8kX6qzxKvZ3z6z6z6a';

function adminSummary(admin) {
  return {
    id: admin.id,
    fullName: admin.full_name,
    email: admin.email,
    role: admin.role || 'super_admin',
    twoFactorEnabled: Boolean(admin.totp_enabled),
  };
}

function issueAdminToken(admin) {
  return jwt.sign(
    { type: 'admin', adminId: admin.id, sv: admin.session_version, role: admin.role || 'super_admin' },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_SESSION }
  );
}

async function finishAdminLogin(req, res, admin, via) {
  const { rows } = await pool.query(
    'UPDATE admins SET last_login_at = now() WHERE id = $1 RETURNING id, full_name, email, role, totp_enabled, session_version',
    [admin.id]
  );
  req.admin = { id: admin.id, email: admin.email };
  await audit.logAdminAction(req, 'admin.login', { targetType: 'admin', targetId: admin.id, detail: { via } });
  res.json({ token: issueAdminToken(rows[0]), admin: adminSummary(rows[0]) });
}

router.post('/login', authLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  try {
    const { rows } = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
    const admin = rows[0];
    const ok = await bcrypt.compare(password || '', admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !ok) {
      await audit.logLoginAttempt(req, { email, ok: false, reason: admin ? 'bad_password' : 'unknown_email' });
      return res.status(401).json({ error: 'Incorrect credentials.' });
    }

    // Two-factor is mandatory. First sign-in after rotation enrols an
    // authenticator app; every later sign-in needs its 6-digit code.
    if (!admin.totp_enabled) {
      let secret = admin.totp_secret;
      if (!secret) {
        secret = totp.generateSecret();
        await pool.query('UPDATE admins SET totp_secret=$1 WHERE id=$2', [secret, admin.id]);
      }
      const setupToken = jwt.sign(
        { type: 'admin_2fa_setup', adminId: admin.id },
        process.env.ADMIN_JWT_SECRET,
        { expiresIn: '10m' }
      );
      await audit.logLoginAttempt(req, { email, ok: true, reason: '2fa_setup_required' });
      return res.json({
        twoFactorSetupRequired: true,
        setupToken,
        secret,
        otpauthUrl: totp.otpauthUrl(secret, admin.email),
        message: 'Set up two-factor authentication: add the account to your authenticator app, then enter the 6-digit code.',
      });
    }

    const challengeToken = jwt.sign(
      { type: 'admin_2fa', adminId: admin.id },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '10m' }
    );
    await audit.logLoginAttempt(req, { email, ok: true, reason: '2fa_challenge_issued' });
    res.json({
      twoFactorRequired: true,
      challengeToken,
      message: 'Enter the 6-digit code from your authenticator app.',
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

function verifyShortToken(token, type) {
  const payload = jwt.verify(String(token || ''), process.env.ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.type !== type || !payload.adminId) throw new Error('wrong token');
  return payload;
}

// POST /api/admin/2fa/enable — finish first-time enrolment after password check.
router.post('/2fa/enable', authLimiter, async (req, res) => {
  try {
    const payload = verifyShortToken(req.body && req.body.setupToken, 'admin_2fa_setup');
    const { rows } = await pool.query('SELECT * FROM admins WHERE id=$1', [payload.adminId]);
    const admin = rows[0];
    if (!admin || !admin.totp_secret) return res.status(401).json({ error: 'Two-factor setup expired. Sign in again.' });
    if (!totp.verify(admin.totp_secret, req.body && req.body.code)) {
      await audit.logLoginAttempt(req, { email: admin.email, ok: false, reason: 'bad_2fa_enrolment_code' });
      return res.status(401).json({ error: 'That code is wrong or expired. Check your authenticator app and try again.' });
    }
    const { rows: updated } = await pool.query(
      `UPDATE admins SET totp_enabled=TRUE, totp_enrolled_at=COALESCE(totp_enrolled_at, now())
       WHERE id=$1 RETURNING id, full_name, email, role, totp_enabled, session_version`,
      [admin.id]
    );
    req.admin = { id: admin.id, email: admin.email };
    await audit.logAdminAction(req, 'admin.2fa_enrolled', { targetType: 'admin', targetId: admin.id });
    await finishAdminLogin(req, res, updated[0], 'password+2fa_enrolment');
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Two-factor setup expired. Sign in again.' });
    }
    console.error('2FA enrolment error:', err);
    res.status(500).json({ error: 'Could not complete two-factor setup.' });
  }
});

// POST /api/admin/2fa/verify — second step of every later sign-in.
router.post('/2fa/verify', authLimiter, async (req, res) => {
  try {
    const payload = verifyShortToken(req.body && req.body.challengeToken, 'admin_2fa');
    const { rows } = await pool.query('SELECT * FROM admins WHERE id=$1', [payload.adminId]);
    const admin = rows[0];
    if (!admin || !admin.totp_enabled || !admin.totp_secret) {
      return res.status(401).json({ error: 'Two-factor is not set up. Sign in again.' });
    }
    if (!totp.verify(admin.totp_secret, req.body && req.body.code)) {
      await audit.logLoginAttempt(req, { email: admin.email, ok: false, reason: 'bad_2fa_code' });
      return res.status(401).json({ error: 'That code is wrong or expired. Check your authenticator app and try again.' });
    }
    await finishAdminLogin(req, res, admin, 'password+2fa');
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Your sign-in window expired. Enter your password again.' });
    }
    console.error('2FA verify error:', err);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

// GET /api/admin/audit-log — who did what, newest first.
router.get('/audit-log', requireAdmin, requireRole('super_admin'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT id, admin_email, action, target_type, target_id, detail, ip, created_at
     FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  const { rows: attempts } = await pool.query(
    `SELECT id, email, ok, reason, ip, created_at FROM admin_login_attempts
     ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 100)]
  );
  res.json({ entries: rows, loginAttempts: attempts });
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
  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const where = status === 'all' ? '' : 'WHERE j.status=$1';
  const params = status === 'all' ? [] : [status];
  const { rows } = await pool.query(
    `SELECT j.*, u.business_name, u.business_reg_number, u.kra_pin, u.full_name AS owner_name, u.email AS owner_email
     FROM jobs j JOIN users u ON u.id = j.owner_id
     ${where} ORDER BY j.created_at DESC`,
    params
  );
  res.json({ jobs: rows });
});

router.post('/jobs/:id/approve', requireAdmin, requireRole('super_admin', 'reviewer'), requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE jobs SET status='approved', reviewed_by=$1, reviewed_at=now() WHERE id=$2 RETURNING *`,
    [req.admin.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  await audit.logAdminAction(req, 'job.approved', { targetType: 'job', targetId: req.params.id, detail: { title: rows[0].title } });
  res.json({ job: rows[0] });
});

router.post('/jobs/:id/reject', requireAdmin, requireRole('super_admin', 'reviewer'), requireUuid('id'), async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE jobs SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
    [req.admin.id, reason || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  await audit.logAdminAction(req, 'job.rejected', { targetType: 'job', targetId: req.params.id, detail: { title: rows[0].title, reason: reason || null } });
  res.json({ job: rows[0] });
});

const REVENUE_PERIODS = { 7: 'Last week', 28: 'Last 28 days', 30: 'Last month', 90: 'Last 90 days', 180: 'Last 6 months', 365: 'Last 365 days' };

router.get('/revenue', requireAdmin, async (req, res) => {
  try {
    const days = REVENUE_PERIODS[Number(req.query.days)] ? Number(req.query.days) : 28;
    const periodKeys = Object.keys(REVENUE_PERIODS);
    const [total, byPurpose, recent, series] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success'`),
      pool.query(`SELECT purpose, COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' GROUP BY purpose ORDER BY total DESC`),
      pool.query(`SELECT p.id, p.purpose, p.amount, p.phone, p.mpesa_receipt, p.status, p.created_at, u.full_name, u.email, u.account_type FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 50`),
      pool.query(`SELECT DATE(created_at)::text AS day, COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' AND created_at > now() - ($1 || ' days')::interval GROUP BY day ORDER BY day ASC`, [String(days)]),
    ]);
    const periodRows = await Promise.all(periodKeys.map((d) =>
      pool.query(`SELECT COALESCE(SUM(amount),0)::numeric(10,2) AS total, count(*)::int AS count FROM payments WHERE status='success' AND created_at > now() - ($1 || ' days')::interval`, [d])
    ));
    const periods = {};
    periodKeys.forEach((d, i) => {
      periods[d] = { label: REVENUE_PERIODS[d], total: Number(periodRows[i].rows[0].total), count: periodRows[i].rows[0].count };
    });
    res.json({
      totalRevenue: Number(total.rows[0].total),
      totalTransactions: total.rows[0].count,
      byPurpose: byPurpose.rows.map((r) => ({ purpose: r.purpose, total: Number(r.total), count: r.count })),
      last7Days: periods['7'],
      last30Days: periods['30'],
      period: { days, label: REVENUE_PERIODS[days], total: periods[days].total, count: periods[days].count },
      periods,
      series: series.rows.map((r) => ({ day: r.day, total: Number(r.total), count: r.count })),
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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';    const { rows } = await pool.query(
    `SELECT id, account_type, full_name, email, phone, national_id, id_verification_status,
            business_name, business_reg_number, kra_pin, disabled_at, created_at
     FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  res.json({ users: rows });
});

router.get('/users/:id', requireAdmin, requireUuid('id'), async (req, res) => {
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

router.post('/users/:id/delete', requireAdmin, requireRole('super_admin'), requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET disabled_at = COALESCE(disabled_at, now()), updated_at = now() WHERE id=$1 RETURNING id, full_name, disabled_at`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await pool.query(`DELETE FROM sessions WHERE user_id=$1`, [req.params.id]).catch(() => {});
  await audit.logAdminAction(req, 'user.deactivated', { targetType: 'user', targetId: req.params.id });
  res.json({ user: rows[0], message: 'Account deactivated. Their records, payments and reports are kept for audit.' });
});

router.post('/users/:id/restore', requireAdmin, requireRole('super_admin'), requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET disabled_at = NULL, updated_at = now() WHERE id=$1 RETURNING id, full_name`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await audit.logAdminAction(req, 'user.restored', { targetType: 'user', targetId: req.params.id });
  res.json({ user: rows[0], message: 'Account reactivated.' });
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



router.get('/id-verifications/:userId/document', requireAdmin, requireUuid('userId'), async (req, res) => {
  const { rows } = await pool.query('SELECT id_document_filename FROM users WHERE id=$1', [req.params.userId]);
  const filename = rows[0]?.id_document_filename;
  if (!filename) return res.status(404).json({ error: 'No document on file for this user.' });

  const filePath = path.join(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  // Opening an ID image is a personal-data access event and is recorded.
  await audit.logAdminAction(req, 'id_document.viewed', { targetType: 'user', targetId: req.params.userId });
  res.sendFile(filePath);
});

router.post('/id-verifications/:userId/approve', requireAdmin, requireRole('super_admin', 'reviewer'), requireUuid('userId'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET id_verification_status='approved', id_verification_reviewed_by=$1, id_verification_reviewed_at=now(), id_verification_notes=NULL
     WHERE id=$2 RETURNING id, full_name, id_verification_status`,
    [req.admin.id, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await audit.logAdminAction(req, 'id_verification.approved', { targetType: 'user', targetId: req.params.userId });
  res.json({ user: rows[0] });
});

router.post('/id-verifications/:userId/reject', requireAdmin, requireRole('super_admin', 'reviewer'), requireUuid('userId'), async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE users SET id_verification_status='rejected', id_verification_reviewed_by=$1, id_verification_reviewed_at=now(), id_verification_notes=$2
     WHERE id=$3 RETURNING id, full_name, id_verification_status`,
    [req.admin.id, reason || null, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await audit.logAdminAction(req, 'id_verification.rejected', { targetType: 'user', targetId: req.params.userId, detail: { reason: reason || null } });
  res.json({ user: rows[0] });
});

router.get('/contact-messages', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100');
  res.json({ messages: rows });
});


router.get('/settings/me', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT totp_enabled, last_login_at FROM admins WHERE id=$1', [req.admin.id]);
  res.json({
    admin: {
      id: req.admin.id,
      fullName: req.admin.full_name,
      email: req.admin.email,
      role: req.admin.role,
      twoFactorEnabled: Boolean(rows[0] && rows[0].totp_enabled),
      lastLoginAt: rows[0] ? rows[0].last_login_at : null,
    },
  });
});

router.post('/settings/credentials', requireAdmin, requireRole('super_admin'), authLimiter, async (req, res) => {
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
    let passwordChanged = false;
    if (newPassword) {
      if (newPassword.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
      const newHash = await bcrypt.hash(newPassword, 12);
      params.push(newHash);
      updates.push(`password_hash = $${params.length}`);
      // Invalidate every token issued with the old password.
      updates.push('session_version = session_version + 1');
      passwordChanged = true;
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(req.admin.id);
    const { rows: updated } = await pool.query(
      `UPDATE admins SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING id, full_name, email, role, session_version`,
      params
    );
    await audit.logAdminAction(req, 'admin.credentials_changed', {
      targetType: 'admin',
      targetId: req.admin.id,
      detail: {
        passwordChanged,
        emailChanged: Boolean(newEmail && newEmail.trim()),
        fullNameChanged: Boolean(newFullName && newFullName.trim()),
      },
    });
    res.json({
      admin: updated[0],
      reauthenticate: passwordChanged,
      message: passwordChanged
        ? 'Password changed. Every other session has been signed out — sign in again with the new password.'
        : 'Credentials updated.',
    });
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

router.post('/forensics-cases/:caseId/status', requireAdmin, requireUuid('caseId'), async (req, res) => {
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
  await audit.logAdminAction(req, 'forensics.status_changed', { targetType: 'forensics_case', targetId: req.params.caseId, detail: { status, note: note || null } });
  res.json({ case: rows[0] });
});


router.post('/push/subscribe', requireAdmin, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }
    await saveAdminSubscription(req.admin.id, subscription, req.headers['user-agent']);
    res.json({ message: 'Push notifications enabled for admin.' });
  } catch (err) {
    console.error('Admin push subscribe error:', err);
    res.status(500).json({ error: 'Could not save push subscription.' });
  }
});

router.post('/push/unsubscribe', requireAdmin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await removeSubscription(endpoint);
    }
    res.json({ message: 'Push notifications disabled for this device.' });
  } catch (err) {
    console.error('Admin push unsubscribe error:', err);
    res.status(500).json({ error: 'Could not remove push subscription.' });
  }
});

// How many user devices an admin broadcast would reach right now
router.get('/push/status', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE user_id IS NOT NULL)::int AS user_devices,
         count(*) FILTER (WHERE admin_id IS NOT NULL)::int AS admin_devices,
         count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS users_reached
       FROM push_subscriptions`
    );
    const pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
    // camelCase — the admin panel reads userDevices/adminDevices/usersReached
    res.json({
      pushConfigured,
      userDevices: rows[0].user_devices,
      adminDevices: rows[0].admin_devices,
      usersReached: rows[0].users_reached,
    });
  } catch (err) {
    console.error('Push status error:', err);
    res.status(500).json({ error: 'Could not load push status.' });
  }
});

// Broadcast a push notification to ALL users with a saved subscription
router.post('/push/broadcast', requireAdmin, async (req, res) => {
  const { title, body, url } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A notification title is required.' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'A notification message is required.' });
  if (title.length > 100) return res.status(400).json({ error: 'Title must be 100 characters or fewer.' });
  if (body.length > 300) return res.status(400).json({ error: 'Message must be 300 characters or fewer.' });
  if (url && !/^\/[a-zA-Z0-9._\/?=&-]*$/.test(url)) return res.status(400).json({ error: 'URL must be a relative path starting with /.' });

  try {
    const result = await broadcastToUsers(String(title).trim(), String(body).trim(), url);
    console.log(`[admin] Broadcast sent by ${req.admin.email}: ${result.sent}/${result.targeted} devices.`);
    // Mirror to admins so they can see what went out
    sendToAdmins({ title: `📣 ${title}`.substring(0, 100), body: `Broadcast to users: ${body}`.substring(0, 300), url: '/admin/deploy/dashboard.html' }).catch(() => {});
    res.json({ message: `Broadcast delivered to ${result.sent} of ${result.targeted} device(s).`, ...result });
  } catch (err) {
    console.error('Admin broadcast error:', err);
    res.status(err.message.includes('not configured') ? 503 : 500).json({ error: err.message });
  }
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

// ---- Status page incidents ----
// Probe-derived outages are computed from status_probes and cannot be edited;
// these endpoints publish the human context a customer needs (planned
// maintenance, a known upstream fault, a post-mortem note).
router.get('/status/notices', requireAdmin, async (req, res) => {
  try {
    const notices = await statusHistory.listNotices(Number(req.query.days) || 90);
    res.json({ notices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/status/notices', requireAdmin, requireRole('super_admin', 'support'), async (req, res) => {
  const { component, severity, title, body, startedAt } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required.' });
  try {
    const notice = await statusHistory.createNotice({
      component,
      severity,
      title: String(title).trim(),
      body,
      startedAt,
      createdBy: req.admin && req.admin.email,
    });
    await audit.logAdminAction(req, 'status_notice.created', { targetType: 'status_notice', targetId: notice && notice.id, detail: { title: String(title).trim(), severity } });
    res.status(201).json({ notice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/status/notices/:id/resolve', requireAdmin, requireRole('super_admin', 'support'), async (req, res) => {
  try {
    const notice = await statusHistory.resolveNotice(req.params.id, { resolvedAt: req.body && req.body.resolvedAt });
    if (!notice) return res.status(404).json({ error: 'No open notice with that id.' });
    await audit.logAdminAction(req, 'status_notice.resolved', { targetType: 'status_notice', targetId: req.params.id });
    res.json({ notice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Trust Check API admin endpoints ----

// GET /api/admin/reports
router.get('/reports', requireAdmin, async (req, res) => {
  const status = req.query.status === 'approved' || req.query.status === 'rejected' || req.query.status === 'removed'
    ? req.query.status
    : 'pending';
  const type = ['phone', 'paybill', 'business', 'website', 'job', 'other'].includes(req.query.type) ? req.query.type : null;
  const params = [status];
  let where = 'status = $1';
  if (type) { params.push(type); where += ` AND report_type = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT id, report_type, subject_value, subject_name, description, amount_lost_kes, evidence_path, status, reporter_user_id, reporter_email, rejection_reason, reviewed_by, reviewed_at, created_at
     FROM scam_reports
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT 100`,
    params
  );
  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      type: r.report_type,
      subject: reportService.maskSubject(r.report_type, r.subject_value),
      subjectValue: r.subject_value,
      subjectName: r.subject_name,
      description: r.description,
      amountLostKes: r.amount_lost_kes,
      evidence: r.evidence_path,
      status: r.status,
      reporterEmail: r.reporter_email,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
    })),
  });
});

// GET /api/admin/reports/:id/evidence — open the evidence the reporter attached
router.get('/reports/:id/evidence', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(`SELECT evidence_path FROM scam_reports WHERE id=$1`, [req.params.id]);
  const filename = rows[0]?.evidence_path;
  if (!filename) return res.status(404).json({ error: 'No evidence attached to this report.' });
  // Evidence can be a reporter-supplied link (API submissions). Never
  // 302 an authenticated admin request to an arbitrary external URL —
  // return the link as JSON and let the UI present it as an explicit link.
  if (/^https?:\/\//i.test(filename)) {
    return res.json({ url: filename });
  }
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Evidence file not found.' });
  }
  res.sendFile(filePath);
});

// POST /api/admin/reports/:id/approve
router.post('/reports/:id/approve', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  try {
    const result = await reportService.approve(req.params.id, req.admin.id);
    await audit.logAdminAction(req, 'report.approved', { targetType: 'scam_report', targetId: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/admin/reports/:id/reject
router.post('/reports/:id/reject', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await reportService.reject(req.params.id, req.admin.id, reason || null);
    await audit.logAdminAction(req, 'report.rejected', { targetType: 'scam_report', targetId: req.params.id, detail: { reason: reason || null } });
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/admin/reports/:id/remove
router.post('/reports/:id/remove', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  try {
    const result = await reportService.remove(req.params.id, req.admin.id, req.body.reason || null);
    await audit.logAdminAction(req, 'report.removed', { targetType: 'scam_report', targetId: req.params.id, detail: { reason: req.body.reason || null } });
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/reports/:id/edit', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const description = String(req.body.description || '').trim();
  if (description.length < 40) return res.status(400).json({ error: 'Edited description must be at least 40 characters.' });
  if (description.length > 2000) return res.status(400).json({ error: 'Edited description must be at most 2000 characters.' });
  const { rows } = await pool.query(
    `UPDATE scam_reports SET description=$2, reviewed_by=$3 WHERE id=$1 RETURNING id, description, status`,
    [req.params.id, description, req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });
  await audit.logAdminAction(req, 'report.edited', { targetType: 'scam_report', targetId: req.params.id });
  res.json({ report: rows[0], message: 'Report text updated.' });
});

router.post('/reports/:id/duplicate', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE scam_reports SET status='rejected', rejection_reason='Duplicate of an existing report', reviewed_by=$2, reviewed_at=now()
     WHERE id=$1 AND status='pending' RETURNING id, status`,
    [req.params.id, req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Report not found or already reviewed.' });
  await audit.logAdminAction(req, 'report.marked_duplicate', { targetType: 'scam_report', targetId: req.params.id });
  res.json({ report: rows[0], message: 'Marked as duplicate.' });
});

// GET /api/admin/disputes
router.get('/disputes', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, r.subject_value, r.reporter_email, r.status AS report_status
     FROM report_disputes d
     JOIN scam_reports r ON r.id = d.report_id
     ORDER BY d.created_at DESC
     LIMIT 100`
  );
  res.json({ disputes: rows });
});

// POST /api/admin/disputes/:id/uphold
router.post('/disputes/:id/uphold', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const { rows: dispute } = await pool.query(
    `SELECT id, report_id FROM report_disputes WHERE id=$1`,
    [req.params.id]
  );
  if (!dispute[0]) return res.status(404).json({ error: 'Dispute not found.' });
  const { rows: report } = await pool.query(
    `UPDATE scam_reports SET status='removed', reviewed_by=$2, reviewed_at=now() WHERE id=$1 RETURNING *`,
    [dispute[0].report_id, req.admin.id]
  );
  if (!report[0]) return res.status(404).json({ error: 'Report not found.' });
  try {
    await checkService.invalidateSubject(report[0].report_type, report[0].subject_hash);
    await webhookService.notifySubjectChange(report[0].report_type, report[0].subject_hash);
  } catch (err) { /* best effort */ }
  await audit.logAdminAction(req, 'dispute.upheld', { targetType: 'report_dispute', targetId: req.params.id, detail: { note: req.body.note || null } });
  res.json({ dispute: { id: req.params.id, note: req.body.note || null }, message: 'Uphold processed. The report is removed and the subject is re-evaluated.' });
});

// POST /api/admin/disputes/:id/dismiss
router.post('/disputes/:id/dismiss', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE report_disputes SET status='dismissed', resolution_note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, req.admin.id, req.body.note || null, req.body.note ? null : req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Dispute not found.' });
  await audit.logAdminAction(req, 'dispute.dismissed', { targetType: 'report_dispute', targetId: req.params.id, detail: { note: req.body.note || null } });
  res.json({ dispute: rows[0], message: 'Dismiss notified to submitter.' });
});

// GET /api/admin/plans — active plans for the customer plan control.
router.get('/plans', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT code, name, monthly_price_kes, monthly_quota, rate_limit_per_min
     FROM api_plans WHERE is_active=TRUE ORDER BY monthly_price_kes ASC`
  );
  res.json({
    plans: rows.map((p) => ({
      code: p.code,
      name: p.name,
      priceKes: p.monthly_price_kes,
      quota: p.monthly_quota,
      rateLimitPerMin: p.rate_limit_per_min,
    })),
  });
});

// GET /api/admin/api-accounts
router.get('/api-accounts', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_name, a.website, a.use_case, a.plan_id, p.code AS plan_code, p.monthly_price_kes AS plan_price_kes,
            p.monthly_quota AS monthly_quota, a.status, a.webhook_url, a.plan_renews_on, a.created_at,
            a.org_registration_no, a.verification_status, a.verified_at, a.business_doc_path,
            (SELECT COUNT(*)::int FROM api_usage_log u WHERE u.account_id = a.id AND u.created_at >= now() - interval '30 days') AS usage_this_month,
            (SELECT COUNT(*)::int FROM api_usage_log u WHERE u.account_id = a.id AND u.created_at >= now() - interval '7 days') AS usage_last_7d,
            (SELECT COUNT(*)::int FROM api_keys k WHERE k.account_id = a.id AND k.status='active') AS active_keys,
            (SELECT MAX(u2.created_at) FROM api_usage_log u2 WHERE u2.account_id = a.id) AS last_activity,
            us.full_name AS owner_name, us.email AS owner_email, us.phone AS owner_phone
     FROM api_accounts a
     JOIN api_plans p ON p.id = a.plan_id
     LEFT JOIN users us ON us.id = a.user_id
     ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.created_at DESC`
  );
  res.json({
    accounts: rows.map((a) => ({
      id: a.id,
      companyName: a.company_name,
      website: a.website,
      useCase: a.use_case,
      status: a.status,
      planCode: a.plan_code,
      planPriceKes: a.plan_price_kes,
      monthlyQuota: a.monthly_quota,
      usageThisMonth: a.usage_this_month,
      usageLast7d: a.usage_last_7d,
      activeKeys: a.active_keys,
      lastActivity: a.last_activity,
      ownerName: a.owner_name,
      ownerEmail: a.owner_email,
      ownerPhone: a.owner_phone,
      planRenewsOn: a.plan_renews_on,
      orgRegistrationNo: a.org_registration_no,
      verificationStatus: a.verification_status,
      verifiedAt: a.verified_at,
      hasBusinessDoc: Boolean(a.business_doc_path),
      createdAt: a.created_at,
    })),
  });
});

// POST /api/admin/api-accounts/:id/approve — API accounts go public only after admin approval
router.post('/api-accounts/:id/approve', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='active' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, 'api_account.approved', { targetType: 'api_account', targetId: req.params.id, detail: { company: rows[0].company_name } });
  res.json({ account: rows[0], message: 'API account approved. Their keys are live.' });
});

// POST /api/admin/api-accounts/:id/reject
router.post('/api-accounts/:id/reject', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='closed', verification_note=$2 WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id, reason]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, 'api_account.rejected', { targetType: 'api_account', targetId: req.params.id, detail: { company: rows[0].company_name, reason } });
  res.json({ account: rows[0], message: 'API account rejected.' });
});

// ── Organisation verification (business registration documents) ────────────
// API partners verify their ORGANISATION, not a personal national ID.
router.get('/api-accounts/org-verifications', requireAdmin, async (req, res) => {
  const status = ['documents_submitted', 'unverified', 'verified', 'rejected'].includes(req.query.status)
    ? req.query.status : 'documents_submitted';
  const { rows } = await pool.query(
    `SELECT a.id, a.company_name, a.org_registration_no, a.business_doc_path,
            a.verification_status, a.verification_note, a.verified_at, a.created_at,
            us.full_name AS owner_name, us.email AS owner_email
     FROM api_accounts a LEFT JOIN users us ON us.id = a.user_id
     WHERE a.verification_status = $1 ORDER BY a.created_at ASC`,
    [status]
  );
  res.json({
    accounts: rows.map((a) => ({
      id: a.id,
      companyName: a.company_name,
      orgRegistrationNo: a.org_registration_no,
      hasBusinessDoc: Boolean(a.business_doc_path),
      verificationStatus: a.verification_status,
      verificationNote: a.verification_note,
      verifiedAt: a.verified_at,
      ownerName: a.owner_name,
      ownerEmail: a.owner_email,
      createdAt: a.created_at,
    })),
  });
});

router.get('/api-accounts/:id/business-doc', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query('SELECT business_doc_path FROM api_accounts WHERE id=$1', [req.params.id]);
  const filename = rows[0]?.business_doc_path;
  if (!filename) return res.status(404).json({ error: 'No business document on file for this account.' });

  const filePath = path.join(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  res.sendFile(filePath);
});

// GET /api/admin/api-accounts/:id — one partner, with key prefixes (never the
// key itself), quota usage and the renewal countdown staff must see.
router.get('/api-accounts/:id', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, p.code AS plan_code, p.name AS plan_name, p.monthly_price_kes, p.monthly_quota, p.rate_limit_per_min,
            p.webhooks_enabled, p.batch_enabled,
            us.full_name AS owner_name, us.email AS owner_email, us.phone AS owner_phone
     FROM api_accounts a
     JOIN api_plans p ON p.id = a.plan_id
     LEFT JOIN users us ON us.id = a.user_id
     WHERE a.id = $1`,
    [req.params.id]
  );
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'API account not found.' });

  const [{ rows: keys }, { rows: usage }] = await Promise.all([
    pool.query(
      `SELECT id, label, key_type, key_prefix, mode, status, allowed_domains, last_used_at, created_at, revoked_at
       FROM api_keys WHERE account_id=$1 ORDER BY created_at DESC`,
      [account.id]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS checks_30d,
              COUNT(*) FILTER (WHERE verdict IS NOT NULL)::int AS scored_30d,
              MAX(created_at) AS last_activity
       FROM api_usage_log WHERE account_id=$1 AND created_at >= now() - interval '30 days'`,
      [account.id]
    ),
  ]);

  const renewal = account.plan_renews_on ? new Date(account.plan_renews_on) : null;
  const daysUntilRenewal = renewal
    ? Math.ceil((renewal.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  res.json({
    account: {
      id: account.id,
      companyName: account.company_name,
      website: account.website,
      useCase: account.use_case,
      status: account.status,
      planCode: account.plan_code,
      planName: account.plan_name,
      planPriceKes: account.monthly_price_kes,
      monthlyQuota: account.monthly_quota,
      rateLimitPerMin: account.rate_limit_per_min,
      webhooksEnabled: account.webhooks_enabled,
      batchEnabled: account.batch_enabled,
      webhookUrl: account.webhook_url,
      usageThisMonth: usage[0] ? usage[0].checks_30d : 0,
      lastActivity: usage[0] ? usage[0].last_activity : null,
      planRenewsOn: account.plan_renews_on,
      daysUntilRenewal,
      orgRegistrationNo: account.org_registration_no,
      verificationStatus: account.verification_status,
      verificationNote: account.verification_note,
      verifiedAt: account.verified_at,
      hasBusinessDoc: Boolean(account.business_doc_path),
      ownerName: account.owner_name,
      ownerEmail: account.owner_email,
      ownerPhone: account.owner_phone,
      createdAt: account.created_at,
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        keyType: k.key_type,
        keyPrefix: k.key_prefix,
        mode: k.mode,
        status: k.status,
        allowedDomains: k.allowed_domains || [],
        lastUsedAt: k.last_used_at,
        createdAt: k.created_at,
        revokedAt: k.revoked_at,
      })),
    },
  });
});

router.post('/api-accounts/:id/verify-org', requireAdmin, requireRole('super_admin', 'reviewer'), requireInt('id'), async (req, res) => {
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'." });
  }
  // A rejection without a reason leaves the partner with no way to fix their
  // documents, and leaves no audit trail for the decision.
  const reason = String(note || '').trim();
  if (action === 'reject' && !reason) {
    return res.status(400).json({ error: 'A rejection reason is required — it is recorded and shown to the partner.' });
  }
  const nextStatus = action === 'approve' ? 'verified' : 'rejected';
  const { rows } = await pool.query(
    `UPDATE api_accounts SET verification_status=$2, verification_note=$3,
            verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE verified_at END,
            -- One-step developer review: approving the organisation's documents
            -- also activates a still-pending developer account, so admins never
            -- have to approve the same partner twice.
            status = CASE WHEN $2 = 'verified' AND status = 'pending' THEN 'active' ELSE status END
     WHERE id=$1 RETURNING id, company_name, verification_status, status`,
    [req.params.id, nextStatus, note || null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, action === 'approve' ? 'api_account.org_verified' : 'api_account.org_rejected', {
    targetType: 'api_account',
    targetId: req.params.id,
    detail: { company: rows[0].company_name, reason: reason || null },
  });
  res.json({
    account: rows[0],
    message: action === 'approve'
      ? (rows[0].status === 'active' ? 'Organisation verified and developer account activated.' : 'Organisation verified.')
      : 'Organisation rejected — the partner can resubmit documents.',
  });
});

// POST /api/admin/api-accounts/:id/suspend
router.post('/api-accounts/:id/suspend', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='suspended' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, 'api_account.suspended', { targetType: 'api_account', targetId: req.params.id, detail: { company: rows[0].company_name, reason: req.body && req.body.reason ? String(req.body.reason) : null } });
  res.json({ account: rows[0], message: 'Account suspended.' });
});

// POST /api/admin/api-accounts/:id/reactivate
router.post('/api-accounts/:id/reactivate', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='active' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, 'api_account.reactivated', { targetType: 'api_account', targetId: req.params.id, detail: { company: rows[0].company_name } });
  res.json({ account: rows[0], message: 'Account reactivated.' });
});

// POST /api/admin/api-accounts/:id/plan
router.post('/api-accounts/:id/plan', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const { planCode } = req.body;
  const before = await pool.query('SELECT p.code FROM api_accounts a JOIN api_plans p ON p.id=a.plan_id WHERE a.id=$1', [req.params.id]);
  try {
    const plan = await billingService.changePlan(Number(req.params.id), planCode);
    await audit.logAdminAction(req, 'api_account.plan_changed', {
      targetType: 'api_account',
      targetId: req.params.id,
      detail: { from: before.rows[0] ? before.rows[0].code : null, to: plan.code },
    });
    res.json({ account: { id: req.params.id, plan_code: plan.code, name: plan.name, price_kes: plan.monthly_price_kes, quota: plan.monthly_quota } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/api-accounts/:id/close
router.post('/api-accounts/:id/close', requireAdmin, requireRole('super_admin'), requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='closed' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  await audit.logAdminAction(req, 'api_account.closed', { targetType: 'api_account', targetId: req.params.id, detail: { company: rows[0].company_name, reason: req.body && req.body.reason ? String(req.body.reason) : null } });
  res.json({ account: rows[0], message: 'Account closed.' });
});

// GET /api/admin/webhook-failures
router.get('/webhook-failures', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.id, w.account_id, a.company_name, w.event, w.status, w.attempts, w.next_attempt_at, w.last_response_code, w.created_at, w.delivered_at, w.signature
     FROM webhook_deliveries w
     JOIN api_accounts a ON a.id = w.account_id
     WHERE w.status='failed'
     ORDER BY w.created_at DESC
     LIMIT 100`
  );
  res.json({ deliveries: rows });
});

// POST /api/admin/webhook-failures/:id/retry
router.post('/webhook-failures/:id/retry', requireAdmin, requireRole('super_admin', 'support'), requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries SET status='pending', next_attempt_at=now() + '60 seconds'::interval WHERE id=$1 RETURNING id, account_id, event, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Delivery not found.' });
  await audit.logAdminAction(req, 'webhook.retry_queued', { targetType: 'webhook_delivery', targetId: req.params.id, detail: { event: rows[0].event, accountId: rows[0].account_id } });
  res.json({ delivery: rows[0], message: 'Retry queued.' });
});

// ---- Payment reconciliation ----
// Manual M-Pesa code entry was removed, so a payment whose Tuma callback never
// arrived has no customer-side fix. Staff need to see it and re-query Tuma.
function maskPhone(phone) {
  const digits = String(phone || '');
  if (digits.length < 6) return digits ? '••••' : '—';
  return `${digits.slice(0, 3)}•••${digits.slice(-3)}`;
}

function mapReconPayment(p) {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 60000));
  return {
    id: p.id,
    purpose: p.purpose,
    amount: Number(p.amount),
    status: p.status,
    phone: maskPhone(p.phone),
    mpesaReceipt: p.mpesa_receipt,
    checkoutRequestId: p.tuma_checkout_request_id,
    hasCheckoutId: Boolean(p.tuma_checkout_request_id),
    ageMinutes,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ownerEmail: p.owner_email || null,
    ownerName: p.owner_name || null,
  };
}

router.get('/payments/reconciliation', requireAdmin, async (req, res) => {
  try {
    const [stuck, failed] = await Promise.all([
      pool.query(
        `SELECT p.id, p.purpose, p.amount, p.status, p.phone, p.mpesa_receipt, p.tuma_checkout_request_id,
                p.created_at, p.updated_at, u.email AS owner_email, u.full_name AS owner_name
         FROM payments p LEFT JOIN users u ON u.id = p.user_id
         WHERE p.status IN ('initiated','pending') AND p.created_at < now() - interval '2 minutes'
         ORDER BY p.created_at ASC LIMIT 100`
      ),
      pool.query(
        `SELECT p.id, p.purpose, p.amount, p.status, p.phone, p.mpesa_receipt, p.tuma_checkout_request_id,
                p.created_at, p.updated_at, u.email AS owner_email, u.full_name AS owner_name
         FROM payments p LEFT JOIN users u ON u.id = p.user_id
         WHERE p.status = 'failed' AND p.created_at >= now() - interval '7 days'
         ORDER BY p.created_at DESC LIMIT 100`
      ),
    ]);
    res.json({
      stuck: stuck.rows.map(mapReconPayment),
      failed: failed.rows.map(mapReconPayment),
      summary: {
        stuckCount: stuck.rows.length,
        stuckValueKes: stuck.rows.reduce((sum, p) => sum + Number(p.amount), 0),
        failedLast7dCount: failed.rows.length,
      },
      note: 'Stuck means initiated or pending for more than 2 minutes. Failed shows the last 7 days. Re-query asks Tuma for the current state of that checkout and applies it.',
    });
  } catch (err) {
    console.error('Payment reconciliation failed:', err);
    res.status(500).json({ error: 'Could not load payments.' });
  }
});

router.post('/payments/:id/requery', requireAdmin, requireRole('super_admin'), requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
  const payment = rows[0];
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  if (!payment.tuma_checkout_request_id) {
    return res.status(409).json({ error: 'This payment has no Tuma checkout ID, so it cannot be re-queried. The STK push never started.' });
  }
  if (payment.status === 'success') {
    return res.json({ outcome: 'success', message: 'Already confirmed as paid. No change made.', payment: mapReconPayment(payment) });
  }

  let body;
  try {
    body = await tuma.queryPaymentStatus(payment.tuma_checkout_request_id);
  } catch (err) {
    if (err.code === 'TUMA_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Tuma credentials are not configured on this server, so live re-query is unavailable.' });
    }
    console.error('Tuma re-query failed:', err.message);
    return res.status(502).json({ error: 'Tuma did not answer the re-query. Try again shortly.' });
  }
  if (!body) return res.status(502).json({ error: 'Tuma returned no status for this checkout. Try again shortly.' });

  const result = interpretTumaStatus(body);
  let updated = payment;
  if (result.state === 'success') {
    const res2 = await pool.query(
      `UPDATE payments SET status='success', mpesa_receipt=COALESCE($1, mpesa_receipt),
              raw_callback_json=$2, updated_at=now() WHERE id=$3 RETURNING *`,
      [result.receipt, JSON.stringify(body), payment.id]
    );
    updated = res2.rows[0];
    // Same side effects as a normal callback: activate subscription, release
    // the paid check, mark the API invoice paid, switch plan.
    await applyPaymentSuccessSideEffects(updated);
  } else if (result.state === 'failed') {
    const res2 = await pool.query(
      `UPDATE payments SET status='failed', raw_callback_json=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [JSON.stringify(body), payment.id]
    );
    updated = res2.rows[0];
  } else {
    const res2 = await pool.query(
      `UPDATE payments SET raw_callback_json=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [JSON.stringify(body), payment.id]
    );
    updated = res2.rows[0];
  }

  await audit.logAdminAction(req, 'payment.requeried', {
    targetType: 'payment',
    targetId: payment.id,
    detail: { outcome: result.state, providerStatus: result.rawStatus, amount: Number(payment.amount) },
  });

  const messages = {
    success: 'Tuma confirms this payment succeeded. The customer side has been activated.',
    failed: 'Tuma reports this payment failed or was cancelled. Nothing was activated.',
    pending: 'Tuma still reports this payment as pending. No change made.',
    unknown: 'Tuma returned an unrecognised status. No change made — check the Tuma dashboard.',
  };
  res.json({ outcome: result.state, message: messages[result.state], payment: mapReconPayment(updated) });
});

// GET /api/admin/api-usage
router.get('/api-usage', requireAdmin, async (req, res) => {
  const [
    checksRows,
    accountRows,
    verdictRows,
    latencyRows,
    dailyRows,
    topRows,
    errorRows,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM api_usage_log WHERE created_at >= now() - interval '7 days'`),
    pool.query("SELECT COUNT(*)::int AS n FROM api_accounts WHERE status='active'"),
    pool.query(`SELECT verdict, COUNT(*)::int AS n FROM api_usage_log WHERE verdict IS NOT NULL GROUP BY verdict ORDER BY n DESC`),
    pool.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM api_usage_log WHERE latency_ms IS NOT NULL`
    ),
    pool.query(`SELECT DATE(created_at)::text AS day, COUNT(*)::int AS n FROM api_usage_log
       WHERE created_at >= now() - interval '30 days' GROUP BY day ORDER BY day ASC`),
    pool.query(`SELECT a.company_name, COUNT(*)::int AS n FROM api_usage_log l
       JOIN api_accounts a ON a.id = l.account_id
       WHERE l.created_at >= now() - interval '30 days'
       GROUP BY a.company_name ORDER BY n DESC LIMIT 5`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status_code >= 500)::int AS errors, COUNT(*)::int AS total
       FROM api_usage_log WHERE created_at >= now() - interval '30 days'`),
  ]);
  const verdictBreakdown = verdictRows.rows.map((r) => ({ verdict: r.verdict, count: r.n }));
  const verdictMix = verdictBreakdown.reduce((sum, r) => sum + r.count, 0);
  const total30 = errorRows.rows[0].total || 0;
  res.json({
    platformTotals: {
      checksServed: checksRows.rows[0].n,
      activeAccounts: accountRows.rows[0].n,
      verdictMix,
      verdictBreakdown,
    },
    latencyP50: Number(latencyRows.rows[0].p50) || 0,
    latencyP95: Number(latencyRows.rows[0].p95) || 0,
    dailySeries: dailyRows.rows.map((r) => ({ day: r.day, n: r.n })),
    topAccounts: topRows.rows.map((r) => ({ companyName: r.company_name, count: r.n })),
    errorRate: total30 > 0 ? Math.round((errorRows.rows[0].errors / total30) * 1000) / 10 : 0,
    requests30d: total30,
  });
});

module.exports = router;
