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
    const typeLabels = { paybill: 'Paybill', phone: 'Phone', job_offer: 'Job', job: 'Job', business: 'Business', website: 'Website', other: 'Other' };
    container.innerHTML = data.scams.map((s, i) => {
      const ago = timeAgo(new Date(s.reported_at));
      const amount = s.amountLostKes ? `<span class="ticker-amount">KES ${Number(s.amountLostKes).toLocaleString()} lost</span>` : '';
      const badge = s.source === 'report' ? '<span class="ticker-source" title="Admin-approved community report">REPORTED</span>' : '';
      return `<div class="ticker-item" style="animation-delay:${i * 0.05}s">
        <span class="ticker-verdict ${escapeHtml(s.verdict)}">${s.verdict === 'scam' ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>SCAM' : '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>SUSPICIOUS'}</span>
        <span class="ticker-type">${typeLabels[s.type] || escapeHtml(s.type)}</span>
        <span class="ticker-value">${escapeHtml(s.value)}</span>${badge}${amount}
        <span class="ticker-time">${ago}</span>
      </div>`;
    }).join('');
  } catch {
    container.innerHTML = '';
  }
}

// Live figures for the home page (F-02): replace the placeholder text with the
// real approved-report count from the public stats endpoint. Falls back to the
// existing copy if the API is slow, asleep or unreachable.
async function loadHomeStats() {
  const el = document.getElementById('homeApprovedReports');
  if (!el) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${API_BASE}/public/stats`, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    const n = Number(data.approvedReports || 0);
    if (n > 0) el.textContent = `${n.toLocaleString()} verified`;
  } catch { /* keep the fallback text */ }
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

// The session token lives in an HttpOnly cookie set by the server. This code
// never sees or stores it, so a script-injection bug cannot steal the session.
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }
function setSession(_token, user) {
  if (user) sessionStorage.setItem('semacheck_user', JSON.stringify(user));
}
function clearSession() {
  sessionStorage.removeItem('semacheck_user');
}

// ── Push Notifications ──────────────────────────────────────────────
async function registerPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    // Fetch VAPID public key from backend
    const res = await fetch(`${API_BASE}/notifications/vapid-public-key`);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    if (!publicKey) return;

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    // Get existing service worker registration
    const registration = await navigator.serviceWorker.ready;

    // Check for existing subscription
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    // Send subscription to backend
    await fetch(`${API_BASE}/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  } catch (err) {
    // Silently fail — notifications are optional
    console.log('[push] Registration skipped:', err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}


async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [5000, 10000, 15000, 20000, 25000];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include', cache: 'no-store' });
      if ((res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        var wakeNotice = document.getElementById('apiWakeNotice');
        if (!wakeNotice) {
          wakeNotice = document.createElement('div');
          wakeNotice.id = 'apiWakeNotice';
          wakeNotice.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          document.body.appendChild(wakeNotice);
        }
        wakeNotice.textContent = 'Server is waking up, please wait... (attempt ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) + ')';
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
        var wakeNotice3 = document.getElementById('apiWakeNotice');
        if (!wakeNotice3) {
          wakeNotice3 = document.createElement('div');
          wakeNotice3.id = 'apiWakeNotice';
          wakeNotice3.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          document.body.appendChild(wakeNotice3);
        }
        wakeNotice3.textContent = 'Server is waking up, please wait... (attempt ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) + ')';
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
      <span style="color:#cfd9ea;font-size:0.9rem;margin-right:6px;">Hi, ${escapeHtml(user.fullName?.split(' ')[0] || 'there')}</span>
      ${user.accountType === 'job_owner' ? '<a class="btn btn-outline" href="dashboard.html">Dashboard</a>' : ''}
      <button class="btn btn-primary" id="logoutBtn">Log out</button>`;
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    showPendingApprovalNotice();
    // Refresh the stored profile so sessions created before this field
    // existed also learn their approval status.
    api('/auth/me').then((r) => {
      if (r && r.user) {
        setSession(null, { ...user, ...r.user });
        showPendingApprovalNotice();
      }
    }).catch(() => {});
  }
}

// Newly created accounts log in before the admin team approves them — say
// so explicitly instead of leaving them guessing.
function showPendingApprovalNotice() {
  const user = getUser();
  const existing = document.getElementById('pendingApprovalNotice');
  if (!user || user.idVerificationStatus !== 'pending') {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'pendingApprovalNotice';
  banner.className = 'alert alert-ok';
  banner.style.cssText = 'margin:10px 0; border-radius:10px;';
  banner.innerHTML = '<b>Your account is being reviewed by our admin team.</b> You are logged in and can explore now — job posting and full access unlock once your account is approved (usually within 24 hours).';
  const main = document.querySelector('main') || document.body;
  main.prepend(banner);
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
    if (!getUser()) {
      window.location.replace('index.html');
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();

  document.getElementById('openLogin')?.addEventListener('click', () => { resetLoginStep(); openModal('loginOverlay'); });
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
    closeModal('loginOverlay'); closeModal('signupOverlay'); closeModal('forgotOverlay');
    if (btn.dataset.switchTo === 'login') resetLoginStep();
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

  let currentAccountType = 'job_owner';
  document.querySelectorAll('[data-account-type]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-account-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAccountType = btn.dataset.accountType;
    document.getElementById('jobOwnerFields').classList.toggle('show', currentAccountType === 'job_owner');
  }));

  document.getElementById('suPassword')?.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  let pendingTwoFactorToken = null;

  function resetLoginStep() {
    pendingTwoFactorToken = null;
    const section = document.getElementById('login2faSection');
    if (section) section.style.display = 'none';
    const idField = document.getElementById('loginId');
    if (idField && idField.closest('.field')) idField.closest('.field').style.display = '';
    const pwField = document.getElementById('loginPasswordField');
    if (pwField) pwField.style.display = '';
    const foot = document.getElementById('loginSignupFoot');
    if (foot) foot.style.display = '';
    const codeInput = document.getElementById('login2faCode');
    if (codeInput) codeInput.value = '';
    const loginBtn = document.getElementById('loginSubmit');
    if (loginBtn) loginBtn.style.display = '';
    const alertBox = document.getElementById('loginAlert');
    if (alertBox) alertBox.innerHTML = '';
  }

  function showLogin2faStep() {
    document.getElementById('login2faSection').style.display = 'block';
    document.getElementById('loginId').closest('.field').style.display = 'none';
    document.getElementById('loginPasswordField').style.display = 'none';
    document.getElementById('loginSignupFoot').style.display = 'none';
    document.getElementById('loginSubmit').style.display = 'none';
    document.getElementById('login2faCode').focus();
  }

  document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => {
    document.getElementById('forgotAlert').innerHTML = '';
    document.getElementById('forgotEmail').value = document.getElementById('loginId').value.trim();
    closeModal('loginOverlay');
    openModal('forgotOverlay');
  });

  document.getElementById('forgotSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('forgotAlert');
    const btn = document.getElementById('forgotSubmit');
    const label = document.getElementById('forgotBtnLabel');
    const email = document.getElementById('forgotEmail').value.trim();
    alertBox.innerHTML = '';
    if (!isValidEmailClient(email)) {
      alertBox.innerHTML = '<div class="alert alert-err">Enter a valid email address.</div>';
      return;
    }
    btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Sending...';
    try {
      const r = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${escapeHtml(r.message)}</div>`;
      btn.style.display = 'none';
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false; label.textContent = 'Send reset link';
    }
  });

  document.getElementById('login2faSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('loginAlert');
    const btn = document.getElementById('login2faSubmit');
    const label = document.getElementById('login2faBtnLabel');
    const code = document.getElementById('login2faCode').value.trim();
    alertBox.innerHTML = '';
    if (!/^\d{6}$/.test(code)) { alertBox.innerHTML = '<div class="alert alert-err">Enter the 6-digit code from your authenticator app.</div>'; return; }
    btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Verifying...';
    try {
      const r = await api('/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ twoFactorToken: pendingTwoFactorToken, code }) });
      setSession(r.token, r.user);
      resetLoginStep();
      if (r.user.accountType === 'job_owner') {
        window.location.href = 'dashboard.html';
      } else {
        closeModal('loginOverlay');
        updateAuthUI();
      }
      registerPushNotifications();
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false; label.textContent = 'Verify';
    }
  });

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
    if (currentAccountType === 'job_owner' && !idFile) {
      alertBox.innerHTML = '<div class="alert alert-err">Upload a photo of your ID — required for job owner accounts.</div>';
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
    if (idFile) formData.append('idDocument', idFile);
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
      registerPushNotifications();
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
      if (r.requires2fa) {
        pendingTwoFactorToken = r.twoFactorToken;
        showLogin2faStep();
        return;
      }
      setSession(r.token, r.user);
      if (r.user.accountType === 'job_owner') {
        window.location.href = 'dashboard.html';
      } else {
        closeModal('loginOverlay');
        updateAuthUI();
      }
      registerPushNotifications();
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
  let lastConsumerTier = 50;

  const regionRow = document.getElementById('regionRow');

  function selectTier(n) {
    document.querySelectorAll('.tier').forEach((x) => {
      x.classList.toggle('selected', Number(x.dataset.tier) === n);
    });
  }

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    searchType = tab.dataset.type;
    const isWebsite = searchType === 'website';
    document.getElementById('searchInput').placeholder =
      searchType === 'paybill' ? 'e.g. 400200' :
      searchType === 'phone' ? 'e.g. 0712345678' :
      isWebsite ? 'e.g. deals-ke.com or the agency name' :
      'Paste the job offer text here';
    regionRow.style.display = searchType === 'job_offer' ? 'flex' : 'none';

    document.querySelectorAll('.tier').forEach((t) => {
      const isWebTier = Number(t.dataset.tier) === 80;
      t.style.display = isWebsite ? (isWebTier ? '' : 'none') : (isWebTier ? 'none' : '');
    });

    if (isWebsite) {
      searchTier = 80;
      searchRegion = 'international';
      selectTier(80);
    } else {
      searchTier = lastConsumerTier;
      selectTier(lastConsumerTier);
      if (searchType !== 'job_offer') searchRegion = 'kenya';
    }
    document.querySelectorAll('.region-btn').forEach((b) => b.classList.toggle('active', b.dataset.region === searchRegion));
  }));

  document.querySelectorAll('.tier').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tier').forEach((x) => x.classList.remove('selected'));
    t.classList.add('selected');
    searchTier = Number(t.dataset.tier);
    if (searchTier !== 80) lastConsumerTier = searchTier;
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
    // Regular users don't need an account to search — the M-Pesa payment
    // identifies the request. Job owners and API partners sign up separately.
    const phone = await askForPhone();
    if (!phone) return;

    const searchBtn = document.getElementById('searchBtn');
    searchBtn.disabled = true;
    const overlay = document.getElementById('paymentPopupOverlay');
    const pp = document.getElementById('paymentProgressCard');
    const ppCircular = document.getElementById('ppCircular');
    const ppStatus = document.getElementById('ppStatusText');
    const ppHint = document.getElementById('ppHint');
    overlay.classList.add('open');
    ppCircular.className = 'pp-circular';
    ppStatus.textContent = 'Processing your results';
    ppHint.textContent = 'Sending M-Pesa STK push to your phone...';
    try {
      const pay = await api('/payments/search', { method: 'POST', body: JSON.stringify({ tier: searchTier, phone }) });
      ppStatus.textContent = 'Enter your M-Pesa PIN';
      ppHint.textContent = 'An STK prompt has been sent to your phone. Enter your PIN to confirm payment.';
      await waitForPaymentThenRun({
        paymentId: pay.paymentId,
        onConfirmed: async () => {
          const result = await api('/search', { method: 'POST', body: JSON.stringify({ paymentId: pay.paymentId, queryType: searchType, queryValue: value, region: searchRegion }) });
          renderSearchResult(result, value);
        },
      });
    } catch (err) {
      ppCircular.className = 'pp-circular';
      ppStatus.textContent = 'Something went wrong.';
      ppHint.textContent = escapeHtml(err.message);
      setTimeout(() => overlay.classList.remove('open'), 3000);
    } finally {
      searchBtn.disabled = false;
    }
  });

  async function waitForPaymentThenRun({ paymentId, onConfirmed }) {
    const overlay = document.getElementById('paymentPopupOverlay');
    const card = document.getElementById('paymentProgressCard');
    const statusText = document.getElementById('ppStatusText');
    const circular = document.getElementById('ppCircular');
    const hint = document.getElementById('ppHint');

    overlay.classList.add('open');
    circular.className = 'pp-circular';

    const POLL_EVERY_MS = 2500;
    const TIMEOUT_MS = 45000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        circular.classList.add('done');
        circular.className = 'pp-circular done';
        statusText.textContent = 'Success!';
        hint.textContent = 'Payment confirmed. Generating your receipt...';
        await new Promise((r) => setTimeout(r, 1200));
        try {
          await onConfirmed();
          overlay.classList.remove('open');
        } catch (err) {
          hint.textContent = err.message || 'Something went wrong loading your result.';
          setTimeout(() => overlay.classList.remove('open'), 3000);
        }
        resolve();
      };

      const showTimeoutOrFailure = (statusMsg) => {
        clearInterval(timer);
        circular.className = 'pp-circular failed';
        statusText.textContent = statusMsg;
        hint.textContent = "If you completed the M-Pesa prompt and this persists, please get in touch via the contact form — don't try paying again until you hear back.";
        setTimeout(() => overlay.classList.remove('open'), 5000);
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

  function openPrintSim(forensicsHref) {
    const paper = document.getElementById('receiptPaper');
    if (!paper) return;
    let ov = document.getElementById('printSimOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'printSimOverlay';
      ov.className = 'print-sim-overlay';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.classList.remove('open'); });
    }
    const clone = paper.cloneNode(true);
    clone.removeAttribute('id');
    ov.innerHTML = `
      <div class="print-sim-stage">
        <div class="print-sim-toolbar">
          <span class="print-sim-title">Print simulation</span>
          <button class="btn print-sim-close" type="button">Done</button>
        </div>
        <div class="print-sim-sheet">
          <div class="print-sim-front"></div>
          ${clone.outerHTML}
        </div>
        ${forensicsHref ? `<div class="print-sim-forensics"><p>This subject was reported. Connect to our forensic team to trace the money and build a case.</p><a class="btn btn-amber" href="${forensicsHref}">Proceed to forensics &middot; KES 849 case fee</a></div>` : ''}
      </div>`;
    ov.querySelector('.print-sim-close').addEventListener('click', () => ov.classList.remove('open'));
    ov.classList.add('open');
  }

  function renderSearchResult(payload, queryValue) {
    const r = payload.result;
    const outer = document.getElementById('receiptOuter');
    const slot = document.getElementById('receiptPaperSlot');

    const verdictLabels = { reported: 'REPORTED', caution: 'CAUTION', registered: 'REGISTERED', unverified: 'UNVERIFIED', legit: 'LEGIT', scam: 'SCAM', suspicious: 'SUSPICIOUS' };
    const now = new Date();
    const timestamp = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sourceCount = r.sources ? (r.sources.external_sources || []).length : null;
    const dbCount = r.sources && r.sources.db_signal ? r.sources.db_signal.reduce((a, b) => a + b.n, 0) : null;

    const showForensics = ['reported', 'caution', 'scam', 'suspicious'].includes(r.verdict);
    const forensicsParams = new URLSearchParams({ q: queryValue, type: searchType, verdict: r.verdict });
    const forensicsHref = `forensics.html?${forensicsParams.toString()}`;

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
        <div class="receipt-verdict-line v-${escapeHtml(r.verdict)}">
          <div class="r-verdict-word">${escapeHtml(verdictLabels[r.verdict] || r.verdict.toUpperCase())}</div>
          ${r.confidence_score ? `<div style="font-size:0.78rem;color:#666;margin-top:2px;">${r.confidence_score}% confidence</div>` : ''}
        </div>
        ${r.summary ? `<hr class="receipt-divider"><div class="receipt-summary">${escapeHtml(r.summary)}</div>` : ''}
        ${sourceCount !== null ? `<div class="receipt-sources">Sources checked: ${sourceCount} web result(s), ${dbCount || 0} internal report(s)</div>` : ''}
        ${payload.fromCache ? '<div class="receipt-sources"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-2px;margin-right:3px;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>Instant result — already verified by SemaCheck.</div>' : ''}
        <div class="receipt-barcode"></div>
        <div class="receipt-footer">THANK YOU FOR USING SEMACHECK &middot; SEMACHECK.CO.KE</div>
      </div>
      <div class="receipt-actions">
        <button class="btn btn-ghost" id="printSimBtn"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>Print receipt</button>
        <button class="btn btn-ghost" onclick="window.open('/report.html?type=phone&value=' + encodeURIComponent(JSON.parse(decodeURIComponent(document.querySelector('script[type="application/json"].receipt-data')?.textContent || '{}')).subject || ''), '_blank')"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M11 20a1 1 0 0 1 .707-.293l8-8a1 1 0 0 1 1.414 1.414l-8 8A1 1 0 0 1 11 20zm6-12V4H7v4c0 4.418 2.944 8 6.635 8.011-.376.016-.75.025-1.124.025A5.986 5.986 0 0 1 17 12c0-1.59-.668-2.86-1.727-3.723V7.97zm1-1.832A6.015 6.015 0 0 0 12 5a6.015 6.015 0 0 0-5.086 1.45c-.374-.012-.747-.024-1.123-.024A5.987 5.987 0 0 0 3 12c0 1.59.668 2.86 1.727 3.73V16.03l5.801-1.894v-2.06z"/></svg>Report this</button>
        <button class="btn btn-ghost" id="verdictFeedbackBtn"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-3.5h-2c0-3 3-2.75 3-4.5a2 2 0 0 0-4 0h-2a4 4 0 1 1 8 0c0 2.5-3 2.75-3 4.5z"/></svg>Wrong verdict?</button>
      </div>
      <div id="verdictFeedbackBox" style="display:none; margin-top:10px; border:1px solid var(--border); border-radius:10px; padding:14px;">
        <div class="hint" style="margin-bottom:8px;">Tell our review team what looks wrong with this verdict. We check every submission against the evidence.</div>
        <textarea id="vfMessage" rows="3" style="width:100%; padding:9px; border:1.5px solid var(--border); border-radius:8px; font-family:inherit;" placeholder="e.g. This paybill belongs to my registered business and has no reports against it."></textarea>
        <input id="vfEmail" type="email" style="width:100%; margin-top:8px; padding:9px; border:1.5px solid var(--border); border-radius:8px;" placeholder="Email for follow-up (optional)">
        <div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
          <button class="btn btn-primary" id="vfSubmitBtn">Send to review team</button>
          <span id="vfResult" class="hint"></span>
        </div>
      </div>
      ${showForensics ? `<div class="reclaim-money-box"><p>Lost money to this subject? Get help tracing it and building a case.</p><a class="btn btn-amber" href="${forensicsHref}">Reclaim my money →</a></div>` : ''}
    `;

    document.getElementById('printSimBtn')?.addEventListener('click', () => openPrintSim(showForensics ? forensicsHref : null));

    // "Wrong verdict?" feedback — posts to /api/feedback/verdict with a
    // hashed subject; the raw number never leaves this page's TLS session.
    const vfBtn = document.getElementById('verdictFeedbackBtn');
    const vfBox = document.getElementById('verdictFeedbackBox');
    vfBtn?.addEventListener('click', () => { vfBox.style.display = vfBox.style.display === 'none' ? 'block' : 'none'; });
    document.getElementById('vfSubmitBtn')?.addEventListener('click', async () => {
      const msg = document.getElementById('vfMessage').value.trim();
      const result = document.getElementById('vfResult');
      if (msg.length < 10) { result.textContent = 'Please describe the problem in at least 10 characters.'; result.style.color = 'var(--scam-red)'; return; }
      try {
        const r2 = await api('/feedback/verdict', {
          method: 'POST',
          body: JSON.stringify({
            checkType: searchType,
            subject: queryValue,
            verdict: r.verdict,
            message: msg,
            email: document.getElementById('vfEmail').value.trim() || undefined,
          }),
        });
        result.textContent = r2.message || 'Sent — thank you.';
        result.style.color = 'var(--legit-green)';
        document.getElementById('vfMessage').value = '';
      } catch (err2) {
        result.textContent = err2.message || 'Could not send. Try again.';
        result.style.color = 'var(--scam-red)';
      }
    });

    outer.classList.remove('open');
   
    void outer.offsetHeight;
    requestAnimationFrame(() => outer.classList.add('open'));
    setTimeout(() => outer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
  }

  loadRecentScamsTicker();
  loadHomeStats();

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
