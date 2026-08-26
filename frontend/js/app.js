// js/app.js
const API_BASE = 'https://csswkinuufdspxcsnfrd.supabase.co/functions/v1';

// - session helpers -
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
  
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  
  let data = {};
  try { 
    data = await res.json(); 
  } catch (e) {
    console.error('Failed to parse JSON response:', e);
  }
  
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    Object.assign(err, data); 
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
      <span style="color:#cfd9ea;font-size:0.9rem;margin-right:6px;">Hi, ${user.fullName?.split(' ')[0] || user.email || 'there'}</span>
      ${user.accountType === 'job_owner' ? '<a class="btn btn-outline" href="dashboard.html">Dashboard</a>' : ''}
      <button class="btn btn-primary" id="logoutBtn">Log out</button>`;
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  } else {
    area.innerHTML = `
      <button class="btn btn-outline" id="openLogin">Log in</button>
      <button class="btn btn-primary" id="openSignup">Sign up</button>`;
    document.getElementById('openLogin')?.addEventListener('click', () => openModal('loginOverlay'));
    document.getElementById('openSignup')?.addEventListener('click', () => openModal('signupOverlay'));
  }
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  clearSession();
  updateAuthUI();
  window.location.href = 'index.html';
}

// -- modal plumbing --
function openModal(id) { 
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open'); 
}
function closeModal(id) { 
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open'); 
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize auth UI
  updateAuthUI();

  // Modal open/close handlers
  document.getElementById('openLogin')?.addEventListener('click', () => openModal('loginOverlay'));
  document.getElementById('openSignup')?.addEventListener('click', () => openModal('signupOverlay'));
  document.getElementById('openSignupJobOwner')?.addEventListener('click', () => {
    openModal('signupOverlay');
    document.querySelector('[data-account-type="job_owner"]')?.click();
  });
  
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', (e) => {
    const overlay = e.target.closest('.modal-overlay');
    if (overlay) closeModal(overlay.id);
  }));
  
  document.querySelectorAll('.modal-overlay').forEach((ov) => ov.addEventListener('click', (e) => {
    if (e.target === ov) closeModal(ov.id);
  }));
  
  document.querySelectorAll('[data-switch-to]').forEach((btn) => btn.addEventListener('click', () => {
    closeModal('loginOverlay'); 
    closeModal('signupOverlay');
    openModal(btn.dataset.switchTo === 'signup' ? 'signupOverlay' : 'loginOverlay');
  }));

  // account type toggle
  let currentAccountType = 'regular';
  document.querySelectorAll('[data-account-type]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('[data-account-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAccountType = btn.dataset.accountType;
    const jobFields = document.getElementById('jobOwnerFields');
    if (jobFields) jobFields.classList.toggle('show', currentAccountType === 'job_owner');
  }));

  // live password strength
  document.getElementById('suPassword')?.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  // live email check
  const checkEmail = debounce(async (email) => {
    const msg = document.getElementById('suEmailMsg');
    if (!isValidEmailClient(email)) { 
      if (msg) { msg.textContent = 'Enter a valid email address.'; msg.className = 'field-msg err'; }
      return; 
    }
    try {
      const r = await api(`/auth/check-email?email=${encodeURIComponent(email)}`);
      if (msg) { msg.textContent = r.valid ? 'Looks good.' : r.reason; msg.className = `field-msg ${r.valid ? 'ok' : 'err'}`; }
    } catch { if (msg) msg.textContent = ''; }
  }, 500);
  
  document.getElementById('suEmail')?.addEventListener('input', (e) => checkEmail(e.target.value));

  // live phone check
  const checkPhone = debounce(async (phone) => {
    const msg = document.getElementById('suPhoneMsg');
    if (!normalizeKenyanPhoneClient(phone)) { 
      if (msg) { msg.textContent = 'Enter a valid Safaricom-format number, e.g. 07XXXXXXXX.'; msg.className = 'field-msg err'; }
      return; 
    }
    try {
      const r = await api(`/auth/check-phone?phone=${encodeURIComponent(phone)}`);
      if (msg) { msg.textContent = r.valid ? (r.note || 'Looks good.') : r.reason; msg.className = `field-msg ${r.valid ? 'ok' : 'err'}`; }
    } catch { if (msg) msg.textContent = ''; }
  }, 500);
  
  document.getElementById('suPhone')?.addEventListener('input', (e) => checkPhone(e.target.value));

  // - signup submit -
  let pendingOtpEmail = null;

  document.getElementById('signupSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('signupAlert');
    if (alertBox) alertBox.innerHTML = '';
    const btn = document.getElementById('signupSubmit');
    const label = document.getElementById('signupBtnLabel');

    const consentMsg = document.getElementById('suConsentMsg');
    if (!document.getElementById('suConsent').checked) {
      if (consentMsg) consentMsg.style.display = 'block';
      return;
    }
    if (consentMsg) consentMsg.style.display = 'none';

    const idFile = document.getElementById('suIdDocument').files[0];
    if (!idFile) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-err">Upload a photo or scan of your ID.</div>';
      return;
    }

    const password = document.getElementById('suPassword').value;
    const passwordConfirm = document.getElementById('suPasswordConfirm').value;
    const confirmMsg = document.getElementById('suPasswordConfirmMsg');
    if (password !== passwordConfirm) {
      if (confirmMsg) { confirmMsg.textContent = 'Passwords do not match.'; confirmMsg.className = 'field-msg err'; }
      return;
    }
    if (confirmMsg) confirmMsg.textContent = '';

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

    btn.disabled = true; 
    if (label) label.innerHTML = '<span class="spinner"></span> Creating account...';
    
    try {
      const result = await api('/auth/signup', { method: 'POST', body: formData });
      pendingOtpEmail = email;
      closeModal('signupOverlay');
      const otpLabel = document.getElementById('otpEmailLabel');
      if (otpLabel) otpLabel.textContent = email;
      const otpAlert = document.getElementById('otpAlert');
      if (otpAlert) otpAlert.innerHTML = '';
      const otpInput = document.getElementById('otpCodeInput');
      if (otpInput) otpInput.value = '';
      openModal('otpOverlay');
    } catch (err) {
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    } finally {
      btn.disabled = false; 
      if (label) label.textContent = 'Create account';
    }
  });

  // -OTP verification -
  document.getElementById('otpSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('otpAlert');
    const code = document.getElementById('otpCodeInput').value.trim();
    const btn = document.getElementById('otpSubmit');
    const label = document.getElementById('otpBtnLabel');
    if (alertBox) alertBox.innerHTML = '';
    
    if (!code) { 
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-err">Enter the 6-digit code.</div>'; 
      return; 
    }

    btn.disabled = true; 
    if (label) label.innerHTML = '<span class="spinner"></span> Verifying...';
    
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
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    } finally {
      btn.disabled = false; 
      if (label) label.textContent = 'Verify & continue';
    }
  });

  document.getElementById('otpResend')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('otpAlert');
    try {
      const r = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: pendingOtpEmail }) });
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
    } catch (err) {
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });

  // ---------------- login submit ----------------
  document.getElementById('loginSubmit')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('loginAlert');
    if (alertBox) alertBox.innerHTML = '';
    const btn = document.getElementById('loginSubmit');
    const label = document.getElementById('loginBtnLabel');
    
    btn.disabled = true; 
    if (label) label.innerHTML = '<span class="spinner"></span> Logging in...';
    
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
        const otpLabel = document.getElementById('otpEmailLabel');
        if (otpLabel) otpLabel.textContent = pendingOtpEmail;
        const otpAlert = document.getElementById('otpAlert');
        if (otpAlert) otpAlert.innerHTML = '<div class="alert alert-err">Verify your email to continue.</div>';
        const otpInput = document.getElementById('otpCodeInput');
        if (otpInput) otpInput.value = '';
        openModal('otpOverlay');
      } else {
        if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    } finally {
      btn.disabled = false; 
      if (label) label.textContent = 'Log in';
    }
  });

  // - search tabs / tiers -
  let searchType = 'paybill';
  let searchTier = 50;
  
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    searchType = tab.dataset.type;
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.placeholder = searchType === 'paybill' ? 'e.g. 400200' : searchType === 'phone' ? 'e.g. 0712345678' : 'Paste the job offer text here';
    }
  }));
  
  document.querySelectorAll('.tier').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tier').forEach((x) => x.classList.remove('selected'));
    t.classList.add('selected');
    searchTier = Number(t.dataset.tier);
  }));

  // - search flow -
  document.getElementById('searchBtn')?.addEventListener('click', async () => {
    const value = document.getElementById('searchInput').value.trim();
    if (!value) return;
    if (!getToken()) {
      openModal('loginOverlay');
      const loginAlert = document.getElementById('loginAlert');
      if (loginAlert) loginAlert.innerHTML = '<div class="alert alert-err">Create an account or log in first — every search is tied to your account.</div>';
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

  // - payment progress -
  async function waitForPaymentThenRun({ paymentId, initialMessage, onConfirmed }) {
    const card = document.getElementById('paymentProgressCard');
    const statusText = document.getElementById('ppStatusText');
    const circular = document.getElementById('ppCircular');
    const hint = document.getElementById('ppHint');
    const manualBox = document.getElementById('manualCodeBox');

    if (card) card.style.display = 'block';
    if (manualBox) manualBox.style.display = 'none';
    if (circular) circular.classList.remove('done');
    
    const manualAlert = document.getElementById('manualCodeAlert');
    if (manualAlert) manualAlert.innerHTML = '';
    
    const manualInput = document.getElementById('manualCodeInput');
    if (manualInput) manualInput.value = '';
    
    if (statusText) statusText.textContent = initialMessage;
    if (hint) hint.textContent = 'Check your phone and enter your M-Pesa PIN. This usually takes a few seconds.';
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const POLL_EVERY_MS = 2500;
    const TIMEOUT_MS = 45000; 
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        if (circular) circular.classList.add('done');
        if (statusText) statusText.textContent = 'Payment confirmed!';
        if (hint) hint.innerHTML = '<span class="receipt-printing-icon">⚙</span> Printing your receipt…';
        await new Promise((r) => setTimeout(r, 700)); 
        try {
          await onConfirmed();
          if (card) card.style.display = 'none';
        } catch (err) {
          if (hint) hint.textContent = err.message || 'Something went wrong loading your result.';
        }
        resolve();
      };

      const showFallback = (statusMsg, hintMsg) => {
        clearInterval(timer);
        if (statusText) statusText.textContent = statusMsg;
        if (hint) hint.textContent = hintMsg;
        if (manualBox) manualBox.style.display = 'block';
        const manualInput = document.getElementById('manualCodeInput');
        if (manualInput) manualInput.dataset.paymentId = paymentId;
        window.__semacheckPendingOnConfirmed = onConfirmed;
        window.__semacheckRestartPayment = () => { if (card) card.style.display = 'none'; };
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
          if (status.status === 'success') { 
            finishSuccess(); 
          } else if (status.status === 'failed') {
            showFallback('Payment failed or was cancelled.', 'If you completed the M-Pesa prompt anyway, use the box below to confirm manually.');
          }
        } catch (err) {
          // Ignore errors
        }
      }, POLL_EVERY_MS);
    });
  }

  document.getElementById('manualCodeSubmit')?.addEventListener('click', async () => {
    const input = document.getElementById('manualCodeInput');
    const alertBox = document.getElementById('manualCodeAlert');
    const paymentId = input?.dataset.paymentId;
    const code = input?.value.trim();
    if (alertBox) alertBox.innerHTML = '';
    
    if (!code) { 
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-err">Enter the M-Pesa code from your confirmation SMS.</div>'; 
      return; 
    }
    
    try {
      await api(`/payments/${paymentId}/confirm-manual`, { method: 'POST', body: JSON.stringify({ mpesaCode: code }) });
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-ok">Payment confirmed. Loading your result…</div>';
      
      const circular = document.getElementById('ppCircular');
      const statusText = document.getElementById('ppStatusText');
      if (circular) circular.classList.add('done');
      if (statusText) statusText.textContent = 'Payment confirmed!';
      
      const onConfirmed = window.__semacheckPendingOnConfirmed;
      if (onConfirmed) {
        await onConfirmed();
        const card = document.getElementById('paymentProgressCard');
        if (card) card.style.display = 'none';
      }
    } catch (err) {
      if (err.alreadyUsed) {
        if (alertBox) {
          alertBox.innerHTML = `
            <div class="alert alert-err">${err.message}</div>
            <button class="btn btn-amber btn-block" id="restartPaymentBtn" style="margin-top:10px;">Make a new payment</button>
          `;
          document.getElementById('restartPaymentBtn')?.addEventListener('click', () => {
            const card = document.getElementById('paymentProgressCard');
            if (card) card.style.display = 'none';
          });
        }
      } else {
        if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    }
  });

  // - result renderer -
  function renderSearchResult(payload) {
    const r = payload.result;
    const outer = document.getElementById('receiptOuter');
    const slot = document.getElementById('receiptPaperSlot');

    const verdictLabels = { legit: 'LEGIT', scam: 'SCAM', suspicious: 'SUSPICIOUS', unverified: 'UNVERIFIED' };
    const now = new Date();
    const timestamp = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sourceCount = r.sources ? (r.sources.external_sources || []).length : null;
    const dbCount = r.sources && r.sources.db_signal ? r.sources.db_signal.reduce((a, b) => a + b.n, 0) : null;

    if (slot) {
      slot.innerHTML = `
        <div class="receipt-paper">
          <div class="receipt-head">
            <img src="assets/logo.png" alt="SemaCheck">
            <div class="r-sub">Verification receipt</div>
          </div>
          <hr class="receipt-divider">
          <div class="receipt-row"><span class="r-label">Date</span><span class="r-value">${timestamp}</span></div>
          <div class="receipt-row"><span class="r-label">Query type</span><span class="r-value">${searchType.replace('_', ' ')}</span></div>
          <div class="receipt-row"><span class="r-label">Amount paid</span><span class="r-value">KES ${searchTier}</span></div>
          <hr class="receipt-divider">
          <div class="receipt-verdict-line v-${r.verdict}">
            <div class="r-verdict-word">${verdictLabels[r.verdict] || r.verdict.toUpperCase()}</div>
            ${r.confidence_score ? `<div style="font-size:0.78rem;color:#666;margin-top:2px;">${r.confidence_score}% confidence</div>` : ''}
          </div>
          ${r.summary ? `<hr class="receipt-divider"><div class="receipt-summary">${r.summary}</div>` : ''}
          ${sourceCount !== null ? `<div class="receipt-sources">Sources checked: ${sourceCount} web result(s), ${dbCount || 0} internal report(s)</div>` : ''}
          ${payload.fromCache ? '<div class="receipt-sources">⚡ Instant result — already verified by SemaCheck.</div>' : ''}
          <div class="receipt-barcode"></div>
          <div class="receipt-footer">THANK YOU FOR USING SEMACHECK &middot; SEMACHECK.CO.KE</div>
        </div>
      `;
    }

    if (outer) {
      outer.classList.remove('open');
      void outer.offsetHeight;
      requestAnimationFrame(() => outer.classList.add('open'));
      setTimeout(() => outer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
    }
  }

  // - contact form -
  document.getElementById('contactSendBtn')?.addEventListener('click', async () => {
    const alertBox = document.getElementById('contactAlert');
    const email = document.getElementById('contactEmail')?.value.trim();
    const message = document.getElementById('contactMessage')?.value.trim();
    if (alertBox) alertBox.innerHTML = '';
    
    try {
      const r = await api('/contact', { method: 'POST', body: JSON.stringify({ email, message }) });
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
      const emailInput = document.getElementById('contactEmail');
      const msgInput = document.getElementById('contactMessage');
      if (emailInput) emailInput.value = '';
      if (msgInput) msgInput.value = '';
    } catch (err) {
      if (alertBox) alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });
});

// ---- helper utilities ----
function isValidEmailClient(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeKenyanPhoneClient(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '254' + cleaned.substring(1);
  }
  if (cleaned.startsWith('254') && cleaned.length === 12) {
    return cleaned;
  }
  return null;
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function renderStrengthMeter(password) {
  const meter = document.getElementById('passwordStrength');
  if (!meter) return;
  if (!password) {
    meter.innerHTML = '';
    return;
  }
  let score = 0;
  if (password.length >= 8) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  const labels = ['Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = ['#C62828', '#C62828', '#E65100', '#2E7D32', '#2E7D32'];
  meter.innerHTML = `
    <div style="display:flex;gap:4px;margin-top:4px;">
      <div style="flex:1;height:4px;background:${score >= 1 ? colors[score] : '#ddd'};border-radius:2px;"></div>
      <div style="flex:1;height:4px;background:${score >= 2 ? colors[score] : '#ddd'};border-radius:2px;"></div>
      <div style="flex:1;height:4px;background:${score >= 3 ? colors[score] : '#ddd'};border-radius:2px;"></div>
      <div style="flex:1;height:4px;background:${score >= 4 ? colors[score] : '#ddd'};border-radius:2px;"></div>
    </div>
    <div style="font-size:0.75rem;color:${colors[score] || '#666'};">${labels[score] || 'Weak'}</div>
  `;
}