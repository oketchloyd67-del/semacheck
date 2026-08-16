// js/app.js
const API_BASE = 'https://semacheck.onrender.com/api';

// ---------------- session helpers ----------------
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
// NOTE: sessionStorage (not localStorage) is deliberate — it clears the
// moment the browser tab/window closes, which is the first line of
// defence on a shared/public computer. The second, stronger line is
// server-side: POST /api/auth/logout marks the session inactive in the
// DB, so even a copied/cached token stops working immediately (see
// backend/middleware/auth.js).

async function api(path, options = {}) {
  // When body is FormData (file upload), let the browser set its own
  // multipart Content-Type header (with boundary) — don't override it.
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    Object.assign(err, data); // carries extra fields like requiresOtp, email, alreadyUsed onto the error
    throw err;
  }
  return data;
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
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* proceed to clear locally regardless */ }
  clearSession();
  window.location.href = 'index.html';
}

// ---------------- modal plumbing ----------------
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

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

  // account type toggle
  let currentAccountType = 'regular';
  document.querySelectorAll('[data-account-type]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-account-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAccountType = btn.dataset.accountType;
    document.getElementById('jobOwnerFields').classList.toggle('show', currentAccountType === 'job_owner');
  }));

  // live password strength
  document.getElementById('suPassword')?.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  // live email check
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

  // live phone check
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

  // ---------------- signup submit ----------------
  let pendingOtpEmail = null;

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
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    } finally {
      btn.disabled = false; label.textContent = 'Create account';
    }
  });

  // ---------------- OTP verification ----------------
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
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
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
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });

  // ---------------- login submit ----------------
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
      } else {
        alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    } finally {
      btn.disabled = false; label.textContent = 'Log in';
    }
  });

  // ---------------- search tabs / tiers ----------------
  let searchType = 'paybill';
  let searchTier = 50;
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    searchType = tab.dataset.type;
    document.getElementById('searchInput').placeholder =
      searchType === 'paybill' ? 'e.g. 400200' : searchType === 'phone' ? 'e.g. 0712345678' : 'Paste the job offer text here';
  }));
  document.querySelectorAll('.tier').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tier').forEach((x) => x.classList.remove('selected'));
    t.classList.add('selected');
    searchTier = Number(t.dataset.tier);
  }));

  // ---------------- search flow ----------------
  document.getElementById('searchBtn')?.addEventListener('click', async () => {
    const value = document.getElementById('searchInput').value.trim();
    if (!value) return;
    if (!getToken()) {
      openModal('loginOverlay');
      document.getElementById('loginAlert').innerHTML = '<div class="alert alert-err">Create an account or log in first — every search is tied to your account.</div>';
      return;
    }
    const phone = prompt('Confirm the M-Pesa number to pay from:', '');
    if (!phone) return;

    const searchBtn = document.getElementById('searchBtn');
    searchBtn.disabled = true;
    try {
      const pay = await api('/payments/search', { method: 'POST', body: JSON.stringify({ tier: searchTier, phone }) });
      await waitForPaymentThenRun({
        paymentId: pay.paymentId,
        initialMessage: pay.message || `STK push sent to ${phone}. Enter your M-Pesa PIN to complete payment.`,
        onConfirmed: async () => {
          const result = await api('/search', { method: 'POST', body: JSON.stringify({ paymentId: pay.paymentId, queryType: searchType, queryValue: value }) });
          renderSearchResult(result);
        },
      });
    } catch (err) {
      alert(err.message);
    } finally {
      searchBtn.disabled = false;
    }
  });

  /**
   * Shows the progress card with a circular loader, polls
   * /api/payments/status/:paymentId until Tuma's callback marks it
   * successful (or it times out), then runs onConfirmed(). This replaces
   * the old flow, which fired the search request immediately after a
   * blocking alert() — before the callback had any real chance to
   * arrive, so it reliably failed with "payment not yet confirmed" even
   * when the payment genuinely went through. If it times out, a manual
   * M-Pesa-code fallback is revealed instead of just leaving the user stuck.
   */
  async function waitForPaymentThenRun({ paymentId, initialMessage, onConfirmed }) {
    const card = document.getElementById('paymentProgressCard');
    const statusText = document.getElementById('ppStatusText');
    const circular = document.getElementById('ppCircular');
    const hint = document.getElementById('ppHint');
    const manualBox = document.getElementById('manualCodeBox');

    card.style.display = 'block';
    manualBox.style.display = 'none';
    circular.classList.remove('done');
    document.getElementById('manualCodeAlert').innerHTML = '';
    document.getElementById('manualCodeInput').value = '';
    statusText.textContent = initialMessage;
    hint.textContent = 'Check your phone and enter your M-Pesa PIN. This usually takes a few seconds.';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const POLL_EVERY_MS = 2500;
    const TIMEOUT_MS = 45000; // Tuma/M-Pesa STK prompts themselves expire around 60s
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        circular.classList.add('done');
        statusText.textContent = 'Payment confirmed!';
        hint.textContent = 'Loading your result…';
        try {
          await onConfirmed();
          card.style.display = 'none';
        } catch (err) {
          hint.textContent = err.message || 'Something went wrong loading your result.';
        }
        resolve();
      };

      const showFallback = (statusMsg, hintMsg) => {
        clearInterval(timer);
        statusText.textContent = statusMsg;
        hint.textContent = hintMsg;
        manualBox.style.display = 'block';
        document.getElementById('manualCodeInput').dataset.paymentId = paymentId;
        window.__semacheckPendingOnConfirmed = onConfirmed;
        window.__semacheckRestartPayment = () => { card.style.display = 'none'; };
        resolve();
      };

      const timer = setInterval(async () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > TIMEOUT_MS) {
          showFallback("Still waiting — didn't get a confirmation yet.", 'If your M-Pesa PIN prompt timed out, try again. If money already left your phone, use the box below.');
          return;
        }
        try {
          const status = await api(`/payments/status/${paymentId}`);
          if (status.status === 'success') { finishSuccess(); }
          else if (status.status === 'failed') {
            showFallback('Payment failed or was cancelled.', 'If you completed the M-Pesa prompt anyway, use the box below to confirm manually.');
          }
          // still 'initiated' / 'pending' — keep polling
        } catch (err) {
          // a transient poll failure shouldn't kill the whole flow — keep trying until timeout
        }
      }, POLL_EVERY_MS);
    });
  }

  document.getElementById('manualCodeSubmit')?.addEventListener('click', async () => {
    const input = document.getElementById('manualCodeInput');
    const alertBox = document.getElementById('manualCodeAlert');
    const paymentId = input.dataset.paymentId;
    const code = input.value.trim();
    alertBox.innerHTML = '';
    if (!code) { alertBox.innerHTML = '<div class="alert alert-err">Enter the M-Pesa code from your confirmation SMS.</div>'; return; }
    try {
      await api(`/payments/${paymentId}/confirm-manual`, { method: 'POST', body: JSON.stringify({ mpesaCode: code }) });
      alertBox.innerHTML = '<div class="alert alert-ok">Payment confirmed. Loading your result…</div>';
      document.getElementById('ppCircular').classList.add('done');
      document.getElementById('ppStatusText').textContent = 'Payment confirmed!';
      const onConfirmed = window.__semacheckPendingOnConfirmed;
      if (onConfirmed) {
        await onConfirmed();
        document.getElementById('paymentProgressCard').style.display = 'none';
      }
    } catch (err) {
      if (err.alreadyUsed) {
        alertBox.innerHTML = `
          <div class="alert alert-err">${err.message}</div>
          <button class="btn btn-amber btn-block" id="restartPaymentBtn" style="margin-top:10px;">Make a new payment</button>
        `;
        document.getElementById('restartPaymentBtn').addEventListener('click', () => {
          document.getElementById('paymentProgressCard').style.display = 'none';
        });
      } else {
        alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    }
  });

  function renderSearchResult(payload) {
    const r = payload.result;
    const box = document.getElementById('search');
    let existing = document.getElementById('searchResultBox');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'searchResultBox';
    div.className = 'search-card';
    div.style.marginTop = '16px';
    div.innerHTML = `
      <div class="alert alert-ok" style="margin-bottom:14px;">✓ Payment successful — here's your result.</div>
      <span class="verdict verdict-${r.verdict}">${r.verdict.toUpperCase()}</span>
      ${r.confidence_score ? `<p style="margin-top:10px;color:var(--text-muted);font-size:0.88rem;">Confidence: ${r.confidence_score}%</p>` : ''}
      ${r.summary ? `<p style="margin-top:10px;font-size:0.92rem;">${r.summary}</p>` : ''}
      ${r.sources ? `<p style="margin-top:10px;font-size:0.8rem;color:var(--text-muted);">Sources checked: ${(r.sources.external_sources || []).length} web result(s), ${r.sources.db_signal ? r.sources.db_signal.reduce((a,b)=>a+b.n,0) : 0} internal report(s)</p>` : ''}
      ${payload.fromCache ? '<p style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);">⚡ Instant result — already verified.</p>' : ''}
    `;
    box.parentNode.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------------- contact form ----------------
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
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });
});
