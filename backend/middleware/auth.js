
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// The session token rides in an HttpOnly cookie (`semacheck_session`) so it
// is invisible to JavaScript. A Bearer header is still accepted so existing
// integrations and tests keep working.
const SESSION_COOKIE = 'semacheck_session';

function tokenFromCookie(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)semacheck_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : tokenFromCookie(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sessionId) return res.status(401).json({ error: 'Invalid or expired token.' });

    const { rows } = await pool.query(
      `SELECT s.id, s.is_active, s.expires_at, u.id AS user_id, u.account_type, u.email, u.full_name, u.id_verification_status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [payload.sessionId]
    );
    const session = rows[0];
    if (!session || !session.is_active || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or logged out. Please log in again.' });
    }

    req.user = {
      id: session.user_id,
      accountType: session.account_type,
      email: session.email,
      fullName: session.full_name,
      // Lets the frontend tell newly signed-up users their account is
      // still in the admin approval queue.
      idVerificationStatus: session.id_verification_status,
    };
    req.sessionId = session.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireJobOwner(req, res, next) {
  if (req.user?.accountType !== 'job_owner') {
    return res.status(403).json({ error: 'This action is only available to job-owner accounts.' });
  }
  next();
}

// Attaches req.user when a valid token is present, but never rejects:
// guests (no account) continue as guests, and a stale token degrades to one.
async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sessionId) return next();
    const { rows } = await pool.query(
      `SELECT s.id, s.is_active, s.expires_at, u.id AS user_id, u.account_type, u.email, u.full_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [payload.sessionId]
    );
    const session = rows[0];
    if (!session || !session.is_active || new Date(session.expires_at) < new Date()) return next();
    req.user = { id: session.user_id, accountType: session.account_type, email: session.email, fullName: session.full_name };
    req.sessionId = session.id;
    next();
  } catch (err) {
    next();
  }
}

module.exports = { requireAuth, requireJobOwner, optionalAuth };
