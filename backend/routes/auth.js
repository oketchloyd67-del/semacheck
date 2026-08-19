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
const { generateOtp, hashOtp, verifyOtp, otpExpiryDate, OTP_MAX_ATTEMPTS } = require('../utils/otp');
const { sendOtpEmail } = require('../services/emailService');
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
    if (!isValidNationalId(nationalId)) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid national ID number (7-8 digits).' }); }
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
    const otp = generateOtp();
    const otpHash = await hashOtp(otp);

    // Only job owners go through manual ID/business review — their
    // approval gates whether their job postings can ever go live.
    // Regular users just search; there's nothing for an admin to approve,
    // so their account starts pre-approved and never enters the review queue.
    const initialVerificationStatus = accountType === 'job_owner' ? 'pending' : 'approved';

    const { rows } = await pool.query(
      `INSERT INTO users (account_type, full_name, email, phone, national_id, password_hash, id_document_filename, id_verification_status, business_name, business_reg_number, kra_pin, privacy_consent_at, otp_code_hash, otp_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)
       RETURNING id, account_type, full_name, email, phone, id_verification_status, created_at`,
      [
        accountType, fullName.trim(), email.trim().toLowerCase(), normalizedPhone, nationalId.trim(),
        passwordHash, idDocumentFile.filename, initialVerificationStatus, businessName || null, businessRegNumber || null, kraPin || null,
        otpHash, otpExpiryDate(),
      ]
    );
    const user = rows[0];

    try {
      await sendOtpEmail({ toEmail: user.email, fullName: user.full_name, code: otp });
    } catch (e) {
      // Account exists either way — surface this honestly so the user
      // can use "resend code" once SMTP is actually configured, instead
      // of being silently stuck.
      return res.status(201).json({
        message: 'Account created, but the verification email could not be sent right now. Use "Resend code" once you\'re ready, or contact support.',
        user,
        requiresOtp: true,
        emailError: e.message,
      });
    }

    res.status(201).json({
      message: `Account created. We've sent a 6-digit verification code to ${user.email} — enter it to activate your account.`,
      user,
      requiresOtp: true,
    });
  } catch (err) {
    cleanupUpload();
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

// ---- email verification (OTP) ----

router.post('/verify-otp', authLimiter, async (req, res) => {
  const { email, code } = req.body;
  try {
    if (!email || !code) return res.status(400).json({ error: 'Enter the code sent to your email.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found for that email.' });
    if (user.email_verified) return res.status(400).json({ error: 'This account is already verified. You can log in.' });

    if (user.otp_attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }
    if (!user.otp_expires_at || new Date(user.otp_expires_at) < new Date()) {
      return res.status(400).json({ error: 'This code has expired. Request a new one.' });
    }

    const ok = await verifyOtp(String(code).trim(), user.otp_code_hash);
    if (!ok) {
      await pool.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1', [user.id]);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    await pool.query(
      `UPDATE users SET email_verified = TRUE, otp_code_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1`,
      [user.id]
    );

    // Smooth UX: log the user straight in now that their email is confirmed,
    // instead of making them re-enter their password immediately after.
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, ip_address, user_agent, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, req.ip, req.headers['user-agent'] || null, expiresAt]
    );
    const token = jwt.sign({ sessionId: sessionRows[0].id, userId: user.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });

    res.json({
      message: 'Email verified! You\'re logged in.',
      token,
      user: { id: user.id, accountType: user.account_type, fullName: user.full_name, email: user.email },
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Could not verify code. Please try again.' });
  }
});

router.post('/resend-otp', authLimiter, async (req, res) => {
  const { email } = req.body;
  try {
    if (!email) return res.status(400).json({ error: 'Enter your email.' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
    const user = rows[0];
    // Same response whether or not the account exists, to avoid leaking registered emails.
    if (!user || user.email_verified) {
      return res.json({ message: 'If that account needs verification, a new code has been sent.' });
    }

    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    await pool.query(
      `UPDATE users SET otp_code_hash = $1, otp_expires_at = $2, otp_attempts = 0 WHERE id = $3`,
      [otpHash, otpExpiryDate(), user.id]
    );
    await sendOtpEmail({ toEmail: user.email, fullName: user.full_name, code: otp });
    res.json({ message: 'If that account needs verification, a new code has been sent.' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Could not resend code. Please try again.' });
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

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.', requiresOtp: true, email: user.email });
    }

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
