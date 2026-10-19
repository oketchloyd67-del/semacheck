'use strict';
// Operator recovery for the admin panel. Run from the backend directory on the
// server (Render Shell) or locally against DATABASE_URL:
//
//   node db/admin-recovery.js --email you@example.com --disable-2fa
//   node db/admin-recovery.js --email you@example.com --reset-password
//
// Both actions increment session_version, so every existing admin session is
// signed out. The new password is printed once to this console and never
// written to a file or the database in clear text.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { randomPassword } = require('./seedGuard');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || null;
}

async function main() {
  const email = String(arg('--email') || '').trim().toLowerCase();
  const disable2fa = process.argv.includes('--disable-2fa');
  const resetPassword = process.argv.includes('--reset-password');

  if (!email) {
    console.error('Usage: node db/admin-recovery.js --email <admin email> [--disable-2fa] [--reset-password]');
    process.exitCode = 1;
    return;
  }
  if (!disable2fa && !resetPassword) {
    console.error('Nothing to do: pass --disable-2fa and/or --reset-password.');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT id, email FROM admins WHERE email=$1', [email]);
    const admin = rows[0];
    if (!admin) throw new Error('No admin with that email.');

    const updates = ['session_version = session_version + 1'];
    const params = [admin.id];
    if (disable2fa) {
      updates.push('totp_secret = NULL', 'totp_enabled = FALSE', 'totp_enrolled_at = NULL');
    }
    let newPassword = null;
    if (resetPassword) {
      newPassword = randomPassword();
      params.push(await bcrypt.hash(newPassword, 12));
      updates.push(`password_hash = $${params.length}`);
    }

    await client.query(`UPDATE admins SET ${updates.join(', ')} WHERE id=$1`, params);
    await client.query(
      `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, detail)
       VALUES ($1,$2,'admin.recovery', 'admin', $1, $3)`,
      [admin.id, admin.email, JSON.stringify({ disable2fa, resetPassword })]
    );

    console.log('Recovered admin:', admin.email);
    if (disable2fa) console.log('Two-factor cleared — the next sign-in will ask you to enrol again.');
    if (newPassword) console.log('New password (shown once):', newPassword);
    console.log('All existing admin sessions are now invalid.');
  } catch (err) {
    console.error('Recovery failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Recovery crashed:', err.message);
  process.exitCode = 1;
});
