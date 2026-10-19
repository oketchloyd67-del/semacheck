'use strict';
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const ADMIN_ROLES = ['super_admin', 'reviewer', 'support'];

// Every token carries the admin's session_version. Changing a password (or
// using the recovery script) increments that column, which invalidates every
// token issued before the change — including one leaked in a chat or email.
async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.type !== 'admin' || !payload.adminId) return res.status(401).json({ error: 'Invalid admin token.' });

    const { rows } = await pool.query(
      'SELECT id, full_name, email, role, session_version, totp_enabled FROM admins WHERE id = $1',
      [payload.adminId]
    );
    const admin = rows[0];
    if (!admin) return res.status(401).json({ error: 'Admin account not found.' });

    if (Number(payload.sv) !== Number(admin.session_version)) {
      return res.status(401).json({ error: 'Your session token ended because the account credentials changed. Please sign in again.' });
    }
    // Two-factor is mandatory: tokens are only issued after enrolment.
    if (!admin.totp_enabled) {
      return res.status(401).json({ error: 'Two-factor authentication is required. Please sign in again to complete enrolment.' });
    }

    req.admin = {
      id: admin.id,
      full_name: admin.full_name,
      email: admin.email,
      role: ADMIN_ROLES.includes(admin.role) ? admin.role : 'support',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin token.' });
  }
}

// Route-level permission gate. Reviewers can do verification/queue work but
// cannot change plans or settings; support can retry webhooks but cannot
// approve identity documents or move money.
function requireRole(...roles) {
  const allowed = roles.flat().filter((r) => ADMIN_ROLES.includes(r));
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Not authenticated.' });
    if (!allowed.includes(req.admin.role)) {
      return res.status(403).json({
        error: `Your role (${req.admin.role.replace('_', ' ')}) cannot perform this action.`,
        requiredRoles: allowed,
      });
    }
    next();
  };
}

module.exports = { requireAdmin, requireRole, ADMIN_ROLES };
