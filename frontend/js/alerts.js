const API_BASE = 'https://semacheck.onrender.com/api';
const UNLOCK_KEY = 'scAlertUnlocks';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  // Session rides in an HttpOnly cookie — nothing readable by JS.
  const res = await fetch(`${API_BASE}${path}`, { ...options, body, headers, credentials: 'include', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Request failed. Please try again.');
  return data;
}

function getUnlocks() {
  try {
    return JSON.parse(localStorage.getItem(UNLOCK_KEY)) || {};
  } catch {
    return {};
  }
}

function saveUnlock(reportId, paymentId) {
  const map = getUnlocks();
  map[String(reportId)] = paymentId;
  localStorage.setItem(UNLOCK_KEY, JSON.stringify(map));
}

let currentPage = 1;
let currentType = '';
let currentQuery = '';
let loading = false;
let pendingReportId = null;

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
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
    if (alertBox) alertBox.innerHTML = '';
    openModal('phoneOverlay');
    input.focus();

    const cleanup = () => {
      closeModal('phoneOverlay');
      confirmBtn.removeEventListener('click', onConfirm);
      input.removeEventListener('keydown', onKey);
    };
    const onConfirm = () => {
      const val = input.value.trim();
      if (!val) { msg.textContent = 'Enter your M-Pesa number.'; msg.className = 'field-msg err'; return; }
      if (typeof normalizeKenyanPhoneClient === 'function' && !normalizeKenyanPhoneClient(val)) {
        msg.textContent = 'Enter a valid number, e.g. 07XXXXXXXX.';
        msg.className = 'field-msg err';
        return;
      }
      cleanup();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Enter') onConfirm(); };
    confirmBtn.addEventListener('click', onConfirm);
    input.addEventListener('keydown', onKey);

    overlay.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => { cleanup(); resolve(null); }, { once: true }));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } }, { once: true });
  });
}

function waitForPayment({ paymentId, onConfirmed }) {
  const overlay = document.getElementById('paymentPopupOverlay');
  const card = document.getElementById('paymentProgressCard');
  const statusText = document.getElementById('ppStatusText');
  const circular = document.getElementById('ppCircular');
  const hint = document.getElementById('ppHint');

  overlay.classList.add('open');
  card.style.display = '';
  circular.className = 'pp-circular';

  const POLL_EVERY_MS = 2500;
  const TIMEOUT_MS = 45000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const finishSuccess = async () => {
      clearInterval(timer);
      circular.className = 'pp-circular done';
      statusText.textContent = 'Success!';
      hint.textContent = 'Payment confirmed. Unlocking your report…';
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await onConfirmed();
        overlay.classList.remove('open');
      } catch (err) {
        hint.textContent = err.message || 'Something went wrong loading this report.';
        setTimeout(() => overlay.classList.remove('open'), 3500);
      }
      resolve();
    };

    const showFailure = (msg) => {
      clearInterval(timer);
      circular.className = 'pp-circular failed';
      statusText.textContent = msg;
      hint.textContent = "If you completed the M-Pesa prompt and this persists, please get in touch via the contact form — don't try paying again until you hear back.";
      setTimeout(() => overlay.classList.remove('open'), 5000);
      resolve();
    };

    const timer = setInterval(async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        showFailure("Still waiting — didn't get a confirmation yet.");
        return;
      }
      try {
        const status = await api(`/payments/status/${paymentId}`);
        if (status.status === 'success') finishSuccess();
        else if (status.status === 'failed') showFailure('Payment failed or was cancelled.');
      } catch {
      }
    }, POLL_EVERY_MS);
  });
}

function typeLabel(type) {
  const map = { phone: 'Phone number', paybill: 'Paybill', business: 'Business', website: 'Website', job: 'Job offer' };
  return map[type] || type;
}

function detailHtml(r) {
  return `
    <div class="alert-full" style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
      <div style="font-size:0.92rem; line-height:1.55; white-space:pre-line;">${escapeHtml(r.description || 'No further description was provided for this report.')}</div>
      ${r.name ? `<div style="margin-top:8px; font-size:0.86rem;"><b>Name on record:</b> ${escapeHtml(r.name)}</div>` : ''}
      <div style="margin-top:10px; display:flex; gap:14px; flex-wrap:wrap;">
        <a href="dispute.html?id=${encodeURIComponent(r.id)}" style="font-size:0.84rem; color:#c2410c; font-weight:600;">Dispute this listing</a>
      </div>
    </div>`;
}

async function loadReportDetail(reportId) {
  const unlocks = getUnlocks();
  const paymentId = unlocks[String(reportId)];
  const r = await api(`/reports/public/${reportId}${paymentId ? `?paymentId=${encodeURIComponent(paymentId)}` : ''}`);
  if (r.locked || !r.report || r.report.description == null) {
    return null;
  }
  return r.report;
}

function cardHtml(item) {
  const unlocked = Boolean(getUnlocks()[String(item.id)]);
  const date = new Date(item.reportedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `
    <div class="job-item alert-card" data-id="${item.id}" style="align-items:flex-start; flex-direction:column;">
      <div style="width:100%; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div style="min-width:0;">
          <b style="word-break:break-word;">${escapeHtml(item.subject)}</b>
          <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">
            ${escapeHtml(typeLabel(item.type))} &middot; Reported ${date}
          </div>
        </div>
        <div class="alert-actions" style="flex-shrink:0;">
          ${unlocked
            ? `<button class="btn btn-ghost alert-open-btn" data-id="${item.id}" style="font-size:0.85rem;">View report</button>`
            : `<button class="btn btn-primary alert-unlock-btn" data-id="${item.id}" style="font-size:0.85rem;">Unlock — KES 30</button>`}
        </div>
      </div>
      <div class="alert-detail-slot" style="display:none; width:100%;"></div>
    </div>`;
}

async function fetchPage(append) {
  if (loading) return;
  loading = true;
  const noAlerts = document.getElementById('no-alerts');
  try {
    const params = new URLSearchParams({ page: String(currentPage) });
    if (currentType) params.set('type', currentType);
    if (currentQuery) params.set('q', currentQuery);
    const data = await api(`/reports/public?${params.toString()}`);
    const list = document.getElementById('alerts');
    const html = (data.reports || []).map(cardHtml).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html;
    const shown = list.querySelectorAll('.alert-card').length;
    noAlerts.style.display = shown ? 'none' : 'block';
    document.getElementById('more-wrap').style.display = shown < (data.total || 0) ? 'block' : 'none';
    if (shown >= (data.total || 0)) document.getElementById('more-wrap').style.display = 'none';
    wireCardButtons();
  } catch (err) {
    document.getElementById('alerts').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  } finally {
    loading = false;
  }
}

function wireCardButtons() {
  document.querySelectorAll('.alert-unlock-btn:not([data-wired])').forEach((btn) => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => startUnlock(Number(btn.dataset.id)));
  });
  document.querySelectorAll('.alert-open-btn:not([data-wired])').forEach((btn) => {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => openDetail(Number(btn.dataset.id)));
  });
}

async function openDetail(reportId, card) {
  const target = card || document.querySelector(`.alert-card[data-id="${reportId}"]`);
  if (!target) return;
  const slot = target.querySelector('.alert-detail-slot');
  if (!slot) return;
  if (slot.style.display !== 'none') {
    slot.style.display = 'none';
    return;
  }
  const btn = target.querySelector('.alert-open-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const full = await loadReportDetail(reportId);
    if (!full) {
      const map = getUnlocks();
      delete map[String(reportId)];
      localStorage.setItem(UNLOCK_KEY, JSON.stringify(map));
      slot.innerHTML = `<div class="alert alert-err" style="margin-top:10px;">This report is no longer unlocked on this device. Pay KES 30 to open it again.</div>`;
      slot.style.display = 'block';
      const actions = target.querySelector('.alert-actions');
      if (actions) {
        actions.innerHTML = `<button class="btn btn-primary alert-unlock-btn" data-id="${reportId}" style="font-size:0.85rem;">Unlock — KES 30</button>`;
        wireCardButtons();
      }
      return;
    }
    slot.innerHTML = detailHtml(full);
    slot.style.display = 'block';
    if (btn) { btn.disabled = false; btn.textContent = 'Hide report'; }
  } catch (err) {
    slot.innerHTML = `<div class="alert alert-err" style="margin-top:10px;">${escapeHtml(err.message)}</div>`;
    slot.style.display = 'block';
    if (btn) { btn.disabled = false; btn.textContent = 'View report'; }
  }
}

async function startUnlock(reportId) {
  if (pendingReportId) return;
  pendingReportId = reportId;
  try {
    const phone = await askForPhone();
    if (!phone) { pendingReportId = null; return; }
    const overlay = document.getElementById('paymentPopupOverlay');
    const pp = document.getElementById('paymentProgressCard');
    const ppCircular = document.getElementById('ppCircular');
    const ppStatus = document.getElementById('ppStatusText');
    const ppHint = document.getElementById('ppHint');
    overlay.classList.add('open');
    pp.style.display = '';
    ppCircular.className = 'pp-circular';
    ppStatus.textContent = 'Processing your unlock';
    ppHint.textContent = 'Sending M-Pesa STK push to your phone...';
    const pay = await api('/payments/alert-view', { method: 'POST', body: JSON.stringify({ reportId, phone }) });
    ppStatus.textContent = 'Enter your M-Pesa PIN';
    ppHint.textContent = 'An STK prompt has been sent to your phone. Enter your PIN to confirm payment.';
    await waitForPayment({
      paymentId: pay.paymentId,
      onConfirmed: async () => {
        saveUnlock(reportId, pay.paymentId);
        const card = document.querySelector(`.alert-card[data-id="${reportId}"]`);
        if (card) {
          const actions = card.querySelector('.alert-actions');
          if (actions) actions.innerHTML = `<button class="btn btn-ghost alert-open-btn" data-id="${reportId}" style="font-size:0.85rem;">View report</button>`;
          wireCardButtons();
          const full = await loadReportDetail(reportId);
          if (full) {
            const slot = card.querySelector('.alert-detail-slot');
            slot.innerHTML = detailHtml(full);
            slot.style.display = 'block';
            const openBtn = card.querySelector('.alert-open-btn');
            if (openBtn) openBtn.textContent = 'Hide report';
          }
        }
      },
    });
  } catch (err) {
    const overlay = document.getElementById('paymentPopupOverlay');
    const ppCircular = document.getElementById('ppCircular');
    const ppStatus = document.getElementById('ppStatusText');
    const ppHint = document.getElementById('ppHint');
    ppCircular.className = 'pp-circular failed';
    ppStatus.textContent = 'Something went wrong.';
    ppHint.textContent = escapeHtml(err.message);
    setTimeout(() => overlay.classList.remove('open'), 4000);
  } finally {
    pendingReportId = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', (e) => {
    closeModal(e.target.closest('.modal-overlay').id);
  }));

  fetchPage(false);

  let filterTimer = null;
  document.getElementById('filter').addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      currentQuery = e.target.value.trim();
      currentPage = 1;
      fetchPage(false);
    }, 350);
  });

  document.getElementById('type-filter').addEventListener('change', (e) => {
    currentType = e.target.value;
    currentPage = 1;
    fetchPage(false);
  });

  document.getElementById('moreBtn').addEventListener('click', () => {
    currentPage += 1;
    fetchPage(true);
  });
});
