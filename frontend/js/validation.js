// js/validation.js
// Mirrors backend/utils/validators.js scorePasswordStrength() so the
// meter updates instantly as the user types, without waiting on a
// network round trip. The backend re-checks everything on submit
// regardless — this is purely for responsive UX.

function scorePasswordStrengthClient(pw) {
  pw = pw || '';
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
  const colors = ['#D6455C', '#E0A227', '#E0A227', '#0FA3A3', '#23A46A'];
  return { score, label: labels[score], feedback, color: colors[score] };
}

function renderStrengthMeter(pw) {
  const { score, label, feedback, color } = scorePasswordStrengthClient(pw);
  const bars = document.querySelectorAll('#strengthBar > div');
  bars.forEach((bar, i) => { bar.style.background = i <= score ? color : '#E2E8F0'; });
  const labelEl = document.getElementById('strengthLabel');
  if (labelEl) { labelEl.textContent = pw ? label : ''; labelEl.style.color = color; }
  const fbEl = document.getElementById('strengthFeedback');
  if (fbEl) fbEl.textContent = pw && feedback.length ? feedback.join(' · ') : '';
  return score;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function normalizeKenyanPhoneClient(raw) {
  if (!raw) return null;
  let p = raw.replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0') && p.length === 10) p = '254' + p.slice(1);
  return /^(254)(7|1)\d{8}$/.test(p) ? p : null;
}

function isValidEmailClient(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}
