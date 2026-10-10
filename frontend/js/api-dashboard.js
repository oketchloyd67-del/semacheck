const API_BASE = 'https://semacheck.onrender.com/api';

function getToken() { return sessionStorage.getItem('semacheck_token'); }
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }
function setSession(token, user) {
  sessionStorage.setItem('semacheck_token', token);
  sessionStorage.setItem('semacheck_user', JSON.stringify(user));
}
function clearSession() {
  sessionStorage.removeItem('semacheck_token');
  sessionStorage.removeItem('semacheck_user');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showAlert(el, message, kind = 'err') {
  const box = typeof el === 'string' ? document.getElementById(el) : el;
  if (!box) return;
  box.innerHTML = message ? `<div class="alert alert-${kind}">${escapeHtml(message)}</div>` : '';
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data.error || data.message || 'Something went wrong.');
    Object.assign(err, data);
    throw err;
  }
  return data;
}

// ── View switching ─────────────────────────────────────────────────
function showAuth(mode = 'login', otpContext = null) {
  document.getElementById('authPanel').style.display = 'block';
  document.getElementById('dashboardPanel').style.display = 'none';
  document.getElementById('loginForm').style.display = mode === 'login' ? 'block' : 'none';
  document.getElementById('signupForm').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('otpForm').style.display = mode === 'otp' ? 'block' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabSignup').classList.toggle('active', mode === 'signup');
  if (mode === 'otp' && otpContext) {
    document.getElementById('otpMsg').innerHTML = otpContext.message;
    document.getElementById('adOtpResend').style.display = 'inline';
  }
}

function showDashboard() {
  document.getElementById('authPanel').style.display = 'none';
  document.getElementById('dashboardPanel').style.display = 'block';
}

let otpMode = 'verify-email'; // 'verify-email' | 'reverify-location'
let otpEmail = null;

// ── Auth: login / signup / OTP ─────────────────────────────────────
function initAuth() {
  document.getElementById('tabLogin').addEventListener('click', () => { showAlert('authAlert', ''); showAuth('login'); });
  document.getElementById('tabSignup').addEventListener('click', () => { showAlert('authAlert', ''); showAuth('signup'); });

  document.getElementById('adLoginBtn').addEventListener('click', async () => {
    const btn = document.getElementById('adLoginBtn');
    showAlert('authAlert', '');
    btn.disabled = true; btn.textContent = 'Logging in…';
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          emailOrPhone: document.getElementById('adLoginId').value.trim(),
          password: document.getElementById('adLoginPassword').value,
        }),
      });
      setSession(r.token, r.user);
      boot();
    } catch (err) {
      if (err.requiresOtp) {
        otpMode = 'verify-email';
        otpEmail = err.email || document.getElementById('adLoginId').value.trim();
        showAlert('authAlert', '');
        showAuth('otp', { message: `Verify your email to continue. Enter the 6-digit code sent to <b>${escapeHtml(otpEmail)}</b>.` });
      } else if (err.requiresLocationReverify) {
        otpMode = 'reverify-location';
        otpEmail = err.email || document.getElementById('adLoginId').value.trim();
        showAlert('authAlert', '');
        showAuth('otp', { message: escapeHtml(err.message) + ` Code sent to <b>${escapeHtml(otpEmail)}</b>.` });
      } else {
        showAlert('authAlert', err.message);
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Log in';
    }
  });

  document.getElementById('adSignupBtn').addEventListener('click', async () => {
    const btn = document.getElementById('adSignupBtn');
    showAlert('authAlert', '');
    const consent = document.getElementById('adConsent');
    if (!consent.checked) { showAlert('authAlert', 'You need to agree to the Privacy Policy to create an account.'); return; }

    const fd = new FormData();
    fd.append('accountType', 'regular');
    fd.append('fullName', document.getElementById('adFullName').value.trim());
    fd.append('email', document.getElementById('adEmail').value.trim());
    fd.append('phone', document.getElementById('adPhone').value.trim());
    fd.append('nationalId', document.getElementById('adNationalId').value.trim());
    fd.append('password', document.getElementById('adPassword').value);
    fd.append('consentAccepted', 'true');

    btn.disabled = true; btn.textContent = 'Creating account…';
    try {
      await api('/auth/signup', { method: 'POST', body: fd });
      otpMode = 'verify-email';
      otpEmail = document.getElementById('adEmail').value.trim();
      showAuth('otp', { message: `Account created. Enter the 6-digit code we emailed to <b>${escapeHtml(otpEmail)}</b>. It expires in 10 minutes.` });
    } catch (err) {
      showAlert('authAlert', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Create account';
    }
  });

  document.getElementById('adOtpBtn').addEventListener('click', async () => {
    const btn = document.getElementById('adOtpBtn');
    showAlert('authAlert', '');
    const code = document.getElementById('adOtpCode').value.trim();
    if (!code) { showAlert('authAlert', 'Enter the 6-digit code.'); return; }
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const r = otpMode === 'reverify-location'
        ? await api('/auth/reverify-location', { method: 'POST', body: JSON.stringify({ email: otpEmail, code }) })
        : await api('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email: otpEmail, code }) });
      setSession(r.token, r.user);
      document.getElementById('adOtpCode').value = '';
      boot();
    } catch (err) {
      showAlert('authAlert', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Verify & continue';
    }
  });

  document.getElementById('adOtpResend').addEventListener('click', async () => {
    try {
      const r = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: otpEmail }) });
      showAlert('authAlert', r.message, 'ok');
    } catch (err) {
      showAlert('authAlert', err.message);
    }
  });
}

// ── Dashboard data ─────────────────────────────────────────────────
let currentAccount = null;

async function loadOverview() {
  const data = await api('/account/api/overview');
  currentAccount = data.account;

  const setupPanel = document.getElementById('setupPanel');
  const approvalBanner = document.getElementById('approvalBanner');

  if (!data.account) {
    setupPanel.style.display = 'block';
    approvalBanner.style.display = 'none';
    return;
  }
  setupPanel.style.display = 'none';

  if (data.account.status === 'pending') {
    approvalBanner.style.display = 'block';
    approvalBanner.className = 'alert alert-ok';
    approvalBanner.innerHTML = '<b>Your API account is awaiting admin approval.</b> You can create keys and explore the dashboard — keys go live once our team approves the account.';
  } else if (data.account.status === 'suspended' || data.account.status === 'closed') {
    approvalBanner.style.display = 'block';
    approvalBanner.className = 'alert alert-err';
    approvalBanner.innerHTML = `This API account is <b>${escapeHtml(data.account.status)}</b>. Contact support via the <a href="index.html#contact" style="color:var(--teal);font-weight:700;">contact form</a>.`;
  } else {
    approvalBanner.style.display = 'none';
  }

  const quota = Number(data.account.monthlyQuota) || 0;
  const period = new Date().toISOString().slice(0, 7);
  const usageRows = Array.isArray(data.usage) ? data.usage : [];
  const thisMonth = usageRows.find((u) => u.period === period) || usageRows[0];
  const used = Number(thisMonth && thisMonth.checks_used) || 0;

  document.getElementById('ov-plan').textContent = `${data.account.planName || data.account.planCode || '—'} (${data.account.status})`;
  document.getElementById('ov-used').textContent = String(used);
  document.getElementById('ov-left').textContent = quota ? String(Math.max(0, quota - used)) : '—';
  document.getElementById('bill-plan').textContent = `${data.account.planName || '—'} — KES ${Number(data.account.planPriceKes || 0).toLocaleString()}/mo`;
}

async function loadKeys() {
  const data = await api('/account/api/keys');
  const keys = data.keys || [];
  document.getElementById('ov-keys').textContent = String(keys.filter((k) => k.status === 'active').length);

  const list = document.getElementById('key-list');
  if (!keys.length) {
    list.innerHTML = '<li class="hint">No keys yet — create one above.</li>';
    return;
  }
  list.innerHTML = keys.map((k) => `
    <li style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap;">
      <span>
        <b>${escapeHtml(k.label || 'key')}</b>
        <span class="hint">${escapeHtml(k.key_type)} · ${escapeHtml(k.key_prefix)}…</span>
        ${k.status === 'active'
          ? '<span class="label-pill label-registered" style="font-size:0.65rem;">ACTIVE</span>'
          : '<span class="label-pill label-unverified" style="font-size:0.65rem;">REVOKED</span>'}
      </span>
      ${k.status === 'active' ? `<button class="btn btn-ghost" data-revoke="${k.id}" style="padding:5px 10px; font-size:0.75rem;">Revoke</button>` : ''}
    </li>`).join('');

  list.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/account/api/keys/${b.dataset.revoke}`, { method: 'DELETE' });
      loadKeys();
    } catch (err) { showAlert('keyAlert', err.message); }
  }));
}

async function loadInvoices() {
  try {
    const data = await api('/account/api/invoices');
    const invoices = data.invoices || [];
    const period = new Date().toISOString().slice(0, 7);
    const thisMonth = invoices.filter((i) => i.period === period);
    document.getElementById('bill-invoices').textContent = thisMonth.length
      ? thisMonth.map((i) => `KES ${Number(i.amount_kes).toLocaleString()} (${i.status})`).join(' · ')
      : 'None yet';
  } catch { /* billing panel is non-critical */ }
}

// ── Actions ────────────────────────────────────────────────────────
function initActions() {
  document.getElementById('acCreateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('acCreateBtn');
    showAlert('setupAlert', '');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await api('/account/api/signup', {
        method: 'POST',
        body: JSON.stringify({
          companyName: document.getElementById('acCompany').value.trim(),
          website: document.getElementById('acWebsite').value.trim(),
          useCase: document.getElementById('acUseCase').value.trim(),
        }),
      });
      await refresh();
      showAlert('setupAlert', 'API account created. It is waiting for admin approval.', 'ok');
    } catch (err) {
      showAlert('setupAlert', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Create API account';
    }
  });

  document.getElementById('btn-new-key').addEventListener('click', async () => {
    showAlert('keyAlert', '');
    try {
      const r = await api('/account/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          label: document.getElementById('key-label').value.trim() || 'Main key',
          type: document.getElementById('key-type').value,
        }),
      });
      if (r.key && r.key.raw) {
        document.getElementById('newKeyValue').textContent = r.key.raw;
        document.getElementById('newKeyBox').style.display = 'block';
      }
      document.getElementById('key-label').value = '';
      await loadKeys();
    } catch (err) { showAlert('keyAlert', err.message); }
  });

  document.getElementById('copyKeyBtn').addEventListener('click', async () => {
    const value = document.getElementById('newKeyValue').textContent;
    try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
  });

  document.getElementById('btn-playground').addEventListener('click', async () => {
    const btn = document.getElementById('btn-playground');
    const checkType = document.getElementById('pg-type').value.trim();
    const subject = document.getElementById('pg-subject').value.trim();
    if (!checkType || !subject) { showAlert('pg-result', ''); document.getElementById('pg-result').textContent = 'Enter a checkType and a subject.'; return; }

    btn.disabled = true; btn.textContent = 'Checking…';
    document.getElementById('pg-verdict').style.display = 'none';
    document.getElementById('pg-result').textContent = '';
    try {
      const r = await api('/account/api/playground', { method: 'POST', body: JSON.stringify({ checkType, subject }) });

      // Verdict front and centre — word, confidence and summary are always visible.
      const colors = { reported: 'var(--scam-red)', caution: 'var(--suspicious-amber)', registered: 'var(--legit-green)', unverified: 'var(--text-muted)', scam: 'var(--scam-red)', suspicious: 'var(--suspicious-amber)', legit: 'var(--legit-green)' };
      const word = (r.displayVerdict || r.verdict || 'unknown');
      const verdictBox = document.getElementById('pg-verdict');
      verdictBox.style.display = 'block';
      const wordEl = document.getElementById('pg-verdict-word');
      wordEl.textContent = String(word).toUpperCase();
      wordEl.style.color = colors[r.verdict] || 'var(--navy)';
      document.getElementById('pg-verdict-confidence').textContent = r.confidence != null ? `${r.confidence}% confidence` : '';
      document.getElementById('pg-verdict-summary').textContent = r.summary || '';

      document.getElementById('pg-result').textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      document.getElementById('pg-result').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Run check';
    }
  });

  document.getElementById('btn-change-plan').addEventListener('click', async () => {
    const btn = document.getElementById('btn-change-plan');
    const alertBox = 'billingAlert';
    showAlert(alertBox, '');
    const planCode = document.getElementById('plan-select').value;
    btn.disabled = true; btn.textContent = 'Processing…';
    try {
      const r = await api('/account/api/plan', { method: 'POST', body: JSON.stringify({ planCode }) });
      if (r.paymentId) {
        showAlert(alertBox, 'M-Pesa STK push sent — enter your PIN on your phone to activate the plan. Waiting for confirmation…', 'ok');
        const confirmed = await waitForPayment(r.paymentId);
        if (confirmed === 'success') {
          showAlert(alertBox, 'Payment confirmed — your plan is now active.', 'ok');
        } else if (confirmed === 'failed') {
          showAlert(alertBox, 'The M-Pesa payment failed or was cancelled. Your plan was not changed.');
        } else {
          showAlert(alertBox, 'Still waiting for M-Pesa confirmation. Refresh this page in a minute to see your plan.');
        }
      } else {
        showAlert(alertBox, r.message || 'Plan updated.', 'ok');
      }
      await refresh();
    } catch (err) {
      showAlert(alertBox, err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Change plan';
    }
  });

  document.getElementById('btn-save-webhook').addEventListener('click', async () => {
    showAlert('webhookAlert', '');
    try {
      await api('/account/api/webhook', {
        method: 'PUT',
        body: JSON.stringify({
          url: document.getElementById('wh-url').value.trim(),
          secret: document.getElementById('wh-secret').value,
        }),
      });
      showAlert('webhookAlert', 'Webhook saved.', 'ok');
    } catch (err) { showAlert('webhookAlert', err.message); }
  });

  document.getElementById('btn-test-webhook').addEventListener('click', async () => {
    try {
      const r = await api('/account/api/webhook/test', { method: 'POST', body: JSON.stringify({}) });
      document.getElementById('wh-result').textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      document.getElementById('wh-result').textContent = err.message;
    }
  });
}

function waitForPayment(paymentId, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve('timeout'); return; }
      try {
        const status = await api(`/payments/status/${paymentId}`);
        if (status.status === 'success') { clearInterval(timer); resolve('success'); }
        else if (status.status === 'failed' || status.status === 'cancelled') { clearInterval(timer); resolve('failed'); }
      } catch { /* keep polling */ }
    }, 2500);
  });
}

async function refresh() {
  try {
    await loadOverview();
    await loadKeys();
    await loadInvoices();
  } catch (err) {
    if (err.message && /authenticated|token|expired/i.test(err.message)) {
      clearSession();
      showAuth('login');
    }
  }
}

function boot() {
  if (!getToken()) { showAuth('login'); return; }
  showDashboard();
  refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initActions();
  boot();
});
