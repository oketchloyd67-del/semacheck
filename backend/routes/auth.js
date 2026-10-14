
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
const { sendOtpEmail, sendPasswordResetEmail } = require('../services/emailService');
const totpService = require('../services/totpService');
const crypto = require('crypto');
const { notifyAccountCreated, notifyAdminsNewUser } = require('../services/pushNotificationService');
const { uploadIdDocument } = require('../middleware/upload');
const fs = require('fs');

const router = express.Router();
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '7', 10);

// Session token travels in an HttpOnly cookie so it is never readable by
// JavaScript — a script injection (XSS) cannot steal it out of storage.
// Browsers still accept Secure cookies on localhost, so the production
// attributes are safe in development too.
const SESSION_COOKIE = 'semacheck_session';
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
}

async function issueSession(req, res, user) {
  const loginIp = req.ip;
  await pool.query(
    `UPDATE users SET last_login_ip = $1, last_login_at = now() WHERE id = $2`,
    [loginIp, user.id]
  );
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO sessions (user_id, ip_address, user_agent, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [user.id, loginIp, req.headers['user-agent'] || null, expiresAt]
  );
  const token = jwt.sign({ sessionId: sessionRows[0].id, userId: user.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  setSessionCookie(res, token);
  let subscription = null;
  if (user.account_type === 'job_owner') {
    const { rows: subRows } = await pool.query(
      `SELECT status, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    subscription = subRows[0] || null;
  }
  return { token, subscription };
}



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
    if (accountType !== 'job_owner') {
      cleanupUpload();
      return res.status(400).json({ error: 'Sign-ups are for job owner accounts. Search without an account, or create an API account from the Developers page.' });
    }
    if (!fullName || fullName.trim().length < 3) { cleanupUpload(); return res.status(400).json({ error: 'Enter your full name.' }); }
    if (fullName.trim().length > 100) { cleanupUpload(); return res.status(400).json({ error: 'Name too long (max 100 characters).' }); }
    if (!isValidEmail(email)) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid email address.' }); }
    if (email.trim().length > 254) { cleanupUpload(); return res.status(400).json({ error: 'Email too long.' }); }
    const normalizedPhone = normalizeKenyanPhone(phone);
    if (!normalizedPhone) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid Kenyan phone number.' }); }
    if (!isValidNationalId(nationalId)) { cleanupUpload(); return res.status(400).json({ error: 'Enter a valid national ID number (7-8 digits).' }); }
    if (nationalId.trim().length > 20) { cleanupUpload(); return res.status(400).json({ error: 'ID number too long.' }); }
    if (accountType === 'job_owner' && !idDocumentFile) { cleanupUpload(); return res.status(400).json({ error: 'Upload a clear photo of your national ID — required for job owner accounts.' }); }

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

    const initialVerificationStatus = accountType === 'job_owner' ? 'pending' : 'approved';

    const { rows } = await pool.query(
      `INSERT INTO users (account_type, full_name, email, phone, national_id, password_hash, id_document_filename, id_verification_status, business_name, business_reg_number, kra_pin, privacy_consent_at, otp_code_hash, otp_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)
       RETURNING id, account_type, full_name, email, phone, id_verification_status, created_at`,
      [
        accountType, fullName.trim(), email.trim().toLowerCase(), normalizedPhone, nationalId.trim(),
        passwordHash, idDocumentFile ? idDocumentFile.filename : null, initialVerificationStatus, businessName || null, businessRegNumber || null, kraPin || null,
        otpHash, otpExpiryDate(),
      ]
    );
    const user = rows[0];

    
    let otpSent = false;
    let emailError = null;

    try {
      const result = await sendOtpEmail({
        toEmail: user.email,
        fullName: user.full_name,
        code: otp
      });
      otpSent = true;
      console.log('OTP email sent successfully to:', user.email);
      console.log('MessageId:', result?.messageId || 'unknown');
    } catch (e) {
      emailError = e.message;
      console.error('OTP email failed:');
      console.error('Error name:', e.name);
      console.error('Error message:', e.message);
    }

    if (otpSent) {
      res.status(201).json({
        message: 'Account created. A verification code has been sent to your email.',
        user,
        requiresOtp: true,
      });
    } else {
      res.status(201).json({
        message: 'Account created, but the verification email could not be sent. Use the "Resend code" option to receive your code.',
        user,
        requiresOtp: true,
        emailError: emailError,
      });
    }
  } catch (err) {
    cleanupUpload();
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});



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

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, ip_address, user_agent, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, req.ip, req.headers['user-agent'] || null, expiresAt]
    );
    const token = jwt.sign({ sessionId: sessionRows[0].id, userId: user.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
    setSessionCookie(res, token);

    res.json({
      message: 'Email verified. You are logged in.',
      token,
      user: { id: user.id, accountType: user.account_type, fullName: user.full_name, email: user.email },
    });

    // Fire-and-forget: send welcome push notification
    notifyAccountCreated(user.id, user.full_name).catch(() => {});
    // Fire-and-forget: notify admins of new registration
    notifyAdminsNewUser(user.full_name, user.account_type, user.email).catch(() => {});
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
    const needsCode = user && (!user.email_verified || user.requires_reverification);
    if (!user || !needsCode) {
      return res.json({ message: 'If that account needs verification, a new code has been sent.' });
    }

    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    await pool.query(
      `UPDATE users SET otp_code_hash = $1, otp_expires_at = $2, otp_attempts = 0 WHERE id = $3`,
      [otpHash, otpExpiryDate(), user.id]
    );
    
    try {
      await sendOtpEmail({ toEmail: user.email, fullName: user.full_name, code: otp });
      console.log('Resend OTP sent to:', user.email);
      res.json({ message: 'A new verification code has been sent to your email.' });
    } catch (emailError) {
      console.error('Resend OTP email failed:', emailError.message);
      res.json({ 
        message: 'Could not send the email right now. Please try again later or contact support.',
        warning: emailError.message
      });
    }
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Could not resend code. Please try again.' });
  }
});



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

    const dummyHash = '$2a$12$C6UzMDM.H6dfI/f/IKcEeOoJ6/Q3s4v9K1S8kX6qzxKvZ3z6z6z6a';
    const ok = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect credentials.' });

    if (user.disabled_at) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact support if you believe this is a mistake.' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.', requiresOtp: true, email: user.email });
    }

    // OTP required when the login comes from a new location or a new device.
    const loginIp = req.ip;
    const loginUa = req.headers['user-agent'] || '';
    if (user.last_login_at && user.last_login_ip) {
      const locationChanged = user.last_login_ip !== loginIp;
      let deviceChanged = false;
      try {
        const { rows: prior } = await pool.query(
          `SELECT user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [user.id]
        );
        deviceChanged = Boolean(prior[0] && prior[0].user_agent) && prior[0].user_agent !== loginUa;
      } catch (e) { /* fall back to location-only check */ }

      if (locationChanged || deviceChanged) {
        const otp = generateOtp();
        const otpHash = await hashOtp(otp);
        await pool.query(
          `UPDATE users SET requires_reverification = TRUE, otp_code_hash = $1, otp_expires_at = $2, otp_attempts = 0 WHERE id = $3`,
          [otpHash, otpExpiryDate(), user.id]
        );
        let sent = false;
        try {
          await sendOtpEmail({ toEmail: user.email, fullName: user.full_name, code: otp });
          sent = true;
        } catch (e) {
          console.error('Location re-verification OTP email failed:', e.message);
        }
        return res.status(403).json({
          error: 'This login is from a new location or device. Enter the 6-digit code we emailed you to confirm it is you.',
          requiresLocationReverify: true,
          email: user.email,
          emailSent: sent,
        });
      }
    }

    if (user.totp_enabled_at && user.totp_secret) {
      const twoFactorToken = jwt.sign({ userId: user.id, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: '10m' });
      return res.json({ requires2fa: true, twoFactorToken });
    }

    const { token, subscription } = await issueSession(req, res, user);

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



router.post('/reverify-location', authLimiter, async (req, res) => {
  const { email, code } = req.body;
  try {
    if (!email || !code) return res.status(400).json({ error: 'Enter the code sent to your email.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found.' });
    if (!user.requires_reverification) return res.status(400).json({ error: 'No re-verification needed.' });

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

    const loginIp = req.ip;
    await pool.query(
      `UPDATE users SET requires_reverification = FALSE, otp_code_hash = NULL, otp_expires_at = NULL, otp_attempts = 0, last_login_ip = $1, last_login_at = now() WHERE id = $2`,
      [loginIp, user.id]
    );

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, ip_address, user_agent, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, loginIp, req.headers['user-agent'] || null, expiresAt]
    );
    const token = jwt.sign({ sessionId: sessionRows[0].id, userId: user.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
    setSessionCookie(res, token);

    let subscription = null;
    if (user.account_type === 'job_owner') {
      const { rows: subRows } = await pool.query(
        `SELECT status, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      subscription = subRows[0] || null;
    }

    res.json({
      message: 'Location verified. You are logged in.',
      token,
      user: { id: user.id, accountType: user.account_type, fullName: user.full_name, email: user.email },
      subscription,
    });
  } catch (err) {
    console.error('Re-verify location error:', err);
    res.status(500).json({ error: 'Could not verify. Please try again.' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE sessions SET is_active = FALSE, revoked_at = now(), expires_at = now() WHERE id = $1`,
    [req.sessionId]
  );
  clearSessionCookie(res);
  res.json({ message: 'Logged out. This device now requires your password again to access the account.' });
});

router.post('/logout-all', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE sessions SET is_active = FALSE, revoked_at = now(), expires_at = now() WHERE user_id = $1 AND is_active = TRUE`,
    [req.user.id]
  );
  clearSessionCookie(res);
  res.json({ message: 'Logged out of all devices.' });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  const generic = { message: 'If an account exists for that email, a password reset link is on its way.' };
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.json(generic);
    const { rows } = await pool.query(
      'SELECT id, full_name, email FROM users WHERE email = $1 AND disabled_at IS NULL',
      [email]
    );
    const user = rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query(
        `DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at < now()`,
        [user.id]
      );
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')`,
        [user.id, tokenHash]
      );
      const base = process.env.FRONTEND_URL || 'https://semacheck.vercel.app';
      const resetUrl = `${base}/reset-password.html?token=${token}`;
      sendPasswordResetEmail({ toEmail: user.email, fullName: user.full_name, resetUrl })
        .catch((e) => console.error('Password reset email failed:', e.message));
    }
  } catch (err) {
    console.error('forgot-password error:', err.message);
  }
  res.json(generic);
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || typeof token !== 'string' || token.length < 32) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    const rec = rows[0];
    if (!rec || rec.used_at || new Date(rec.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }
    const strength = scorePasswordStrength(password || '');
    if (strength.score < 2) {
      return res.status(400).json({ error: 'Password is too weak.', strength });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
      [rec.user_id, passwordHash]
    );
    await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [rec.id]);
    await pool.query(
      `UPDATE sessions SET is_active = FALSE, revoked_at = now(), expires_at = now() WHERE user_id = $1 AND is_active = TRUE`,
      [rec.user_id]
    );
    res.json({ message: 'Password updated. Log in with your new password.' });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Could not reset the password. Please try again.' });
  }
});

router.post('/2fa/verify', authLimiter, async (req, res) => {
  try {
    const { twoFactorToken, code } = req.body;
    if (!twoFactorToken || !code) return res.status(400).json({ error: 'Enter the 6-digit code from your authenticator app.' });
    let payload;
    try {
      payload = jwt.verify(twoFactorToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Your login attempt expired. Start again.' });
    }
    if (payload.purpose !== '2fa') return res.status(401).json({ error: 'Invalid request.' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = rows[0];
    if (!user || !user.totp_secret || !user.totp_enabled_at) return res.status(401).json({ error: 'Two-factor authentication is not enabled for this account.' });
    if (!totpService.verify(user.totp_secret, code)) {
      return res.status(401).json({ error: 'That code is not correct. Codes refresh every 30 seconds.' });
    }
    const { token, subscription } = await issueSession(req, res, user);
    res.json({
      token,
      user: { id: user.id, accountType: user.account_type, fullName: user.full_name, email: user.email },
      subscription,
    });
  } catch (err) {
    console.error('2fa verify error:', err);
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1', [req.user.id]);
    if (rows[0].totp_enabled_at) {
      return res.status(400).json({ error: 'Two-factor authentication is already enabled. Turn it off first.' });
    }
    let secret = rows[0].totp_secret;
    if (!secret) {
      secret = totpService.generateSecret();
      await pool.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [req.user.id, secret]);
    }
    res.json({ secret, otpauthUrl: totpService.otpauthUri(secret, req.user.email) });
  } catch (err) {
    console.error('2fa setup error:', err);
    res.status(500).json({ error: 'Could not start two-factor setup.' });
  }
});

router.post('/2fa/enable', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (user.totp_enabled_at) return res.status(400).json({ error: 'Two-factor authentication is already enabled.' });
    if (!user.totp_secret) return res.status(400).json({ error: 'Start the setup first.' });
    if (!totpService.verify(user.totp_secret, code)) {
      return res.status(400).json({ error: 'That code is not correct. Check your authenticator app and try again.' });
    }
    await pool.query('UPDATE users SET totp_enabled_at = now(), updated_at = now() WHERE id = $1', [req.user.id]);
    res.json({ message: 'Two-factor authentication is now on. You will need the app each time you log in.' });
  } catch (err) {
    console.error('2fa enable error:', err);
    res.status(500).json({ error: 'Could not enable two-factor authentication.' });
  }
});

router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user.totp_enabled_at) return res.status(400).json({ error: 'Two-factor authentication is not enabled.' });
    if (!totpService.verify(user.totp_secret, code)) {
      return res.status(400).json({ error: 'That code is not correct.' });
    }
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = now() WHERE id = $1', [req.user.id]);
    res.json({ message: 'Two-factor authentication turned off.' });
  } catch (err) {
    console.error('2fa disable error:', err);
    res.status(500).json({ error: 'Could not disable two-factor authentication.' });
  }
});

router.get('/2fa/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT totp_enabled_at FROM users WHERE id = $1', [req.user.id]);
  res.json({ enabled: Boolean(rows[0] && rows[0].totp_enabled_at) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Enter your current password and a new password.' });
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Your current password is not correct.' });
    const strength = scorePasswordStrength(String(newPassword));
    if (strength.score < 2) return res.status(400).json({ error: 'The new password is too weak.', strength });
    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, passwordHash]);
    await pool.query(
      `UPDATE sessions SET is_active = FALSE, revoked_at = now(), expires_at = now() WHERE user_id = $1 AND is_active = TRUE AND id <> $2`,
      [req.user.id, req.sessionId]
    );
    res.json({ message: 'Password changed. Other devices have been signed out.' });
  } catch (err) {
    console.error('change-password error:', err);
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

module.exports = router;