// js/dashboard.js
const API_BASE = 'http://localhost:4800/api';

function getToken() { return sessionStorage.getItem('semacheck_token'); }
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }
function clearSession() { sessionStorage.removeItem('semacheck_token'); sessionStorage.removeItem('semacheck_user'); }

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch {  }
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

  /**
   * Waits for Tuma's own STK-push callback to confirm the payment —
   * that's the only thing that ever marks a payment 'success'. There is
   * no self-reported/manual code path: if the callback never arrives
   * within the polling window, the honest answer is that the payment
   * hasn't been confirmed — try again, or reach out via the contact
   * form / the critical-only WhatsApp line.
   */
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
        hint.textContent = 'Updating your subscription…';
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
