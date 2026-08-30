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
        hint.textContent = 'Submitting your case…';
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
