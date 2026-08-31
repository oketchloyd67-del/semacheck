const API_BASE = 'https://semacheck.onrender.com/api';

async function loadRecentScamsTicker() {
  const container = document.getElementById('tickerContainer');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/public/recent-scams`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.scams || data.scams.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No recent scam reports yet. Be the first to verify a number.</p>';
      return;
    }
    const typeLabels = { paybill: 'Paybill', phone: 'Phone', job_offer: 'Job' };
    container.innerHTML = data.scams.map((s, i) => {
      const ago = timeAgo(new Date(s.reported_at));
      return `<div class="ticker-item" style="animation-delay:${i * 0.05}s">
        <span class="ticker-verdict ${s.verdict}">${s.verdict === 'scam' ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>SCAM' : '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>SUSPICIOUS'}</span>
        <span class="ticker-type">${typeLabels[s.type] || s.type}</span>
        <span class="ticker-value">${escapeHtml(s.value)}</span>
        <span class="ticker-time">${ago}</span>
      </div>`;
    }).join('');
  } catch {
    container.innerHTML = '';
  }
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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


async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [3000, 6000, 10000];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
      if ((res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        if (attempt === 0) {
          var wakeNotice = document.getElementById('apiWakeNotice');
          if (!wakeNotice) {
            wakeNotice = document.createElement('div');
            wakeNotice.id = 'apiWakeNotice';
            wakeNotice.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
            wakeNotice.textContent = 'Server is waking up, please wait...';
            document.body.appendChild(wakeNotice);
          }
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wakeNotice2 = document.getElementById('apiWakeNotice');
      if (wakeNotice2) wakeNotice2.remove();
      let data = {};
      try { data = await res.json(); } catch {  }
      if (!res.ok) {
        const err = new Error(data.error || 'Something went wrong.');
        Object.assign(err, data);
        throw err;
      }
      return data;
    } catch (fetchErr) {
      if (fetchErr.name === 'TypeError' && attempt < MAX_RETRIES) {
        if (attempt === 0) {
          var wakeNotice3 = document.getElementById('apiWakeNotice');
          if (!wakeNotice3) {
            wakeNotice3 = document.createElement('div');
            wakeNotice3.id = 'apiWakeNotice';
            wakeNotice3.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
            wakeNotice3.textContent = 'Server is waking up, please wait...';
            document.body.appendChild(wakeNotice3);
          }
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wakeNotice4 = document.getElementById('apiWakeNotice');
      if (wakeNotice4) wakeNotice4.remove();
      throw fetchErr;
    }
  }
}

function updateAuthUI() {
  const user = getUser();
  const area = document.getElementById('navAuthArea');
  if (!area) return;
  if (user) {
    area.innerHTML = `
      <span style="color:#cfd9ea;font-size:0.9rem;margin-right:6px;">Hi, ${user.fullName?.split(' ')[0] || 'there'}</span>
      ${user.accountType === 'job_owner' ? '<a class="btn btn-outline" href="dashboard.html">Dashboard</a>' : ''}
      <button class="btn btn-primary" id="logoutBtn">Log out</button>`;
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
  }
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) {  }
  sessionStorage.clear();
  window.location.replace('index.html');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    if (!getToken()) {
      window.location.replace('index.html');
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();

  document.getElementById('openLogin')?.addEventListener('click', () => openModal('loginOverlay'));
  document.getElementById('openSignup')?.addEventListener('click', () => openModal('signupOverlay'));
  document.getElementById('openSignupJobOwner')?.addEventListener('click', () => {
    openModal('signupOverlay');
    document.querySelector('[data-account-type="job_owner"]')?.click();
  });
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', (e) => {
    closeModal(e.target.closest('.modal-overlay').id);
  }));
  document.querySelectorAll('.modal-overlay').forEach((ov) => ov.addEventListener('click', (e) => {
    if (e.target === ov) closeModal(ov.id);
  }));
  document.querySelectorAll('[data-switch-to]').forEach((btn) => btn.addEventListener('click', () => {
    closeModal('loginOverlay'); closeModal('signupOverlay');
    openModal(btn.dataset.switchTo === 'signup' ? 'signupOverlay' : 'loginOverlay');
  }));

  const WHATSAPP_CARE_NUMBER = '254714589375';
  const WHATSAPP_CARE_MESSAGE = 'Critical alert. I need urgent help';
  document.getElementById('whatsappFab')?.addEventListener('click', () => openModal('whatsappConfirmOverlay'));
  document.getElementById('whatsappConfirmGo')?.addEventListener('click', () => {
    const url = `https://wa.me/${WHATSAPP_CARE_NUMBER}?text=${encodeURIComponent(WHATSAPP_CARE_MESSAGE)}`;
    window.open(url, '_blank');
    closeModal('whatsappConfirmOverlay');
  });

  let currentAccountType = 'regular';
  document.querySelectorAll('[data-account-type]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-account-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAccountType = btn.dataset.accountType;
    document.getElementById('jobOwnerFields').classList.toggle('show', currentAccountType === 'job_owner');
  }));

  document.getElementById('suPassword')?.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  const checkEmail = debounce(async (email) => {
    const msg = document.getElementById('suEmailMsg');
    if (!isValidEmailClient(email)) { msg.textContent = 'Enter a valid email address.'; msg.className = 'field-msg err'; return; }
    try {
      const r = await api(`/auth/check-email?email=${encodeURIComponent(email)}`);
      msg.textContent = r.valid ? 'Looks good.' : r.reason;
      msg.className = `field-msg ${r.valid ? 'ok' : 'err'}`;
    } catch { msg.textContent = ''; }
  }, 500);
  document.getElementById('suEmail')?.addEventListener('input', (e) => checkEmail(e.target.value));

  const checkPhone = debounce(async (phone) => {
    const msg = document.getElementById('suPhoneMsg');
    if (!normalizeKenyanPhoneClient(phone)) { msg.textContent = 'Enter a valid Safaricom-format number, e.g. 07XXXXXXXX.'; msg.className = 'field-msg err'; return; }
    try {
      const r = await api(`/auth/check-phone?phone=${encodeURIComponent(phone)}`);
      msg.textContent = r.valid ? (r.note || 'Looks good.') : r.reason;
      msg.className = `field-msg ${r.valid ? 'ok' : 'err'}`;
    } catch { msg.textContent = ''; }
  }, 500);
  document.getElementById('suPhone')?.addEventListener('input', (e) => checkPhone(e.target.value));

  let pendingOtpEmail = null;
  let pendingLocationReverifyEmail = null;

  document.getElementById('signupSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('signupAlert');
    alertBox.innerHTML = '';
    const btn = document.getElementById('signupSubmit');
    const label = document.getElementById('signupBtnLabel');

    const consentMsg = document.getElementById('suConsentMsg');
    if (!document.getElementById('suConsent').checked) {
      consentMsg.style.display = 'block';
      return;
    }
    consentMsg.style.display = 'none';

    const idFile = document.getElementById('suIdDocument').files[0];
    if (!idFile) {
      alertBox.innerHTML = '<div class="alert alert-err">Upload a photo or scan of your ID.</div>';
      return;
    }

    const password = document.getElementById('suPassword').value;
    const passwordConfirm = document.getElementById('suPasswordConfirm').value;
    const confirmMsg = document.getElementById('suPasswordConfirmMsg');
    if (password !== passwordConfirm) {
      confirmMsg.textContent = 'Passwords do not match.';
      confirmMsg.className = 'field-msg err';
      return;
    }
    confirmMsg.textContent = '';

    const formData = new FormData();
    formData.append('accountType', currentAccountType);
    formData.append('fullName', document.getElementById('suFullName').value.trim());
    const email = document.getElementById('suEmail').value.trim();
    formData.append('email', email);
    formData.append('phone', document.getElementById('suPhone').value.trim());
    formData.append('nationalId', document.getElementById('suNationalId').value.trim());
    formData.append('password', password);
    formData.append('consentAccepted', document.getElementById('suConsent').checked);
    formData.append('idDocument', idFile);
    if (currentAccountType === 'job_owner') {
      formData.append('businessName', document.getElementById('suBusinessName').value.trim());
      formData.append('businessRegNumber', document.getElementById('suBusinessReg').value.trim());
      formData.append('kraPin', document.getElementById('suKraPin').value.trim());
    }

    btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Creating account...';
    try {
      await api('/auth/signup', { method: 'POST', body: formData });
      pendingOtpEmail = email;
      closeModal('signupOverlay');
      document.getElementById('otpEmailLabel').textContent = email;
      document.getElementById('otpAlert').innerHTML = '';
      document.getElementById('otpCodeInput').value = '';
      openModal('otpOverlay');
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false; label.textContent = 'Create account';
    }
  });

  document.getElementById('otpSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('otpAlert');
    const code = document.getElementById('otpCodeInput').value.trim();
    const btn = document.getElementById('otpSubmit');
    const label = document.getElementById('otpBtnLabel');
    alertBox.innerHTML = '';
    if (!code) { alertBox.innerHTML = '<div class="alert alert-err">Enter the 6-digit code.</div>'; return; }

    btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Verifying...';
    try {
      const r = await api('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email: pendingOtpEmail, code }) });
      setSession(r.token, r.user);
      closeModal('otpOverlay');
      if (r.user.accountType === 'job_owner') {
        window.location.href = 'dashboard.html';
      } else {
        updateAuthUI();
      }
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false; label.textContent = 'Verify & continue';
    }
  });

  document.getElementById('otpResend')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('otpAlert');
    try {
      const r = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: pendingOtpEmail }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById('locationReverifySubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('locationReverifyAlert');
    const code = document.getElementById('locationReverifyCode').value.trim();
    alertBox.innerHTML = '';
    if (!code) { alertBox.innerHTML = '<div class="alert alert-err">Enter the 6-digit code.</div>'; return; }
    try {
      const r = await api('/auth/reverify-location', { method: 'POST', body: JSON.stringify({ email: pendingLocationReverifyEmail, code }) });
      setSession(r.token, r.user);
      closeModal('locationReverifyOverlay');
      if (r.user.accountType === 'job_owner') {
        window.location.href = 'dashboard.html';
      } else {
        updateAuthUI();
      }
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById('locationReverifyResend')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('locationReverifyAlert');
    try {
      const r = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: pendingLocationReverifyEmail }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById('loginSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('loginAlert');
    alertBox.innerHTML = '';
    const btn = document.getElementById('loginSubmit');
    const label = document.getElementById('loginBtnLabel');
    btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Logging in...';
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          emailOrPhone: document.getElementById('loginId').value.trim(),
          password: document.getElementById('loginPassword').value,
        }),
      });
      setSession(r.token, r.user);
      if (r.user.accountType === 'job_owner') {
        window.location.href = 'dashboard.html';
      } else {
        closeModal('loginOverlay');
        updateAuthUI();
      }
    } catch (err) {
      if (err.requiresOtp) {
        pendingOtpEmail = err.email || document.getElementById('loginId').value.trim();
        closeModal('loginOverlay');
        document.getElementById('otpEmailLabel').textContent = pendingOtpEmail;
        document.getElementById('otpAlert').innerHTML = '<div class="alert alert-err">Verify your email to continue.</div>';
        document.getElementById('otpCodeInput').value = '';
        openModal('otpOverlay');
      } else if (err.requiresLocationReverify) {
        pendingLocationReverifyEmail = err.email || document.getElementById('loginId').value.trim();
        closeModal('loginOverlay');
        document.getElementById('locationReverifyEmail').textContent = pendingLocationReverifyEmail;
        document.getElementById('locationReverifyAlert').innerHTML = '<div class="alert alert-err">' + escapeHtml(err.message) + '</div>';
        document.getElementById('locationReverifyCode').value = '';
        openModal('locationReverifyOverlay');
      } else {
        alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
      }
    } finally {
      btn.disabled = false; label.textContent = 'Log in';
    }
  });

  let searchType = 'paybill';
  let searchTier = 50;
  let searchRegion = 'kenya';

  const regionRow = document.getElementById('regionRow');

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    searchType = tab.dataset.type;
    document.getElementById('searchInput').placeholder =
      searchType === 'paybill' ? 'e.g. 400200' : searchType === 'phone' ? 'e.g. 0712345678' : 'Paste the job offer text here';
    regionRow.style.display = searchType === 'job_offer' ? 'flex' : 'none';
  }));

  document.querySelectorAll('.tier').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tier').forEach((x) => x.classList.remove('selected'));
    t.classList.add('selected');
    searchTier = Number(t.dataset.tier);
  }));

  document.querySelectorAll('.region-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.region-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    searchRegion = btn.dataset.region;
  }));

  function askForPhone() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('phoneOverlay');
      const input = document.getElementById('phoneInput');
      const msg = document.getElementById('phoneInputMsg');
      const confirmBtn = document.getElementById('phoneConfirmBtn');
      const alertBox = document.getElementById('phoneAlert');
      input.value = '';
      msg.textContent = '';
      alertBox.innerHTML = '';
      openModal('phoneOverlay');
      input.focus();

      const cleanup = () => { closeModal('phoneOverlay'); confirmBtn.removeEventListener('click', onConfirm); input.removeEventListener('keydown', onKey); };
      const onConfirm = () => {
        const val = input.value.trim();
        if (!val) { msg.textContent = 'Enter your M-Pesa number.'; msg.className = 'field-msg err'; return; }
        if (!normalizeKenyanPhoneClient(val)) { msg.textContent = 'Enter a valid number, e.g. 07XXXXXXXX.'; msg.className = 'field-msg err'; return; }
        cleanup(); resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Enter') onConfirm(); };
      confirmBtn.addEventListener('click', onConfirm);
      input.addEventListener('keydown', onKey);

      overlay.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => { cleanup(); resolve(null); }, { once: true }));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } }, { once: true });
    });
  }

  document.getElementById('searchBtn')?.addEventListener('click', async () => {
    const value = document.getElementById('searchInput').value.trim();
    if (!value) return;
    if (!getToken()) {
      openModal('loginOverlay');
      document.getElementById('loginAlert').innerHTML = '<div class="alert alert-err">Create an account or log in first — every search is tied to your account.</div>';
      return;
    }
    const phone = await askForPhone();
    if (!phone) return;

    const searchBtn = document.getElementById('searchBtn');
    searchBtn.disabled = true;
    try {
      const pay = await api('/payments/search', { method: 'POST', body: JSON.stringify({ tier: searchTier, phone }) });
      await waitForPaymentThenRun({
        paymentId: pay.paymentId,
        initialMessage: pay.message || `STK push sent to ${phone}. Enter your M-Pesa PIN to complete payment.`,
        onConfirmed: async () => {
          const result = await api('/search', { method: 'POST', body: JSON.stringify({ paymentId: pay.paymentId, queryType: searchType, queryValue: value, region: searchRegion }) });
          renderSearchResult(result);
        },
      });
    } catch (err) {
      const pp = document.getElementById('paymentProgressCard');
      pp.style.display = 'block';
      document.getElementById('ppStatusText').textContent = 'Something went wrong.';
      document.getElementById('ppHint').textContent = escapeHtml(err.message);
    } finally {
      searchBtn.disabled = false;
    }
  });

  async function waitForPaymentThenRun({ paymentId, initialMessage, onConfirmed }) {
    const card = document.getElementById('paymentProgressCard');
    const statusText = document.getElementById('ppStatusText');
    const circular = document.getElementById('ppCircular');
    const hint = document.getElementById('ppHint');

    card.style.display = 'block';
    circular.classList.remove('done');
    statusText.textContent = initialMessage;
    hint.textContent = 'Check your phone and enter your M-Pesa PIN. This usually takes a few seconds.';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const POLL_EVERY_MS = 2500;
    const TIMEOUT_MS = 45000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        circular.classList.add('done');
        statusText.textContent = 'Payment confirmed!';
        hint.innerHTML = '<span class="receipt-printing-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></span> Printing your receipt…';
        await new Promise((r) => setTimeout(r, 700));
        try {
          await onConfirmed();
          card.style.display = 'none';
        } catch (err) {
          hint.textContent = err.message || 'Something went wrong loading your result.';
        }
        resolve();
      };

      const showTimeoutOrFailure = (statusMsg) => {
        clearInterval(timer);
        statusText.textContent = statusMsg;
        hint.textContent = "If you completed the M-Pesa prompt and this persists, please get in touch via the contact form — don't try paying again until you hear back.";
        resolve();
      };

      const timer = setInterval(async () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > TIMEOUT_MS) {
          showTimeoutOrFailure("Still waiting — didn't get a confirmation yet.");
          return;
        }
        try {
          const status = await api(`/payments/status/${paymentId}`);
          if (status.status === 'success') { finishSuccess(); }
          else if (status.status === 'failed') {
            showTimeoutOrFailure('Payment failed or was cancelled.');
          }
        } catch (err) {
        }
      }, POLL_EVERY_MS);
    });
  }

  function renderSearchResult(payload) {
    const r = payload.result;
    const outer = document.getElementById('receiptOuter');
    const slot = document.getElementById('receiptPaperSlot');

    const verdictLabels = { legit: 'LEGIT', scam: 'SCAM', suspicious: 'SUSPICIOUS', unverified: 'UNVERIFIED' };
    const now = new Date();
    const timestamp = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sourceCount = r.sources ? (r.sources.external_sources || []).length : null;
    const dbCount = r.sources && r.sources.db_signal ? r.sources.db_signal.reduce((a, b) => a + b.n, 0) : null;

    const isScam = r.verdict === 'scam' || r.verdict === 'suspicious';
    const forensicsParams = new URLSearchParams({ q: value, type: searchType, verdict: r.verdict });

    slot.innerHTML = `
      <div class="receipt-paper" id="receiptPaper">
        <div class="receipt-head">
          <img src="assets/logo.png" alt="SemaCheck">
          <div class="r-sub">Verification receipt</div>
        </div>
        <hr class="receipt-divider">
        <div class="receipt-row"><span class="r-label">Date</span><span class="r-value">${timestamp}</span></div>
        <div class="receipt-row"><span class="r-label">Query type</span><span class="r-value">${searchType.replace('_', ' ')}</span></div>
        <div class="receipt-row"><span class="r-label">Search scope</span><span class="r-value">${searchRegion === 'international' ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:-2px;margin-right:3px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>Worldwide' : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:-2px;margin-right:3px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>Kenya only'}</span></div>
        <div class="receipt-row"><span class="r-label">Amount paid</span><span class="r-value">KES ${searchTier}</span></div>
        <hr class="receipt-divider">
        <div class="receipt-verdict-line v-${r.verdict}">
          <div class="r-verdict-word">${verdictLabels[r.verdict] || r.verdict.toUpperCase()}</div>
          ${r.confidence_score ? `<div style="font-size:0.78rem;color:#666;margin-top:2px;">${r.confidence_score}% confidence</div>` : ''}
        </div>
        ${r.summary ? `<hr class="receipt-divider"><div class="receipt-summary">${r.summary}</div>` : ''}
        ${sourceCount !== null ? `<div class="receipt-sources">Sources checked: ${sourceCount} web result(s), ${dbCount || 0} internal report(s)</div>` : ''}
        ${payload.fromCache ? '<div class="receipt-sources"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-2px;margin-right:3px;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>Instant result — already verified by SemaCheck.</div>' : ''}
        <div class="receipt-barcode"></div>
        <div class="receipt-footer">THANK YOU FOR USING SEMACHECK &middot; SEMACHECK.CO.KE</div>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" onclick="window.print()"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>Print receipt</button>
      </div>
      ${isScam ? `<div class="reclaim-money-box"><p>Lost money to this scam? Get help tracing it and building a case.</p><a class="btn btn-amber" href="forensics.html?${forensicsParams.toString()}">Reclaim my money →</a></div>` : ''}
    `;

    outer.classList.remove('open');
   
    void outer.offsetHeight;
    requestAnimationFrame(() => outer.classList.add('open'));
    setTimeout(() => outer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
  }

  loadRecentScamsTicker();

  setInterval(() => {
    fetch(`${API_BASE}/health`, { cache: 'no-store' }).catch(() => {});
  }, 10 * 60 * 1000);

  document.getElementById('contactSendBtn')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('contactAlert');
    const email = document.getElementById('contactEmail').value.trim();
    const message = document.getElementById('contactMessage').value.trim();
    alertBox.innerHTML = '';
    try {
      const r = await api('/contact', { method: 'POST', body: JSON.stringify({ email, message }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
      document.getElementById('contactEmail').value = '';
      document.getElementById('contactMessage').value = '';
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });
});
