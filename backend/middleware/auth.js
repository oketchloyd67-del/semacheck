
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');


async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      `SELECT s.id, s.is_active, s.expires_at, u.id AS user_id, u.account_type, u.email, u.full_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [payload.sessionId]
    );
    const session = rows[0];
    if (!session || !session.is_active || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or logged out. Please log in again.' });
    }

    req.user = { id: session.user_id, accountType: session.account_type, email: session.email, fullName: session.full_name };
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

module.exports = { requireAuth, requireJobOwner };
