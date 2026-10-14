const API_BASE = 'https://semacheck.onrender.com/api';

// The session token lives in an HttpOnly cookie set by the server — this code
// never sees or stores it, so an XSS bug cannot steal the session.
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }
function setSession(_token, user) {
  // `_token` is ignored on purpose: the cookie carries it.
  if (user) sessionStorage.setItem('semacheck_user', JSON.stringify(user));
}
function clearSession() {
  sessionStorage.removeItem('semacheck_user');
  fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
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
  // Weak-network hardening: retry transient failures and cold-start 502/503
  // with backoff. GETs are always safe to retry; POST/PUT/DELETE are only
  // retried on a network error (request never reached the server).
  const RETRY_DELAYS = [2000, 5000, 10000];
  const safeMethod = !options.method || ['GET', 'HEAD'].includes(options.method.toUpperCase());
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include', cache: 'no-store' });
      if ((res.status === 502 || res.status === 503) && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      break;
    } catch (netErr) {
      if (!safeMethod || attempt >= RETRY_DELAYS.length) {
        throw new Error('Weak or lost connection. Please check your internet and try again.');
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
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
    try {      await api('/auth/signup', { method: 'POST', body: fd });
      otpMode = 'verify-email';
      otpEmail = document.getElementById('adEmail').value.trim();

      showAuth('otp', { message: `Account created. Enter the 6-digit code we emailed to <b>${escapeHtml(otpEmail)}</b>. It expires in 10 minutes. Once verified, our admin team reviews the account — you can create sandbox keys right away and live keys unlock after approval.` });
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
      if (otpMode === 'verify-email') {
        // Log in, then tell the new developer they are in the review queue
        // while the dashboard data loads.
        showAlert('authAlert', 'Email verified — logging you in. New developer accounts are reviewed by our admin team; sandbox keys work immediately.', 'ok');
      }
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
  overviewLoaded = true;
  currentAccount = data.account;

  const setupPanel = document.getElementById('setupPanel');
  const approvalBanner = document.getElementById('approvalBanner');
  const devPending = document.getElementById('devPendingNotice');
  const devSections = document.querySelectorAll('.dev-section');

  if (!data.account) {
    // Not a developer yet: only the organisation-verification signup is
    // shown. Every developer tool lives behind the account.
    setupPanel.style.display = 'block';
    approvalBanner.style.display = 'none';
    if (devPending) devPending.style.display = 'block';
    devSections.forEach((s) => { s.style.display = 'none'; });
    return;
  }
  setupPanel.style.display = 'none';
  if (devPending) devPending.style.display = 'none';
  devSections.forEach((s) => { s.style.display = ''; });

  if (data.account.status === 'pending') {
    approvalBanner.style.display = 'block';
    approvalBanner.className = 'alert alert-ok';
    approvalBanner.innerHTML = data.account.verificationStatus === 'documents_submitted'
      ? '<b>Your organisation documents are under review.</b> Sandbox keys work now — live keys unlock when our team verifies your organisation.'
      : '<b>Your developer account is awaiting approval.</b> You can create sandbox keys and explore the dashboard — live keys go live once our team approves the account.';
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
  document.getElementById('ov-left').textContent = quota ? String(Math.max(0, quota - used)) : 'unlimited (sandbox)';
  document.getElementById('bill-plan').textContent = `${data.account.planName || '—'} — KES ${Number(data.account.planPriceKes || 0).toLocaleString()}/mo`;

  // Renewal countdown — replaces the old "—" placeholder.
  const renewsEl = document.getElementById('ov-renews');
  if (renewsEl) {
    if (data.account.planRenewsOn) {
      const renews = new Date(data.account.planRenewsOn);
      const daysLeft = Math.ceil((renews - Date.now()) / (24 * 60 * 60 * 1000));
      const dateText = renews.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
      if (daysLeft < 0) {
        renewsEl.innerHTML = `Overdue since ${escapeHtml(dateText)} — <b>grace period</b> (7 days) then live keys are suspended`;
        renewsEl.style.color = 'var(--scam-red)';
      } else if (daysLeft <= 7) {
        renewsEl.textContent = `${dateText} — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
        renewsEl.style.color = 'var(--suspicious-amber)';
      } else {
        renewsEl.textContent = `${dateText} — ${daysLeft} days left`;
      }
    } else {
      renewsEl.textContent = 'No renewal (Free sandbox plan)';
    }
  }

  // Organisation verification status.
  const verifEl = document.getElementById('ov-verification');
  if (verifEl) {
    const vs = data.account.verificationStatus || 'unverified';
    const labels = { unverified: 'Not submitted', documents_submitted: 'Documents under review', verified: 'Verified', rejected: 'Rejected — resubmit documents' };
    verifEl.textContent = labels[vs] || vs;
    verifEl.style.color = vs === 'verified' ? 'var(--legit-green)' : (vs === 'rejected' ? 'var(--scam-red)' : '');
  }

  // Free plan can only hold test keys — reflect that in the key form.
  const keyModeEl = document.getElementById('key-mode');
  if (keyModeEl) {
    const liveOpt = keyModeEl.querySelector('option[value="live"]');
    if (liveOpt) liveOpt.disabled = data.account.planCode === 'free';
  }
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
        ${k.mode === 'test' ? '<span class="label-pill label-unverified" style="font-size:0.65rem;">TEST</span>' : '<span class="label-pill label-registered" style="font-size:0.65rem;">LIVE</span>'}
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
    const regNo = document.getElementById('acRegNo').value.trim();
    if (!regNo) { showAlert('setupAlert', 'Enter your business registration number.'); return; }

    // Organisation verification: multipart so the registration document
    // (JPG/PNG/PDF) travels with the application.
    const fd = new FormData();
    fd.append('companyName', document.getElementById('acCompany').value.trim());
    fd.append('registrationNo', regNo);
    fd.append('website', document.getElementById('acWebsite').value.trim());
    fd.append('useCase', document.getElementById('acUseCase').value.trim());
    const docFile = document.getElementById('acBusinessDoc').files[0];
    if (docFile) fd.append('businessDocument', docFile);

    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await api('/account/api/signup', { method: 'POST', body: fd });
      await refresh();
      showAlert('setupAlert', docFile
        ? 'Organisation submitted for verification — our team reviews your registration document. You can create sandbox keys now.'
        : 'Organisation details saved. Upload your registration document so our team can verify it.', 'ok');
    } catch (err) {
      showAlert('setupAlert', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Submit for verification';
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
          mode: document.getElementById('key-mode').value,
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

function waitForPayment(paymentId, timeoutMs = 120000) {
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

async function loadPlans() {
  try {
    const data = await api('/account/api/plans');
    const select = document.getElementById('plan-select');
    const plans = data.plans || [];
    if (plans.length && select) {
      select.innerHTML = plans.map((p) =>
        `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)} — ${p.priceKes ? `KES ${Number(p.priceKes).toLocaleString()}/mo` : 'sandbox keys only'}</option>`
      ).join('');
    }
  } catch { /* plan list is non-critical */ }
}

// Volume-based plan recommendation: monthly checks -> best-value plan.
function initPlanPicker() {
  const slider = document.getElementById('plan-volume');
  const out = document.getElementById('plan-recommendation');
  if (!slider || !out) return;
  const recommend = (n) => {
    if (n <= 0) return 'Free — sandbox keys only, no live checks.';
    if (n <= 2000) return 'Starter (KES 5,000/mo) — 2,000 live checks included.';
    if (n <= 10000) return 'Growth (KES 20,000/mo) — 10,000 live checks, webhooks and batch.';
    return 'Scale (KES 75,000/mo) — 100,000 live checks, 600 req/min. Contact us for higher volume.';
  };
  const update = () => { out.textContent = `${Number(slider.value).toLocaleString()} checks/month → ${recommend(Number(slider.value))}`; };
  slider.addEventListener('input', update);
  update();
}

async function refresh() {
  try {
    await loadOverview();
    await loadKeys();
    await loadInvoices();
    await loadPlans();
  } catch (err) {
    if (err.message && /authenticated|token|expired|log in/i.test(err.message)) {
      clearSession();
      showAuth('login');
    }
  }
}

let overviewLoaded = false;

function boot() {
  // Always start on the Log in / Create account form. There is no token in
  // JS to check (the session rides in an HttpOnly cookie), so we confirm the
  // session with the overview request — and on a cold backend that can take
  // a while. Showing the login form first means a developer always sees
  // where to sign up or log in, immediately; a confirmed session (or a
  // freshly created account) switches to the dashboard automatically.
  showAuth('login');
  refresh().then(() => {
    if (overviewLoaded) showDashboard();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initActions();
  initPlanPicker();
  boot();
});
