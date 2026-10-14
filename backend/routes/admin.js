





const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/adminAuth');
const { authLimiter } = require('../middleware/rateLimiter');
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

router.post('/jobs/:id/approve', requireAdmin, requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE jobs SET status='approved', reviewed_by=$1, reviewed_at=now() WHERE id=$2 RETURNING *`,
    [req.admin.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: rows[0] });
});

router.post('/jobs/:id/reject', requireAdmin, requireUuid('id'), async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE jobs SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
    [req.admin.id, reason || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Job not found.' });
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
      pool.query(`SELECT p.id, p.purpose, p.amount, p.phone, p.mpesa_receipt, p.status, p.created_at, u.full_name, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 50`),
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

router.post('/users/:id/delete', requireAdmin, requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET disabled_at = COALESCE(disabled_at, now()), updated_at = now() WHERE id=$1 RETURNING id, full_name, disabled_at`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  await pool.query(`DELETE FROM sessions WHERE user_id=$1`, [req.params.id]).catch(() => {});
  res.json({ user: rows[0], message: 'Account deactivated. Their records, payments and reports are kept for audit.' });
});

router.post('/users/:id/restore', requireAdmin, requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET disabled_at = NULL, updated_at = now() WHERE id=$1 RETURNING id, full_name`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
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
  res.sendFile(filePath);
});

router.post('/id-verifications/:userId/approve', requireAdmin, requireUuid('userId'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE users SET id_verification_status='approved', id_verification_reviewed_by=$1, id_verification_reviewed_at=now(), id_verification_notes=NULL
     WHERE id=$2 RETURNING id, full_name, id_verification_status`,
    [req.admin.id, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: rows[0] });
});

router.post('/id-verifications/:userId/reject', requireAdmin, requireUuid('userId'), async (req, res) => {
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
router.post('/reports/:id/approve', requireAdmin, requireInt('id'), async (req, res) => {
  try {
    const result = await reportService.approve(req.params.id, req.admin.id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/admin/reports/:id/reject
router.post('/reports/:id/reject', requireAdmin, requireInt('id'), async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await reportService.reject(req.params.id, req.admin.id, reason || null);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/admin/reports/:id/remove
router.post('/reports/:id/remove', requireAdmin, requireInt('id'), async (req, res) => {
  try {
    const result = await reportService.remove(req.params.id, req.admin.id, req.body.reason || null);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/reports/:id/edit', requireAdmin, requireInt('id'), async (req, res) => {
  const description = String(req.body.description || '').trim();
  if (description.length < 40) return res.status(400).json({ error: 'Edited description must be at least 40 characters.' });
  if (description.length > 2000) return res.status(400).json({ error: 'Edited description must be at most 2000 characters.' });
  const { rows } = await pool.query(
    `UPDATE scam_reports SET description=$2, reviewed_by=$3 WHERE id=$1 RETURNING id, description, status`,
    [req.params.id, description, req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });
  res.json({ report: rows[0], message: 'Report text updated.' });
});

router.post('/reports/:id/duplicate', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE scam_reports SET status='rejected', rejection_reason='Duplicate of an existing report', reviewed_by=$2, reviewed_at=now()
     WHERE id=$1 AND status='pending' RETURNING id, status`,
    [req.params.id, req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Report not found or already reviewed.' });
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
router.post('/disputes/:id/uphold', requireAdmin, requireInt('id'), async (req, res) => {
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
  res.json({ dispute: { id: req.params.id, note: req.body.note || null }, message: 'Uphold processed. The report is removed and the subject is re-evaluated.' });
});

// POST /api/admin/disputes/:id/dismiss
router.post('/disputes/:id/dismiss', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE report_disputes SET status='dismissed', resolution_note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, req.admin.id, req.body.note || null, req.body.note ? null : req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Dispute not found.' });
  res.json({ dispute: rows[0], message: 'Dismiss notified to submitter.' });
});

// GET /api/admin/api-accounts
router.get('/api-accounts', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_name, a.website, a.use_case, a.plan_id, p.code AS plan_code, p.monthly_price_kes AS plan_price_kes,
            p.monthly_quota AS monthly_quota, a.status, a.webhook_url, a.plan_renews_on, a.created_at,
            a.org_registration_no, a.verification_status, a.verified_at,
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
      createdAt: a.created_at,
    })),
  });
});

// POST /api/admin/api-accounts/:id/approve — API accounts go public only after admin approval
router.post('/api-accounts/:id/approve', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='active' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json({ account: rows[0], message: 'API account approved. Their keys are live.' });
});

// POST /api/admin/api-accounts/:id/reject
router.post('/api-accounts/:id/reject', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='closed' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
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

router.post('/api-accounts/:id/verify-org', requireAdmin, requireInt('id'), async (req, res) => {
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'." });
  }
  const nextStatus = action === 'approve' ? 'verified' : 'rejected';
  const { rows } = await pool.query(
    `UPDATE api_accounts SET verification_status=$2, verification_note=$3,
            verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE verified_at END
     WHERE id=$1 RETURNING id, company_name, verification_status`,
    [req.params.id, nextStatus, note || null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json({
    account: rows[0],
    message: action === 'approve'
      ? 'Organisation verified.'
      : 'Organisation rejected — the partner can resubmit documents.',
  });
});

// POST /api/admin/api-accounts/:id/suspend
router.post('/api-accounts/:id/suspend', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='suspended' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json({ account: rows[0], message: 'Account suspended.' });
});

// POST /api/admin/api-accounts/:id/reactivate
router.post('/api-accounts/:id/reactivate', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='active' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
  res.json({ account: rows[0], message: 'Account reactivated.' });
});

// POST /api/admin/api-accounts/:id/plan
router.post('/api-accounts/:id/plan', requireAdmin, requireInt('id'), async (req, res) => {
  const { planCode } = req.body;
  try {
    const plan = await billingService.changePlan(Number(req.params.id), planCode);
    res.json({ account: { id: req.params.id, plan_code: plan.code, name: plan.name, price_kes: plan.monthly_price_kes, quota: plan.monthly_quota } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/api-accounts/:id/close
router.post('/api-accounts/:id/close', requireAdmin, requireInt('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE api_accounts SET status='closed' WHERE id=$1 RETURNING id, company_name, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found.' });
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
router.post('/webhook-failures/:id/retry', requireAdmin, requireUuid('id'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries SET status='pending', next_attempt_at=now() + '60 seconds'::interval WHERE id=$1 RETURNING id, account_id, event, status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Delivery not found.' });
  res.json({ delivery: rows[0], message: 'Retry queued.' });
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
