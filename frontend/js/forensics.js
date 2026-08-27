// js/forensics.js — fraud-recovery case intake, eligibility check, payment, status
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
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    Object.assign(err, data);
    throw err;
  }
  return data;
}

function statusPill(status) {
  const map = {
    awaiting_payment: 'pending', submitted: 'pending', under_review: 'pending',
    in_progress: 'pending', resolved: 'approved', closed: 'rejected',
  };
  return `<span class="pill pill-${map[status] || 'pending'}">${status.replace('_', ' ')}</span>`;
}

let currentCaseId = null;

document.addEventListener('DOMContentLoaded', () => {
  const user = getUser();
  if (!user || !getToken()) { window.location.href = 'index.html'; return; }
  document.getElementById('forensicsUserName').textContent = `Hi, ${user.fullName?.split(' ')[0] || ''}`;

  document.getElementById('forensicsLogout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    clearSession();
    window.location.href = 'index.html';
  });

  loadMyCases();

  // ---------------- live eligibility feedback ----------------
  document.getElementById('amountLost').addEventListener('input', (e) => {
    const msg = document.getElementById('amountLostMsg');
    const val = Number(e.target.value);
    if (!e.target.value) { msg.textContent = ''; return; }
    if (val < 1000) {
      msg.textContent = 'This service is currently available for losses of KES 1,000 or more.';
      msg.className = 'field-msg err';
    } else {
      msg.textContent = '';
    }
  });

  // ---------------- step 1: intake ----------------
  document.getElementById('submitIntakeBtn').addEventListener('click', async () => {
    const alertBox = document.getElementById('intakeAlert');
    alertBox.innerHTML = '';
    const amountLost = Number(document.getElementById('amountLost').value);
    const scamDescription = document.getElementById('scamDescription').value.trim();
    const evidenceNotes = document.getElementById('evidenceNotes').value.trim();
    const contactPhone = document.getElementById('contactPhone').value.trim();

    if (!amountLost) { alertBox.innerHTML = '<div class="alert alert-err">Enter how much you lost.</div>'; return; }
    if (amountLost < 1000) { alertBox.innerHTML = '<div class="alert alert-err">This service is currently available for losses of KES 1,000 or more.</div>'; return; }
    if (scamDescription.length < 20) { alertBox.innerHTML = '<div class="alert alert-err">Describe what happened in a bit more detail.</div>'; return; }

    try {
      const r = await api('/forensics/intake', {
        method: 'POST',
        body: JSON.stringify({ amountLost, scamDescription, evidenceNotes, contactPhone }),
      });
      currentCaseId = r.case.id;
      document.getElementById('intakeCard').style.display = 'none';
      document.getElementById('feeCard').style.display = 'block';
      document.getElementById('feeCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
    }
  });

  // ---------------- step 2: pay the case fee ----------------
  document.getElementById('payFeeBtn').addEventListener('click', async () => {
    const phone = prompt('M-Pesa number to pay KES 849 from:', '');
    if (!phone) return;
    try {
      const r = await api('/payments/forensics-case', { method: 'POST', body: JSON.stringify({ caseId: currentCaseId, phone }) });
      document.getElementById('feeCard').style.display = 'none';
      await waitForPaymentThenRun({
        paymentId: r.paymentId,
        initialMessage: r.message || `STK push sent to ${phone}. Enter your M-Pesa PIN to submit your case.`,
        onConfirmed: async () => {
          document.getElementById('confirmationCard').style.display = 'block';
          document.getElementById('confirmationCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          await loadMyCases();
        },
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
      const r = await api(`/payments/${paymentId}/confirm-manual`, { method: 'POST', body: JSON.stringify({ mpesaCode: code }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
      input.disabled = true;
      document.getElementById('manualCodeSubmit').disabled = true;
      await pollForManualReviewOutcome(paymentId, window.__semacheckPendingOnConfirmed);
    } catch (err) {
      if (err.alreadyUsed) {
        alertBox.innerHTML = `
          <div class="alert alert-err">${err.message}</div>
          <button class="btn btn-amber btn-block" id="restartPaymentBtn" style="margin-top:10px;">Make a new payment</button>
        `;
        document.getElementById('restartPaymentBtn').addEventListener('click', () => {
          document.getElementById('paymentProgressCard').style.display = 'none';
          document.getElementById('feeCard').style.display = 'block';
        });
      } else {
        alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    }
  });

  /**
   * Same circular-loader polling pattern used for search and subscription
   * payments: never assumes success just because the STK push was sent —
   * waits for the backend to actually confirm it, with a manual M-Pesa-
   * code fallback if the confirmation never arrives.
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
        hint.textContent = 'Submitting your case…';
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

  /**
   * A manually-submitted M-Pesa code never unlocks anything by itself —
   * see the honest explanation in backend/routes/payments.js
   * /:paymentId/confirm-manual. It only stages the payment for a human
   * admin to check against the real M-Pesa statement. This polls for
   * that outcome, separately from (and slower than) the initial STK-push
   * poll, since it's now waiting on a person rather than an instant
   * gateway callback.
   */
  async function pollForManualReviewOutcome(paymentId, onConfirmed) {
    const statusText = document.getElementById('ppStatusText');
    const hint = document.getElementById('ppHint');
    const card = document.getElementById('paymentProgressCard');
    const circular = document.getElementById('ppCircular');

    statusText.textContent = 'Code received — verifying…';
    hint.textContent = 'An admin checks this against the real M-Pesa statement. This can take a little while.';

    const POLL_EVERY_MS = 8000;
    const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        if (Date.now() - startedAt > ACTIVE_WINDOW_MS) {
          clearInterval(timer);
          hint.textContent = "Still awaiting verification. It's safe to close this and check back later — your case isn't lost.";
          resolve();
          return;
        }
        try {
          const status = await api(`/payments/status/${paymentId}`);
          if (status.status === 'success') {
            clearInterval(timer);
            circular.classList.add('done');
            statusText.textContent = 'Payment confirmed!';
            hint.textContent = 'Submitting your case…';
            try {
              await onConfirmed();
              card.style.display = 'none';
            } catch (err) {
              hint.textContent = err.message || 'Something went wrong.';
            }
            resolve();
          } else if (status.status === 'failed') {
            clearInterval(timer);
            statusText.textContent = 'This code could not be verified.';
            hint.textContent = status.rejectionReason || 'Please contact support, or make a new payment.';
            resolve();
          }
        } catch (err) {
          // transient poll failure — keep trying until the active window ends
        }
      }, POLL_EVERY_MS);
    });
  }
});

async function loadMyCases() {
  const box = document.getElementById('myCasesList');
  try {
    const r = await api('/forensics/my-cases');
    if (!r.cases.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No cases yet.</p>'; return; }
    box.innerHTML = r.cases.map((c) => `
      <div class="job-item">
        <div>
          <b>KES ${Number(c.amount_lost).toLocaleString()}</b>
          <div style="font-size:0.82rem;color:var(--text-muted);">Opened ${new Date(c.created_at).toLocaleDateString()}</div>
        </div>
        ${statusPill(c.status)}
      </div>
    `).join('');
  } catch (err) {
    box.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}
