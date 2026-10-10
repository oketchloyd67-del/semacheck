const express = require('express');
const pool = require('../db/pool');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { reportAbuseGuard } = require('../middleware/reportAbuseGuard');
const { uploadEvidence } = require('../middleware/upload');
const { submitReport } = require('../services/reportService');
const { sendContactMessageToManagement } = require('../services/emailService');
const { sendToAdmins } = require('../services/pushNotificationService');

const router = express.Router();

function maskSubject(type, value) {
  if (type === 'phone') {
    return value.length > 6 ? value.slice(0, 3) + '***' + value.slice(-3) : value.slice(0, 2) + '***';
  }
  if (type === 'website') {
    const parts = value.split('.');
    if (parts.length > 2) return `${parts[0]}...${parts[parts.length - 1]}`;
    return value;
  }
  return value;
}

function isValidUnlock(paymentId, reportId) {
  if (!paymentId) return Promise.resolve(false);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(String(paymentId))) return Promise.resolve(false);
  return pool.query(
    `SELECT id FROM payments WHERE id=$1 AND purpose='alert_view' AND status='success' AND reference_int=$2`,
    [paymentId, Number(reportId)]
  ).then(({ rows }) => Boolean(rows[0])).catch(() => false);
}

router.post('/', optionalAuth, uploadEvidence, reportAbuseGuard, async (req, res) => {
  try {
    if (req.body.contact_website) {
      return res.status(201).json({
        report: { id: 0, status: 'pending' },
        message: 'Report received. Our admin team reviews every report before it appears publicly.',
      });
    }
    if (req.body.consent !== 'true' && req.body.consent !== '1') {
      return res.status(400).json({ error: 'report_invalid', message: 'Tick the consent box so we can review and publish your report in masked form.' });
    }
    const fp = req.reportFingerprint || req.headers['x-forwarded-for'] || req.ip || '';
    const data = { ...req.body, userId: req.user ? req.user.id : (req.body.userId || null) };
    const rec = await submitReport(data, req.file || null, fp);
    res.status(201).json({
      report: { id: rec.id, status: rec.status, createdAt: rec.created_at },
      message: 'Report received with your evidence. Our admin team reviews every report before it appears publicly.',
    });
  } catch (err) {
    console.error('report failed:', err);
    res.status(400).json({ error: 'report_invalid', message: err.message });
  }
});

router.get('/public', async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'removed'].includes(req.query.status) ? req.query.status : 'approved';
    const limit = 20;
    const page = Math.max(1, Number(req.query.page) || 1);
    const where = ['status = $1'];
    const params = [status];
    if (req.query.type) {
      params.push(req.query.type);
      where.push(`report_type = $${params.length}`);
    }
    if (req.query.q && String(req.query.q).trim()) {
      params.push(`%${String(req.query.q).trim()}%`);
      where.push(`(subject_value ILIKE $${params.length} OR subject_name ILIKE $${params.length})`);
    }
    params.push(limit, (page - 1) * limit);
    const { rows } = await pool.query(
      `SELECT id, report_type, subject_value, created_at, count(*) OVER()::int AS total
       FROM scam_reports
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        type: r.report_type,
        subject: maskSubject(r.report_type, r.subject_value),
        reportedAt: r.created_at,
        locked: true,
      })),
      total: rows[0] ? rows[0].total : 0,
      page,
    });
  } catch (err) {
    console.error('public reports failed:', err);
    res.status(500).json({ error: 'failed' });
  }
});

router.get('/public/:id', async (req, res) => {
  const reportId = Number(req.params.id);
  if (!Number.isInteger(reportId) || reportId < 1) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, report_type, subject_value, subject_name, description, status, created_at
       FROM scam_reports WHERE id=$1 AND status='approved'`,
      [reportId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });
    const r = rows[0];
    const unlocked = await isValidUnlock(req.query.paymentId, reportId);

    if (!unlocked) {
      return res.json({
        locked: true,
        price: 30,
        report: {
          id: r.id,
          type: r.report_type,
          subject: maskSubject(r.report_type, r.subject_value),
          reportedAt: r.created_at,
        },
      });
    }

    res.json({
      locked: false,
      report: {
        id: r.id,
        type: r.report_type,
        subject: r.subject_value,
        name: r.subject_name,
        description: r.description,
        reportedAt: r.created_at,
      },
    });
  } catch (err) {
    console.error('public report failed:', err);
    res.status(500).json({ error: 'failed' });
  }
});

router.post('/:id/dispute', requireInt, uploadEvidence, reportAbuseGuard, async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    const { rows } = await pool.query(`SELECT id, report_type, subject_value FROM scam_reports WHERE id=$1`, [reportId]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const phone = String(req.body.phone || '').trim();
    const relationship = req.body.relationship === 'authorised_rep' ? 'authorised_rep' : 'owner';
    const message = String(req.body.message || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (message.length < 40) return res.status(400).json({ error: 'Explain the dispute in at least 40 characters.' });

    const { rows: inserted } = await pool.query(
      `INSERT INTO report_disputes (report_id, submitter_name, submitter_email, submitter_phone, relationship, message, evidence_path, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING id, created_at`,
      [reportId, name, email, phone || null, relationship, message, req.file ? req.file.filename : null]
    );

    sendToAdmins({
      title: 'New dispute opened',
      body: `${name} disputed report #${reportId} (${rows[0].report_type}).`,
      url: '/admin/deploy/dashboard.html',
    }).catch(() => {});

    sendContactMessageToManagement({
      fromEmail: email,
      message: `Dispute opened on report #${reportId} (${rows[0].report_type}) by ${name} (${relationship}). ${message}`,
    }).catch(() => {});

    res.status(201).json({
      dispute: { id: inserted[0].id, createdAt: inserted[0].created_at },
      message: 'Dispute opened. A first response is promised within three working days and we email the outcome.',
    });
  } catch (err) {
    console.error('dispute failed:', err);
    res.status(400).json({ error: 'dispute_invalid', message: err.message });
  }
});

function requireInt(req, res, next) {
  if (!/^\d+$/.test(req.params.id || '')) return res.status(400).json({ error: 'Invalid ID format.' });
  next();
}

module.exports = router;
