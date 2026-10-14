
const API_BASE = 'https://semacheck.onrender.com/api';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Session token lives in an HttpOnly cookie — never stored in JS.
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }function clearSession() {
  sessionStorage.removeItem('semacheck_user');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [5000, 10000, 15000, 20000, 25000];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include', cache: 'no-store' });
      if ((res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        var wn = document.getElementById('apiWakeNotice');
        if (!wn) {
          wn = document.createElement('div');
          wn.id = 'apiWakeNotice';
          wn.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          document.body.appendChild(wn);
        }
        wn.textContent = 'Server is waking up, please wait... (attempt ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) + ')';
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wnOk = document.getElementById('apiWakeNotice');
      if (wnOk) wnOk.remove();
      let data = {};
      try { data = await res.json(); } catch {  }
      if (!res.ok) {
        if (res.status === 401) {
          // Session cookie expired or missing — back to the login page.
          clearSession();
          window.location.replace('index.html');
        }
        const err = new Error(data.error || 'Something went wrong.');
        Object.assign(err, data);
        throw err;
      }
      return data;
    } catch (fetchErr) {
      if (fetchErr.name === 'TypeError' && attempt < MAX_RETRIES) {
        var wn2 = document.getElementById('apiWakeNotice');
        if (!wn2) {
          wn2 = document.createElement('div');
          wn2.id = 'apiWakeNotice';
          wn2.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          document.body.appendChild(wn2);
        }
        wn2.textContent = 'Server is waking up, please wait... (attempt ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) + ')';
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wnFail = document.getElementById('apiWakeNotice');
      if (wnFail) wnFail.remove();
      throw fetchErr;
    }
  }
}

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
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const user = getUser();
    if (!user || user.accountType !== 'job_owner') {
      window.location.replace('index.html');
    }
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', (e) => {
    closeModal(e.target.closest('.modal-overlay').id);
  }));
  document.querySelectorAll('.modal-overlay').forEach((ov) => ov.addEventListener('click', (e) => {
    if (e.target === ov) closeModal(ov.id);
  }));
  const user = getUser();
  if (!user || user.accountType !== 'job_owner') {
    window.location.replace('index.html');
    return;
  }
  document.getElementById('dashUserName').textContent = `Hi, ${user.fullName?.split(' ')[0] || ''}`;

  document.getElementById('dashLogout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    sessionStorage.clear();
    window.location.replace('index.html');
  });

  await loadSummary();
  await loadJobs();

  document.getElementById('postJobBtn').addEventListener('click', async () => {
    const alertBox = document.getElementById('postJobAlert');
    alertBox.innerHTML = '';
    const payload = {
      title: document.getElementById('jobTitle').value.trim(),
      companyName: document.getElementById('jobCompany').value.trim(),
      location: document.getElementById('jobLocation').value.trim(),
      contactPhone: document.getElementById('jobPhone').value.trim(),
      description: document.getElementById('jobDescription').value.trim(),
    };
    try {
      const r = await api('/jobs', { method: 'POST', body: JSON.stringify(payload) });
      alertBox.innerHTML = `<div class="alert alert-ok">${escapeHtml(r.message)}</div>`;
      ['jobTitle','jobCompany','jobLocation','jobPhone','jobDescription'].forEach((id) => document.getElementById(id).value = '');
      await loadJobs(); await loadSummary();
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById('subscribeBtn').addEventListener('click', async () => {
    const phone = await askForPhone();
    if (!phone) return;
    const pp = document.getElementById('paymentProgressCard');
    const ppCircular = document.getElementById('ppCircular');
    const ppStatus = document.getElementById('ppStatusText');
    const ppHint = document.getElementById('ppHint');
    pp.style.display = 'block';
    ppCircular.className = 'pp-circular';
    ppStatus.textContent = 'Processing your subscription';
    ppHint.textContent = 'Sending M-Pesa STK push to your phone...';
    pp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const r = await api('/payments/subscription', { method: 'POST', body: JSON.stringify({ phone }) });
      ppStatus.textContent = 'Enter your M-Pesa PIN';
      ppHint.textContent = 'An STK prompt has been sent to your phone. Enter your PIN to confirm payment.';
      await waitForPaymentThenRun({
        paymentId: r.paymentId,
        onConfirmed: async () => { await loadSummary(); await loadJobs(); },
      });
    } catch (err) {
      ppCircular.className = 'pp-circular';
      ppStatus.textContent = 'Something went wrong.';
      ppHint.textContent = escapeHtml(err.message);
    }
  });

  
  document.getElementById('cpNew')?.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  function secMsg(kind, text) {
    document.getElementById('secAlert').innerHTML = `<div class="alert alert-${kind}">${escapeHtml(text)}</div>`;
  }

  document.getElementById('cpSubmit')?.addEventListener('click', async () => {
    const confirmMsg = document.getElementById('cpConfirmMsg');
    confirmMsg.textContent = '';
    confirmMsg.className = 'field-msg';
    const current = document.getElementById('cpCurrent').value;
    const next = document.getElementById('cpNew').value;
    const confirm = document.getElementById('cpConfirm').value;
    if (!current) { secMsg('err', 'Enter your current password.'); return; }
    if (next !== confirm) {
      confirmMsg.textContent = 'Passwords do not match.';
      confirmMsg.className = 'field-msg err';
      return;
    }
    if (next.length < 8) {
      confirmMsg.textContent = 'Use at least 8 characters.';
      confirmMsg.className = 'field-msg err';
      return;
    }
    try {
      const r = await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      secMsg('ok', r.message);
      document.getElementById('cpCurrent').value = '';
      document.getElementById('cpNew').value = '';
      document.getElementById('cpConfirm').value = '';
      renderStrengthMeter('');
    } catch (err) {
      secMsg('err', err.message);
    }
  });

  async function load2faStatus() {
    try {
      const r = await api('/auth/2fa/status');
      document.getElementById('tfaStatus').textContent = r.enabled
        ? 'Two-factor authentication is ON. You enter a code from your app each time you log in.'
        : 'Two-factor authentication is off. Turn it on so a stolen password alone cannot open your account.';
      document.getElementById('tfaSetupBtn').style.display = r.enabled ? 'none' : 'inline-flex';
      document.getElementById('tfaDisableRow').style.display = r.enabled ? 'block' : 'none';
      document.getElementById('tfaSetup').style.display = 'none';
    } catch {
      document.getElementById('tfaStatus').textContent = 'Two-factor status unavailable right now.';
    }
  }
  load2faStatus();

  document.getElementById('tfaSetupBtn')?.addEventListener('click', async () => {
    try {
      const r = await api('/auth/2fa/setup', { method: 'POST' });
      document.getElementById('tfaSecret').textContent = r.secret;
      document.getElementById('tfaCode').value = '';
      document.getElementById('tfaSetup').style.display = 'block';
      document.getElementById('tfaSetupBtn').style.display = 'none';
    } catch (err) {
      secMsg('err', err.message);
    }
  });

  document.getElementById('tfaCancelBtn')?.addEventListener('click', () => {
    document.getElementById('tfaSetup').style.display = 'none';
    document.getElementById('tfaSetupBtn').style.display = 'inline-flex';
  });

  document.getElementById('tfaEnableBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('tfaCode').value.trim();
    if (!/^\d{6}$/.test(code)) { secMsg('err', 'Enter the 6-digit code from your authenticator app.'); return; }
    try {
      const r = await api('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) });
      secMsg('ok', r.message);
      load2faStatus();
    } catch (err) {
      secMsg('err', err.message);
    }
  });

  document.getElementById('tfaDisableBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('tfaDisableCode').value.trim();
    if (!/^\d{6}$/.test(code)) { secMsg('err', 'Enter the 6-digit code from your app to confirm.'); return; }
    try {
      const r = await api('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) });
      secMsg('ok', r.message);
      document.getElementById('tfaDisableCode').value = '';
      load2faStatus();
    } catch (err) {
      secMsg('err', err.message);
    }
  });

  async function waitForPaymentThenRun({ paymentId, onConfirmed }) {
    const card = document.getElementById('paymentProgressCard');
    const statusText = document.getElementById('ppStatusText');
    const circular = document.getElementById('ppCircular');
    const hint = document.getElementById('ppHint');

    card.style.display = 'block';
    circular.className = 'pp-circular';

    const POLL_EVERY_MS = 2500;
    const TIMEOUT_MS = 45000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        circular.className = 'pp-circular done';
        statusText.textContent = 'Success!';
        hint.textContent = 'Payment confirmed. Updating your subscription...';
        await new Promise((r) => setTimeout(r, 1200));
        try {
          await onConfirmed();
          card.style.display = 'none';
        } catch (err) {
          hint.textContent = err.message || 'Something went wrong.';
        }
        resolve();
      };

      const showTimeoutOrFailure = (statusMsg) => {
        clearInterval(timer);
        circular.className = 'pp-circular failed';
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
});

async function loadSummary() {
  try {
    const r = await api('/jobs/dashboard-summary');
    document.getElementById('subDays').textContent = r.subscription.daysRemaining;
    const counts = Object.fromEntries((r.jobCounts || []).map((c) => [c.status, c.n]));
    document.getElementById('statPending').textContent = counts.pending || 0;
    document.getElementById('statApproved').textContent = counts.approved || 0;
    document.getElementById('statRejected').textContent = counts.rejected || 0;

    const banner = document.getElementById('suspendedBanner');
    if (r.jobsSuspended) {
      banner.style.display = 'block';
      banner.textContent = "Your subscription has expired — your approved job posting(s) are temporarily hidden from search results until you renew.";
    } else {
      banner.style.display = 'none';
    }
  } catch (err) {
    document.getElementById('dashAlert').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}

async function loadJobs() {
  const list = document.getElementById('jobList');
  try {
    const r = await api('/jobs/mine');
    if (!r.jobs.length) { list.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No postings yet.</p>'; return; }
    list.innerHTML = r.jobs.map((j) => `
      <div class="job-item">
        <div>
          <b>${escapeHtml(j.title)}</b>
          <div style="font-size:0.82rem;color:var(--text-muted);">${escapeHtml(j.company_name)} &middot; ${escapeHtml(j.location || 'Nairobi')}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          <span class="status-pill status-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>
          ${j.status === 'approved' && !j.effective_visible ? '<span class="status-pill status-suspended" style="font-size:0.68rem;">suspended — renew to reactivate</span>' : ''}
          ${j.status === 'approved' && j.effective_visible ? '<span class="status-pill status-approved" style="font-size:0.68rem;">live in search</span>' : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}
