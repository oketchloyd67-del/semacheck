const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_SECRET = process.env.REPORT_HASH_SALT || '';
const MAX_PER_DAY = 5;
const MAX_PER_HOUR = 2;
const MIN_DESCRIPTION = 40;
const MAX_DESCRIPTION = 2000;

function fingerprint(req) {
  const f = req.headers['x-forwarded-for'] || req.ip || '';
  const ua = (req.headers['user-agent'] || '').slice(0, 120);
  return crypto.createHash('sha256').update(f + ':' + ua + ':' + HASH_SECRET).digest('hex');
}

function parseDescription(body) {
  if (body && typeof body === 'object') {
    if (typeof body.description === 'string') return body.description;
    if (typeof body.msg === 'string') return body.msg;
  }
  return '';
}

function reportAbuseGuard(req, res, next) {
  const fp = fingerprint(req);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(dayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const dayQ = 'SELECT COUNT(*)::int AS n FROM scam_reports WHERE reporter_fingerprint = $1 AND created_at >= $2';
  const hourQ = 'SELECT COUNT(*)::int AS n FROM scam_reports WHERE reporter_fingerprint = $1 AND created_at >= $3';

  Promise.all([pool.query(dayQ, [fp, dayStart]), pool.query(hourQ, [fp, yesterdayStart])]).then(([dayRows, hourRows]) => {
    const dayCount = Number(dayRows.rows[0].n);
    const hourCount = Number(hourRows.rows[0].n);

    if (dayCount >= MAX_PER_DAY || hourCount >= MAX_PER_HOUR) {
      return res.status(429).json({ error: 'throttled', reason: 'Too many reports from this device in 24 hours.' });
    }

    let description = parseDescription(req.body || {});
    if (typeof description !== 'string') description = '';
    description = description.trim();

    if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
      return res.status(400).json({ error: 'invalid_description', min: MIN_DESCRIPTION, max: MAX_DESCRIPTION });
    }

    // Honeypot: reject if a hidden field was ever filled (CSS-shown only).
    const honeypot = req.body && (req.body._report_honeypot === '1' || typeof req.body._report_honeypot === 'string' && req.body._report_honeypot.trim() !== '');
    if (honeypot) {
      return res.sendStatus(204);
    }

    req.reportFingerprint = fp;
    req.reportDescription = description;
    next();
  }).catch((err) => {
    console.error('reportAbuseGuard failed:', err.message);
    next();
  });
}

module.exports = { reportAbuseGuard, fingerprint };
