const API_BASE = 'https://semacheck.onrender.com/api';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('report-form');
  const progress = document.getElementById('report-progress');
  const alertBox = document.getElementById('reportAlert');
  const descInput = document.getElementById('r-desc');
  const descHint = document.getElementById('r-desc-hint');
  const fileInput = document.getElementById('r-ev-file');
  const submitBtn = document.getElementById('r-submit');

  form.style.display = 'block';

  // Prefill from the receipt's "Report this" button: ?type=phone&value=07...
  try {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('type');
    const value = params.get('value');
    if (type) {
      const opt = document.querySelector(`#r-type option[value="${CSS.escape(type)}"]`);
      if (opt) document.getElementById('r-type').value = type;
    }
    if (value) document.getElementById('r-subject').value = value;
  } catch { /* ignore bad query strings */ }

  descInput.addEventListener('input', () => {
    const len = descInput.value.trim().length;
    if (len === 0) { descHint.textContent = 'Aim for at least 40 characters — dates, amounts and how you were contacted.'; descHint.style.color = ''; }
    else if (len < 40) { descHint.textContent = `${len}/40 characters — add a little more detail.`; descHint.style.color = 'var(--suspicious-amber)'; }
    else { descHint.textContent = `${len} characters ✓`; descHint.style.color = 'var(--legit-green)'; }
  });
  descInput.dispatchEvent(new Event('input'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';

    const subject = document.getElementById('r-subject').value.trim();
    const description = descInput.value.trim();
    const file = fileInput.files[0];

    if (!subject) {
      alertBox.innerHTML = '<div class="alert alert-err">Enter the subject you are reporting.</div>';
      return;
    }
    if (description.length < 40) {
      alertBox.innerHTML = '<div class="alert alert-err">Describe what happened in at least 40 characters.</div>';
      return;
    }
    if (!file) {
      alertBox.innerHTML = '<div class="alert alert-err">Evidence is required — attach a screenshot, message or payment confirmation. Reports without evidence are not reviewed.</div>';
      fileInput.focus();
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      alertBox.innerHTML = '<div class="alert alert-err">Evidence file must be under 8MB.</div>';
      return;
    }
    if (!document.getElementById('r-consent').checked) {
      alertBox.innerHTML = '<div class="alert alert-err">Tick the consent box so we can review and publish your report in masked form.</div>';
      return;
    }

    const fd = new FormData();
    fd.append('checkType', document.getElementById('r-type').value);
    fd.append('subject', subject);
    fd.append('description', description);
    fd.append('consent', 'true');
    const honeypot = document.getElementById('r-website-check').value.trim();
    if (honeypot) fd.append('contact_website', honeypot);
    const amount = document.getElementById('r-amount').value;
    if (amount) fd.append('amountLostKes', amount);
    const email = document.getElementById('r-email').value.trim();
    if (email) fd.append('reporterEmail', email);
    fd.append('evidence', file);

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const headers = {};
      try {
        const token = sessionStorage.getItem('semacheck_token');
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch { /* storage unavailable */ }

      const res = await fetch(`${API_BASE}/reports`, { method: 'POST', headers, body: fd, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Could not submit the report.');

      form.style.display = 'none';
      progress.style.display = 'block';
      document.getElementById('rp-ref').textContent = `Report received — reference #${data.report?.id ?? ''}`;
      progress.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
      alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit report';
    }
  });
});
