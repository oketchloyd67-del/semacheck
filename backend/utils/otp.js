// utils/otp.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_BCRYPT_COST = 8; // lower than password cost (12) — OTPs are short-lived, low-value, and hashed/checked far more frequently

function generateOtp() {
  // Cryptographically random 6-digit code, zero-padded.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(OTP_LENGTH, '0');
}

async function hashOtp(code) {
  return bcrypt.hash(code, OTP_BCRYPT_COST);
}

async function verifyOtp(code, hash) {
  if (!hash) return false;
  return bcrypt.compare(code, hash);
}

function otpExpiryDate() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

module.exports = { generateOtp, hashOtp, verifyOtp, otpExpiryDate, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS };
