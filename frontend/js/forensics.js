
const API_BASE = 'https://semacheck.onrender.com/api';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getToken() { return sessionStorage.getItem('semacheck_token'); }
function getUser() { try { return JSON.parse(sessionStorage.getItem('semacheck_user') || 'null'); } catch { return null; } }function clearSession() {
  sessionStorage.removeItem('semacheck_token');
  sessionStorage.removeItem('semacheck_user');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [3000, 6000, 10000];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
      if ((res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        if (attempt === 0 && !document.getElementById('apiWakeNotice')) {
          var n = document.createElement('div');
          n.id = 'apiWakeNotice';
          n.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          n.textContent = 'Server is waking up, please wait...';
          document.body.appendChild(n);
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wn = document.getElementById('apiWakeNotice');
      if (wn) wn.remove();
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
        if (attempt === 0 && !document.getElementById('apiWakeNotice')) {
          var n2 = document.createElement('div');
          n2.id = 'apiWakeNotice';
          n2.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0d9488;color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:500;';
          n2.textContent = 'Server is waking up, please wait...';
          document.body.appendChild(n2);
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      var wn2 = document.getElementById('apiWakeNotice');
      if (wn2) wn2.remove();
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

function statusPill(status) {
  const map = {
    awaiting_payment: 'pending', submitted: 'pending', under_review: 'pending',
    in_progress: 'pending', resolved: 'approved', closed: 'rejected',
  };
  return `<span class="pill pill-${map[status] || 'pending'}">${status.replace('_', ' ')}</span>`;
}

let currentCaseId = null;

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const user = getUser();
    if (!user || !getToken()) {
      window.location.replace('index.html');
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', (e) => {
    closeModal(e.target.closest('.modal-overlay').id);
  }));
  document.querySelectorAll('.modal-overlay').forEach((ov) => ov.addEventListener('click', (e) => {
    if (e.target === ov) closeModal(ov.id);
  }));

  const user = getUser();
  if (!user || !getToken()) { window.location.replace('index.html'); return; }
  document.getElementById('forensicsUserName').textContent = `Hi, ${user.fullName?.split(' ')[0] || ''}`;

  document.getElementById('forensicsLogout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    sessionStorage.clear();
    window.location.replace('index.html');
  });

  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  const type = params.get('type');
  const verdict = params.get('verdict');
  if (q) {
    const desc = document.getElementById('scamDescription');
    if (desc && !desc.value) {
      desc.value = `I was scammed via a ${type === 'job_offer' ? 'job offer' : type === 'paybill' ? 'paybill number' : 'phone number'}. The query checked was: "${q}". Verdict: ${verdict}. `;
    }
  }

  loadMyCases();

  
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
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    }
  });

  
  document.getElementById('payFeeBtn').addEventListener('click', async () => {
    const phone = await askForPhone();
    if (!phone) return;
    const pp = document.getElementById('paymentProgressCard');
    const ppCircular = document.getElementById('ppCircular');
    const ppStatus = document.getElementById('ppStatusText');
    const ppHint = document.getElementById('ppHint');
    pp.style.display = 'block';
    ppCircular.className = 'pp-circular';
    ppStatus.textContent = 'Processing your case';
    ppHint.textContent = 'Sending M-Pesa STK push to your phone...';
    pp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const r = await api('/payments/forensics-case', { method: 'POST', body: JSON.stringify({ caseId: currentCaseId, phone }) });
      document.getElementById('feeCard').style.display = 'none';
      ppStatus.textContent = 'Enter your M-Pesa PIN';
      ppHint.textContent = 'An STK prompt has been sent to your phone. Enter your PIN to confirm payment.';
      await waitForPaymentThenRun({
        paymentId: r.paymentId,
        onConfirmed: async () => {
          document.getElementById('confirmationCard').style.display = 'block';
          document.getElementById('confirmationCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          await loadMyCases();
        },
      });
    } catch (err) {
      ppCircular.className = 'pp-circular';
      ppStatus.textContent = 'Something went wrong.';
      ppHint.textContent = escapeHtml(err.message);
    }
  });  async function waitForPaymentThenRun({ paymentId, onConfirmed }) {
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
        hint.textContent = 'Payment confirmed. Submitting your case...';
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
    box.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}
