





const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.type !== 'admin') return res.status(401).json({ error: 'Invalid admin token.' });

    const { rows } = await pool.query('SELECT id, full_name, email FROM admins WHERE id = $1', [payload.adminId]);
    if (!rows[0]) return res.status(401).json({ error: 'Admin account not found.' });

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin token.' });
  }
}

module.exports = { requireAdmin };
