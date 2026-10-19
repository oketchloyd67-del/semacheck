'use strict';
// Append-only audit trail for the admin panel. Logging must never make the
// privileged action itself fail: an audit insert error is reported to the
// server log, and the action proceeds.

const pool = require('../db/pool');

function clientIp(req) {
  if (!req) return null;
  const value = req.headers?.['cf-connecting-ip']
    || req.headers?.['x-real-ip']
    || req.ip
    || req.socket?.remoteAddress
    || null;
  return value ? String(value).slice(0, 64) : null;
}

async function logAdminAction(req, action, options = {}) {
  const admin = req && req.admin;
  const { targetType = null, targetId = null, detail = null } = options;
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        admin?.id || null,
        admin?.email || null,
        String(action).slice(0, 60),
        targetType ? String(targetType).slice(0, 40) : null,
        targetId !== null && targetId !== undefined ? String(targetId).slice(0, 80) : null,
        detail ? JSON.stringify(detail) : null,
        clientIp(req),
      ]
    );
  } catch (err) {
    console.error('[audit] could not record action:', action, err.message);
  }
}

async function logLoginAttempt(req, { email, ok, reason = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_login_attempts (email, ok, reason, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        email ? String(email).trim().toLowerCase().slice(0, 150) : null,
        Boolean(ok),
        reason ? String(reason).slice(0, 40) : null,
        clientIp(req),
        req?.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null,
      ]
    );
  } catch (err) {
    console.error('[audit] could not record login attempt:', err.message);
  }
}

module.exports = { logAdminAction, logLoginAttempt, clientIp };
