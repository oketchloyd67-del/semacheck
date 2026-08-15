// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const {
  isValidEmail, normalizeKenyanPhone, isValidNationalId, isValidKraPin, scorePasswordStrength,
} = require('../utils/validators');
const { uploadIdDocument } = require('../middleware/upload');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '7', 10);

// ---- live-feedback helpers (called as the user types, before submit) ----

router.get('/check-email', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!isValidEmail(email)) return res.json({ valid: false, reason: 'Not a valid email address.' });
  const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (rows[0]) return res.json({ valid: false, reason: 'An account already uses this email.' });
  res.json({ valid: true });
});

router.get('/check-phone', async (req, res) => {
  const normalized = normalizeKenyanPhone(String(req.query.phone || ''));
  if (!normalized) return res.json({ valid: false, reason: 'Enter a valid Safaricom-format number, e.g. 07XXXXXXXX.' });
  const { rows } = await pool.query('SELECT 1 FROM users WHERE phone = $1', [normalized]);
  if (rows[0]) return res.json({ valid: false, reason: 'An account already uses this number.' });
  res.json({ valid: true, normalized, note: 'Format looks valid. This is the number M-Pesa prompts will be sent to when you pay.' });
});

router.post('/password-strength', (req, res) => {
  res.json(scorePasswordStrength(String(req.body.password || '')));
});

// ---- signup ----
//
// Multipart form (not JSON) because it now carries the ID document photo
// alongside the regular fields. uploadIdDocument runs first so req.body
// and req.file are populated by the time the handler runs; on any
// validation failure below, we make sure to delete the file we just
// saved to disk rather than leaving an orphaned upload behind.

router.post('/signup', authLimiter, uploadIdDocument, async (req, res) => {
  const {
    accountType, fullName, email, phone, nationalId, password,
    businessName, businessRegNumber, kraPin,
  } = req.body;
  const consentAccepted = req.body.consentAccepted === 'true' || req.body.consentAccepted === true;
  const idDocumentFile = req.file;

  const cleanupUpload = () => {
    if (idDocumentFile) fs.unlink(idDocumentFile.path, () => {});
  };

  try {
    if (!consentAccepted) {
      cleanupUpload();
      return res.status(400).json({ error: 'You must agree to the Privacy Policy to create an account.' });
    }
    if (!['regular', 'job_owner'].includes(accountType)) {
      cleanupUpload();
      return res.status(400).json({ error: 'accountType must be "regular" or "job_owner".' });
    }
    if (!fullName || fullName.trim().length < 3) { cleanupUpload(); return res.status(400).json({ error: 'Enter your full name.' }); }
    if (!isValidEmail(email)) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid email address.' }); }
    const normalizedPhone = normalizeKenyanPhone(phone);
    if (!normalizedPhone) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid Kenyan phone number.' }); }
    if (!isValidNationalId(nationalId)) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid national ID number (7-9 digits).' }); }
    if (!idDocumentFile) { cleanupUpload(); return res.status(400).json({ error: 'Upload a clear photo or scan of your national ID.' }); }

    const strength = scorePasswordStrength(password || '');
    if (strength.score < 2) {
      cleanupUpload();
      return res.status(400).json({ error: 'Password is too weak.', strength });
    }

    if (accountType === 'job_owner') {
      if (!businessName || businessName.trim().length < 2) { cleanupUpload(); return res.status(400).json({ error: 'Enter your business name.' }); }
      if (!businessRegNumber || businessRegNumber.trim().length < 3) { cleanupUpload(); return res.status(400).json({ error: 'Enter your business registration number.' }); }
      if (!isValidKraPin(kraPin || '')) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid KRA PIN (e.g. A012345678Z).' }); }
    }

    const dupe = await pool.query(
      'SELECT 1 FROM users WHERE email = $1 OR phone = $2 OR national_id = $3',
      [email.trim().toLowerCase(), normalizedPhone, nationalId.trim()]
    );
    if (dupe.rows[0]) {
      cleanupUpload();
      return res.status(409).json({ error: 'An account already exists with this email, phone, or ID number.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO users (account_type, full_name, email, phone, national_id, password_hash, id_document_filename, id_verification_status, business_name, business_reg_number, kra_pin, privacy_consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,now())
       RETURNING id, account_type, full_name, email, phone, id_verification_status, created_at`,
      [
        accountType, fullName.trim(), email.trim().toLowerCase(), normalizedPhone, nationalId.trim(),
        passwordHash, idDocumentFile.filename, businessName || null, businessRegNumber || null, kraPin || null,
      ]
    );
    const user = rows[0];

    res.status(201).json({
      message: 'Account created. Your ID document has been submitted for review — this usually takes under 24 hours. You can log in and use the platform in the meantime.',
      user,
    });
  } catch (err) {
    cleanupUpload();
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

// ---- login ----

router.post('/login', authLimiter, async (req, res) => {
  const { emailOrPhone, password } = req.body;
  try {
    if (!emailOrPhone || !password) return res.status(400).json({ error: 'Enter your email/phone and password.' });

    const normalizedPhone = normalizeKenyanPhone(emailOrPhone);
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $2',
      [String(emailOrPhone).trim().toLowerCase(), normalizedPhone]
    );
    const user = rows[0];

    // Constant-shape response whether or not the user exists, to avoid
    // leaking which emails/phones are registered.
    const dummyHash = '$2a$12$C6UzMDM.H6dfI/f/IKcEeOoJ6/Q3s4v9K1S8kX6qzxKvZ3z6z6z6a';
    const ok = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect credentials.' });

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, req.ip, req.headers['user-agent'] || null, expiresAt]
    );
    const sessionId = sessionRows[0].id;

    const token = jwt.sign({ sessionId, userId: user.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });

    let subscription = null;
    if (user.account_type === 'job_owner') {
      const { rows: subRows } = await pool.query(
        `SELECT status, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      subscription = subRows[0] || null;
    }

    res.json({
      token,
      user: { id: user.id, accountType: user.account_type, fullName: user.full_name, email: user.email },
      subscription,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ---- logout: this is what makes a public/shared computer safe. The
// session row is flipped inactive immediately, so the token in the
// browser (even if someone finds it in history/cache) is worthless. ----

router.post('/logout', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE sessions SET is_active = FALSE, revoked_at = now() WHERE id = $1',
    [req.sessionId]
  );
  res.json({ message: 'Logged out. This device now requires your password again to access the account.' });
});

router.post('/logout-all', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE sessions SET is_active = FALSE, revoked_at = now() WHERE user_id = $1 AND is_active = TRUE',
    [req.user.id]
  );
  res.json({ message: 'Logged out of all devices.' });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
