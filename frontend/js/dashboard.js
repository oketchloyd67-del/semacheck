// js/dashboard.js
const API_BASE = 'https://semacheck.onrender.com/api';

function getToken() { return sessionStorage.getItem('semacheck_token'); }
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }
function clearSession() { sessionStorage.removeItem('semacheck_token'); sessionStorage.removeItem('semacheck_user'); }

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    Object.assign(err, data);
    throw err;
  }
  return data;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = getUser();
  if (!user || !getToken() || user.accountType !== 'job_owner') {
    window.location.href = 'index.html';
    return;
  }
  document.getElementById('dashUserName').textContent = `Hi, ${user.fullName?.split(' ')[0] || ''}`;

  document.getElementById('dashLogout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    clearSession();
    window.location.href = 'index.html';
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
      alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
      ['jobTitle','jobCompany','jobLocation','jobPhone','jobDescription'].forEach((id) => document.getElementById(id).value = '');
      await loadJobs(); await loadSummary();
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });

  document.getElementById('subscribeBtn').addEventListener('click', async () => {
    const phone = prompt('M-Pesa number to pay KES 459 from:', '');
    if (!phone) return;
    try {
      const r = await api('/payments/subscription', { method: 'POST', body: JSON.stringify({ phone }) });
      await waitForPaymentThenRun({
        paymentId: r.paymentId,
        initialMessage: r.message || `STK push sent to ${phone}. Enter your M-Pesa PIN to activate your subscription.`,
        onConfirmed: async () => { await loadSummary(); await loadJobs(); },
      });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('manualCodeSubmit')?.addEventListener('click', async () => {
    const input = document.getElementById('manualCodeInput');
    const alertBox = document.getElementById('manualCodeAlert');
    const paymentId = input.dataset.paymentId;
    const code = input.value.trim();
    alertBox.innerHTML = '';
    if (!code) { alertBox.innerHTML = '<div class="alert alert-err">Enter the M-Pesa code from your confirmation SMS.</div>'; return; }
    try {
      await api(`/payments/${paymentId}/confirm-manual`, { method: 'POST', body: JSON.stringify({ mpesaCode: code }) });
      alertBox.innerHTML = '<div class="alert alert-ok">Payment confirmed. Refreshing your subscription…</div>';
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

  /**
   * Same circular-loader polling pattern as the homepage search flow
   * (frontend/js/app.js): waits for Tuma's callback to actually mark the
   * payment successful before proceeding, instead of assuming success
   * right after the STK push was merely sent. Falls back to a manual
   * M-Pesa-code box if it times out.
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
    const TIMEOUT_MS = 45000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const finishSuccess = async () => {
        clearInterval(timer);
        circular.classList.add('done');
        statusText.textContent = 'Payment confirmed!';
        hint.textContent = 'Updating your subscription…';
        try {
          await onConfirmed();
          card.style.display = 'none';
        } catch (err) {
          hint.textContent = err.message || 'Something went wrong.';
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
        } catch (err) {
          // transient poll failure — keep trying until timeout
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
    document.getElementById('dashAlert').innerHTML = `<div class="alert alert-err">${err.message}</div>`;
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
          <b>${j.title}</b>
          <div style="font-size:0.82rem;color:var(--text-muted);">${j.company_name} &middot; ${j.location || 'Nairobi'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          <span class="status-pill status-${j.status}">${j.status}</span>
          ${j.status === 'approved' && !j.effective_visible ? '<span class="status-pill status-suspended" style="font-size:0.68rem;">suspended — renew to reactivate</span>' : ''}
          ${j.status === 'approved' && j.effective_visible ? '<span class="status-pill status-approved" style="font-size:0.68rem;">live in search</span>' : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}
