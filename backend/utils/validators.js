
const validator = require('validator');


function isValidEmail(email) {
  return typeof email === 'string' && validator.isEmail(email.trim());
}


function normalizeKenyanPhone(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  if (/^(254)(7|1)\d{8}$/.test(p)) return p;
  return null;
}

function isValidKenyanPhone(raw) {
  return normalizeKenyanPhone(raw) !== null;
}


function isValidNationalId(id) {
  return typeof id === 'string' && /^\d{7,9}$/.test(id.trim());
}

function isValidKraPin(pin) {
  return typeof pin === 'string' && /^[A-Za-z]\d{9}[A-Za-z]$/.test(pin.trim());
}


function scorePasswordStrength(password) {
  const pw = password || '';
  let score = 0;
  const feedback = [];

  if (pw.length >= 8) score++; else feedback.push('Use at least 8 characters');
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++; else feedback.push('Mix upper and lower case letters');
  if (/\d/.test(pw)) score++; else feedback.push('Add a number');
  if (/[^A-Za-z0-9]/.test(pw)) score++; else feedback.push('Add a symbol (e.g. ! # $ %)');

  const common = ['password', '12345678', 'qwerty123', 'iloveyou', 'admin123'];
  if (common.some((c) => pw.toLowerCase().includes(c))) {
    score = Math.min(score, 1);
    feedback.push('Avoid common passwords');
  }

  score = Math.max(0, Math.min(4, score - 1)); 
  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score, label: labels[score], feedback };
}

module.exports = {
  isValidEmail,
  normalizeKenyanPhone,
  isValidKenyanPhone,
  isValidNationalId,
  isValidKraPin,
  scorePasswordStrength,
};
