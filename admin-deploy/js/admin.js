


const API_BASE = 'https://semacheck.onrender.com/api';

function getAdminToken() { return sessionStorage.getItem('semacheck_admin_token'); }
function setAdminToken(t) { sessionStorage.setItem('semacheck_admin_token', t); }
function clearAdminToken() { sessionStorage.removeItem('semacheck_admin_token'); }

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    if (!getAdminToken()) window.location.replace('login.html');
  }
});

async function adminApi(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pill(status) {
  return `<span class="pill pill-${status}">${status}</span>`;
}
function showToast(message, isError) {
  const box = document.getElementById('globalAlert');
  box.innerHTML = `<div class="alert ${isError ? 'alert-err' : 'alert-ok'}">${escapeHtml(message)}</div>`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { box.innerHTML = ''; }, 3000);
}

const TICK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const BIN_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
let currentRevDays = 28;

document.addEventListener('DOMContentLoaded', () => {
  // ---- login page ----
  const loginBtn = document.getElementById('adminLoginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
      const alertBox = document.getElementById('loginAlert');
      try {
        const r = await adminApi('/admin/login', {
          method: 'POST',
          body: JSON.stringify({
            email: document.getElementById('adminEmail').value.trim(),
            password: document.getElementById('adminPassword').value,
          }),
        });
        setAdminToken(r.token);
        window.location.href = 'dashboard.html';
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
      }
    });
  }

  // ---- dashboard page ----
  const logoutBtn = document.getElementById('adminLogout');
  if (!logoutBtn) return;
  if (!getAdminToken()) { window.location.replace('login.html'); return; }
  logoutBtn.addEventListener('click', () => { clearAdminToken(); sessionStorage.clear(); window.location.replace('login.html'); });

  initTabs();
  loadMe();
  loadStats();
  loadRevenue();
  loadRegistrations('pending');
  loadUsers();
  loadJobs('pending');
  loadForensicsCases('submitted');
  loadMessages();
  loadKenyaRegistryStatus();
  loadPushStatus();
  initBroadcast();

  // Never assume an element exists: one missing id used to throw here and
  // silently kill every listener registered after it ("nothing works").
  const on = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
    else console.warn(`[admin] #${id} missing — listener skipped`);
  };

  on('regStatusFilter', 'change', (e) => loadRegistrations(e.target.value));
  on('jobStatusFilter', 'change', (e) => loadJobs(e.target.value));
  on('reportStatusFilter', 'change', () => loadReportsQueue());
  on('reportTypeFilter', 'change', () => loadReportsQueue());
  document.querySelectorAll('[data-rev-days]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.rev-period-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRevDays = Number(btn.dataset.revDays);
    loadRevenue(currentRevDays);
  }));
  on('forensicsStatusFilter', 'change', (e) => loadForensicsCases(e.target.value));
  on('userFilterBtn', 'click', loadUsers);
  on('userSearchInput', 'keydown', (e) => { if (e.key === 'Enter') loadUsers(); });

  on('saveSettingsBtn', 'click', saveSettings);

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { closeDocModal(); closeUserDetailModal(); }));
  on('docPreviewOverlay', 'click', (e) => { if (e.target.id === 'docPreviewOverlay') closeDocModal(); });
  document.getElementById('userDetailOverlay')?.addEventListener('click', (e) => { if (e.target.id === 'userDetailOverlay') closeUserDetailModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDocModal(); closeUserDetailModal(); } });

  document.getElementById('mobileMenuToggle')?.addEventListener('click', () => {
    document.getElementById('adminSidebar').classList.toggle('open');
  });
});

// ---------------- tabs ----------------
function initTabs() {
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.gotoTab));
  });
}
function switchTab(tab) {
  closeDocModal();
  closeUserDetailModal();
  document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  document.getElementById('adminSidebar').classList.remove('open');
  loadTab(tab);
}

// ---------------- overview ----------------
async function loadMe() {
  try {
    const r = await adminApi('/admin/settings/me');
    document.getElementById('adminNameLabel').textContent = `Hi, ${r.admin.fullName}`;
    document.getElementById('setFullName').placeholder = r.admin.fullName;
    document.getElementById('setEmail').placeholder = r.admin.email;
  } catch (err) { handleAuthError(err); }
}

async function loadStats() {
  try {
    const s = await adminApi('/admin/stats');
    document.getElementById('statUsers').textContent = s.totalUsers;
    document.getElementById('statSearches').textContent = s.totalSearches;
    document.getElementById('statPending').textContent = s.pendingJobs;
    document.getElementById('statSubs').textContent = s.activeSubscriptions;
    document.getElementById('statContact').textContent = s.contactMessagesNeedingAttention;
    document.getElementById('statIdPending').textContent = s.idVerificationsPending;
    document.getElementById('statForensicsCases').textContent = s.forensicsCasesAwaitingReview;

    const idBadge = document.getElementById('badgeIdPending');
    idBadge.textContent = s.idVerificationsPending;
    idBadge.style.display = s.idVerificationsPending > 0 ? 'inline-block' : 'none';

    const jobBadge = document.getElementById('badgeJobsPending');
    jobBadge.textContent = s.pendingJobs;
    jobBadge.style.display = s.pendingJobs > 0 ? 'inline-block' : 'none';

    const forensicsBadge = document.getElementById('badgeForensicsCases');
    if (forensicsBadge) {
      forensicsBadge.textContent = s.forensicsCasesAwaitingReview;
      forensicsBadge.style.display = s.forensicsCasesAwaitingReview > 0 ? 'inline-block' : 'none';
    }
  } catch (err) { handleAuthError(err); }
}

// ---------------- revenue ----------------
function drawRevenueChart(series, days) {
  const canvas = document.getElementById('revChart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 600;
  const cssHeight = 180;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const padLeft = 52, padRight = 10, padTop = 12, padBottom = 24;
  const w = cssWidth - padLeft - padRight;
  const h = cssHeight - padTop - padBottom;
  const data = [];
  const end = new Date();
  const byDay = {};
  (series || []).forEach((s) => { byDay[s.day] = s; });
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    data.push({ day: key, total: byDay[key] ? Number(byDay[key].total) : 0 });
  }
  if (!data.length) return;
  const max = Math.max(...data.map((d) => d.total), 1);
  ctx.strokeStyle = '#e4e9f2';
  ctx.fillStyle = '#7c8aa5';
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padTop + (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + w, y); ctx.stroke();
    ctx.fillText(Math.round(max - (max / 4) * i).toLocaleString(), 4, y + 3);
  }
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const pts = data.map((d, i) => ({ x: padLeft + (data.length > 1 ? i * step : w / 2), y: padTop + h - (d.total / max) * h }));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, padTop + h);
  pts.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1].x, padTop + h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,163,163,0.12)';
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = '#0FA3A3';
  ctx.lineWidth = 2;
  ctx.stroke();
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  data.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== data.length - 1) return;
    ctx.fillStyle = '#7c8aa5';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(d.day.slice(5), Math.min(pts[i].x, cssWidth - 26), cssHeight - 8);
  });
}

async function loadRevenue(days) {
  if (days) currentRevDays = days;
  try {
    const r = await adminApi(`/admin/revenue?days=${currentRevDays}`);
    document.getElementById('revTotal').textContent = 'KES ' + r.totalRevenue.toLocaleString();
    document.getElementById('revTransactions').textContent = r.totalTransactions.toLocaleString();
    document.getElementById('revLast7').textContent = 'KES ' + r.last7Days.total.toLocaleString();
    document.getElementById('revLast30').textContent = 'KES ' + r.last30Days.total.toLocaleString();
    if (r.period) {
      document.getElementById('revPeriodTotal').textContent = 'KES ' + r.period.total.toLocaleString();
      document.getElementById('revPeriodCount').textContent = r.period.count.toLocaleString();
      document.getElementById('revPeriodLabel').textContent = r.period.label;
      document.getElementById('revChartTitle').textContent = `Revenue per day — ${r.period.label}`;
    }
    drawRevenueChart(r.series || [], currentRevDays);

    const purposeLabels = { search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>Search', subscription: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>Subscription', forensics_case: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>Forensics' };
    const purposeBox = document.getElementById('revByPurpose');
    if (r.byPurpose.length === 0) {
      purposeBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No payments yet.</p>';
    } else {
      purposeBox.innerHTML = r.byPurpose.map((p) => {
        const pct = r.totalRevenue > 0 ? Math.round((p.total / r.totalRevenue) * 100) : 0;
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
          <div>
            <span style="font-size:0.95rem;font-weight:600;">${purposeLabels[p.purpose] || p.purpose}</span>
            <span style="font-size:0.82rem;color:var(--text-muted);margin-left:8px;">${p.count} transaction${p.count !== 1 ? 's' : ''}</span>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700;font-size:0.95rem;">KES ${p.total.toLocaleString()}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);">${pct}%</div>
          </div>
        </div>`;
      }).join('');
    }

    const breakdownBox = document.getElementById('revBreakdown');
    const avgOrder = r.totalTransactions > 0 ? Math.round(r.totalRevenue / r.totalTransactions) : 0;
    const dailyAvg30 = r.last30Days.count > 0 ? Math.round(r.last30Days.total / 30) : 0;
    breakdownBox.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">Average order value</span><b>KES ${avgOrder.toLocaleString()}</b></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">Daily revenue (30-day avg)</span><b>KES ${dailyAvg30.toLocaleString()}</b></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">Transactions (7 days)</span><b>${r.last7Days.count}</b></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">Transactions (30 days)</span><b>${r.last30Days.count}</b></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:var(--text-muted);">Revenue (30 days)</span><b>KES ${r.last30Days.total.toLocaleString()}</b></div>
      </div>
    `;

    const recentBox = document.getElementById('revRecentList');
    const successPayments = r.recentPayments.filter((p) => p.status === 'success');
    const allPayments = r.recentPayments;
    if (allPayments.length === 0) {
      recentBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No payments yet.</p>';
    } else {
      recentBox.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>User</th><th>Purpose</th><th>Amount</th><th>Status</th><th>M-Pesa receipt</th><th>Date</th></tr></thead><tbody>${
        allPayments.map((p) => `<tr>
          <td data-label="User">${escapeHtml(p.full_name || 'Unknown')}<div style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(p.email || '')}</div></td>
          <td data-label="Purpose">${purposeLabels[p.purpose] || p.purpose}</td>
          <td data-label="Amount" style="font-weight:700;">KES ${Number(p.amount).toLocaleString()}</td>
          <td data-label="Status">${pill(p.status)}</td>
          <td data-label="M-Pesa receipt" style="font-family:monospace;font-size:0.82rem;">${escapeHtml(p.mpesa_receipt || '—')}</td>
          <td data-label="Date">${new Date(p.created_at).toLocaleString()}</td>
        </tr>`).join('')
      }</tbody></table></div>`;
    }
  } catch (err) { handleAuthError(err); }
}

// ---------------- registrations (ID verification) ----------------
async function loadRegistrations(status) {
  const box = document.getElementById('registrationsList');
  box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Loading…</p>';
  try {
    const r = await adminApi(`/admin/id-verifications?status=${status}`);
    if (!r.users.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Nothing here.</p>'; return; }
    box.innerHTML = r.users.map((u) => `
      <div class="job-item" style="flex-direction:column;align-items:stretch;gap:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
          <div>
            <b>${escapeHtml(u.full_name)}</b> <span class="pill pill-job_owner">Job owner</span>
            <div style="font-size:0.82rem;color:var(--text-muted);">ID number entered: <b>${escapeHtml(u.national_id)}</b> &middot; ${escapeHtml(u.email)} &middot; ${escapeHtml(u.phone)}</div>
            <div style="font-size:0.82rem;color:var(--text-muted);">Business: <b>${escapeHtml(u.business_name || '—')}</b> &middot; Reg#: ${escapeHtml(u.business_reg_number || '—')} &middot; KRA: ${escapeHtml(u.kra_pin || '—')}</div>
            ${u.id_verification_notes ? `<div style="font-size:0.8rem;color:var(--scam-red);margin-top:4px;">Rejection reason: ${escapeHtml(u.id_verification_notes)}</div>` : ''}
          </div>
          <button class="btn btn-ghost" data-view-doc="${u.id}">View document</button>
        </div>
        ${status === 'pending' ? `
        <div class="action-btns">
          <button class="icon-btn" data-approve-id="${u.id}" title="Approve registration" aria-label="Approve registration">${TICK_ICON}</button>
          <button class="btn btn-ghost" data-reject-id="${u.id}">Reject</button>
        </div>
        <div class="reject-reason-box" id="reject-box-${u.id}" style="display:none;">
          <input type="text" id="reject-reason-${u.id}" placeholder="Reason for rejection (shown to no one but recorded internally)">
          <button class="btn btn-amber" data-confirm-reject="${u.id}">Confirm rejection</button>
        </div>` : `<div>${pill(u.id_verification_status)}</div>`}
      </div>
    `).join('');

    box.querySelectorAll('[data-view-doc]').forEach((btn) => btn.addEventListener('click', () => viewDocument(btn.dataset.viewDoc)));
    box.querySelectorAll('[data-approve-id]').forEach((btn) => btn.addEventListener('click', async () => {
      await adminApi(`/admin/id-verifications/${btn.dataset.approveId}/approve`, { method: 'POST' });
      showToast('Registration approved.');
      loadRegistrations(status); loadStats(); loadUsers();
    }));
    box.querySelectorAll('[data-reject-id]').forEach((btn) => btn.addEventListener('click', () => {
      document.getElementById(`reject-box-${btn.dataset.rejectId}`).style.display = 'flex';
    }));
    box.querySelectorAll('[data-confirm-reject]').forEach((btn) => btn.addEventListener('click', async () => {
      const userId = btn.dataset.confirmReject;
      const reason = document.getElementById(`reject-reason-${userId}`).value.trim();
      if (!reason) { document.getElementById(`reject-reason-${userId}`).focus(); return; }
      await adminApi(`/admin/id-verifications/${userId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      showToast('Registration rejected.');
      loadRegistrations(status); loadStats(); loadUsers();
    }));
  } catch (err) { handleAuthError(err); }
}

async function viewDocument(userId) {
  const overlay = document.getElementById('docPreviewOverlay');
  const body = document.getElementById('docPreviewBody');
  const title = overlay.querySelector('h2');
  if (title) title.textContent = 'Uploaded ID document';
  body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
  overlay.classList.add('open');
  try {
    const res = await fetch(`${API_BASE}/admin/id-verifications/${userId}/document`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    });
    if (!res.ok) throw new Error('Could not load document.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    body.innerHTML = blob.type === 'application/pdf'
      ? `<a href="${url}" target="_blank" class="btn btn-outline" style="color:var(--navy);border-color:var(--navy);">Open PDF in new tab</a>`
      : `<img src="${url}" style="max-width:100%;border-radius:8px;border:1px solid var(--border);">`;
  } catch (err) {
    body.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}
function closeDocModal() { document.getElementById('docPreviewOverlay').classList.remove('open'); }

// ---------------- user detail (row click in "All accounts") ----------------
async function viewUserDetail(userId) {
  const overlay = document.getElementById('userDetailOverlay');
  const body = document.getElementById('userDetailBody');
  body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
  overlay.classList.add('open');
  try {
    const r = await adminApi(`/admin/users/${userId}`);
    const u = r.user;
    body.innerHTML = `
      <h3 style="margin-bottom:2px;">${escapeHtml(u.full_name)}</h3>
      <div style="margin-bottom:16px;">${pill(u.id_verification_status)} <span class="pill pill-${u.account_type}">${u.account_type === 'job_owner' ? 'Job owner' : 'Regular user'}</span></div>
      <table class="data-table" style="margin-bottom:0;">
        <tr><td style="color:var(--text-muted);width:150px;">Email</td><td>${escapeHtml(u.email)}</td></tr>
        <tr><td style="color:var(--text-muted);">Phone</td><td>${escapeHtml(u.phone)}</td></tr>
        <tr><td style="color:var(--text-muted);">National ID</td><td>${escapeHtml(u.national_id)}</td></tr>
        ${u.business_name ? `<tr><td style="color:var(--text-muted);">Business</td><td>${escapeHtml(u.business_name)}</td></tr>` : ''}
        ${u.business_reg_number ? `<tr><td style="color:var(--text-muted);">Business reg. no.</td><td>${escapeHtml(u.business_reg_number)}</td></tr>` : ''}
        ${u.kra_pin ? `<tr><td style="color:var(--text-muted);">KRA PIN</td><td>${escapeHtml(u.kra_pin)}</td></tr>` : ''}
        ${u.id_verification_notes ? `<tr><td style="color:var(--text-muted);">Review note</td><td>${escapeHtml(u.id_verification_notes)}</td></tr>` : ''}
        <tr><td style="color:var(--text-muted);">Subscription</td><td>${r.subscription ? `${pill(r.subscription.status)} ${r.subscription.expires_at ? 'until ' + new Date(r.subscription.expires_at).toLocaleDateString() : ''}` : 'None'}</td></tr>
        <tr><td style="color:var(--text-muted);">Searches made</td><td>${r.searchCount}</td></tr>
        <tr><td style="color:var(--text-muted);">Jobs posted</td><td>${r.jobCount}</td></tr>
        <tr><td style="color:var(--text-muted);">Joined</td><td>${new Date(u.created_at).toLocaleString()}</td></tr>
      </table>
      <div class="action-btns" style="margin-top:16px;">
        <button class="btn btn-ghost" data-view-doc-inline="${u.id}">View ID document</button>
      </div>
    `;
    body.querySelector('[data-view-doc-inline]')?.addEventListener('click', () => {
      closeUserDetailModal();
      viewDocument(u.id);
    });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}
function closeUserDetailModal() { document.getElementById('userDetailOverlay')?.classList.remove('open'); }

// ---------------- all accounts ----------------
async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted);">Loading…</td></tr>';
  try {
    const params = new URLSearchParams();
    const q = document.getElementById('userSearchInput')?.value?.trim();
    const type = document.getElementById('userTypeFilter')?.value;
    const status = document.getElementById('userStatusFilter')?.value;
    if (q) params.set('q', q);
    if (type) params.set('accountType', type);
    if (status) params.set('verificationStatus', status);

    const r = await adminApi(`/admin/users?${params.toString()}`);
    if (!r.users.length) { tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted);">No accounts match.</td></tr>'; return; }

    tbody.innerHTML = r.users.map((u) => `
      <tr data-user-row="${u.id}" style="cursor:pointer;"${u.disabled_at ? ' class="user-disabled-row"' : ''}>
        <td data-label="Name"><b>${escapeHtml(u.full_name)}</b>${u.business_name ? `<div style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(u.business_name)}</div>` : ''}${u.disabled_at ? '<div><span class="pill pill-rejected">deactivated</span></div>' : ''}</td>
        <td data-label="Type"><span class="pill pill-${u.account_type}">${u.account_type === 'job_owner' ? 'Job owner' : 'Regular'}</span></td>
        <td data-label="Email">${escapeHtml(u.email)}</td>
        <td data-label="Phone">${escapeHtml(u.phone)}</td>
        <td data-label="ID number">${escapeHtml(u.national_id)}</td>
        <td data-label="Verification">${pill(u.id_verification_status)}</td>
        <td data-label="Joined">${new Date(u.created_at).toLocaleDateString()}</td>
        <td data-label="Actions">${u.disabled_at
          ? `<button class="icon-btn" data-restore-user="${u.id}" title="Reactivate account" aria-label="Reactivate account">${RESTORE_ICON}</button>`
          : `<button class="icon-btn icon-btn-danger" data-delete-user="${u.id}" title="Deactivate account" aria-label="Deactivate account">${BIN_ICON}</button>`}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('[data-user-row]').forEach((row) => {
      row.addEventListener('click', () => viewUserDetail(row.dataset.userRow));
    });
    tbody.querySelectorAll('[data-delete-user]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Deactivate this account? Their records, payments and reports are kept for audit.')) return;
      try {
        const res = await adminApi(`/admin/users/${btn.dataset.deleteUser}/delete`, { method: 'POST' });
        showToast(res.message || 'Account deactivated.');
        loadUsers();
        loadStats();
      } catch (err) { showToast(err.message, true); }
    }));
    tbody.querySelectorAll('[data-restore-user]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await adminApi(`/admin/users/${btn.dataset.restoreUser}/restore`, { method: 'POST' });
        showToast(res.message || 'Account reactivated.');
        loadUsers();
      } catch (err) { showToast(err.message, true); }
    }));
  } catch (err) { handleAuthError(err); }
}

// ---------------- jobs ----------------
async function loadJobs(status) {
  const box = document.getElementById('jobsList');
  box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Loading…</p>';
  try {
    const r = await adminApi(`/admin/jobs?status=${status}`);
    if (!r.jobs.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Nothing here.</p>'; return; }
    box.innerHTML = r.jobs.map((j) => `
      <div class="job-item" style="flex-direction:column;align-items:stretch;gap:10px;">
        <div>
          <b>${escapeHtml(j.title)}</b> — ${escapeHtml(j.company_name)} ${pill(j.status)}
          <div style="font-size:0.82rem;color:var(--text-muted);">Owner: <b>${escapeHtml(j.owner_name || '—')}</b> · ${escapeHtml(j.owner_email)}</div>
          <div style="font-size:0.82rem;color:var(--text-muted);">${escapeHtml(j.location || '')} &middot; Reg#: ${escapeHtml(j.business_reg_number || 'n/a')} &middot; KRA: ${escapeHtml(j.kra_pin || 'n/a')}</div>
          <p style="font-size:0.85rem;margin-top:6px;">${escapeHtml(j.description)}</p>
          ${j.rejection_reason ? `<div style="font-size:0.8rem;color:var(--scam-red);margin-top:4px;">Reason: ${escapeHtml(j.rejection_reason)}</div>` : ''}
        </div>
        ${status === 'pending' ? `
        <div class="action-btns">
          <button class="icon-btn" data-approve="${j.id}" title="Approve job" aria-label="Approve job">${TICK_ICON}</button>
          <button class="btn btn-ghost" data-reject="${j.id}">Reject</button>
        </div>` : ''}
      </div>
    `).join('');
    box.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
      await adminApi(`/admin/jobs/${btn.dataset.approve}/approve`, { method: 'POST' });
      showToast('Job approved.');
      loadJobs(status); loadStats();
    }));
    box.querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', async () => {
      const reason = prompt('Reason for rejection (optional):', '');
      if (reason === null) return;
      await adminApi(`/admin/jobs/${btn.dataset.reject}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      showToast('Job rejected.');
      loadJobs(status); loadStats();
    }));
  } catch (err) { handleAuthError(err); }
}

// ---------------- forensics cases ----------------
async function loadForensicsCases(status) {
  const box = document.getElementById('forensicsCasesList');
  box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Loading…</p>';
  try {
    const r = await adminApi(`/admin/forensics-cases?status=${status}`);
    if (!r.cases.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Nothing here.</p>'; return; }
    const nextStatusOptions = ['under_review', 'in_progress', 'resolved', 'closed'];
    box.innerHTML = r.cases.map((c) => `
      <div class="job-item" style="flex-direction:column;align-items:stretch;gap:10px;">
        <div>
          <b>KES ${Number(c.amount_lost).toLocaleString()} lost</b> ${pill(c.status)}
          <div style="font-size:0.82rem;color:var(--text-muted);">${escapeHtml(c.full_name)} &middot; ${escapeHtml(c.email)} &middot; ${escapeHtml(c.contact_phone || '')}</div>
          <p style="font-size:0.85rem;margin-top:6px;">${escapeHtml(c.scam_description)}</p>
          ${c.evidence_notes ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">Evidence: ${escapeHtml(c.evidence_notes)}</div>` : ''}
          ${c.admin_notes ? `<div style="font-size:0.8rem;color:var(--navy);margin-top:4px;">Admin note: ${escapeHtml(c.admin_notes)}</div>` : ''}
        </div>
        <div class="action-btns">
          ${nextStatusOptions.map((s) => `<button class="btn btn-ghost" data-set-case-status="${c.id}" data-status="${s}">${s.replace('_', ' ')}</button>`).join('')}
        </div>
      </div>
    `).join('');

    box.querySelectorAll('[data-set-case-status]').forEach((btn) => btn.addEventListener('click', async () => {
      const note = prompt('Add a note for this status change (optional):', '');
      if (note === null) return;
      await adminApi(`/admin/forensics-cases/${btn.dataset.setCaseStatus}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.status, note }) });
      showToast('Case status updated.');
      loadForensicsCases(status); loadStats();
    }));
  } catch (err) { handleAuthError(err); }
}

// ---------------- contact messages ----------------
async function loadMessages() {
  const box = document.getElementById('messagesList');
  try {
    const r = await adminApi('/admin/contact-messages');
    if (!r.messages.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No messages yet.</p>'; return; }
    box.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>From</th><th>Message</th><th>Emailed?</th><th>Received</th></tr></thead><tbody>${
      r.messages.map((m) => `
        <tr>
          <td data-label="From">${escapeHtml(m.email)}</td>
          <td data-label="Message" style="max-width:360px;">${escapeHtml(m.message)}</td>
          <td data-label="Emailed?">${m.emailed_ok ? pill('approved') : pill('pending')}</td>
          <td data-label="Received">${new Date(m.created_at).toLocaleString()}</td>
        </tr>`).join('')
    }</tbody></table></div>`;
  } catch (err) { handleAuthError(err); }
}

// ---------------- Kenya registry (CBK licensed lenders) ----------------
async function loadKenyaRegistryStatus() {
  try {
    const r = await adminApi('/admin/kenya-registry/status');
    document.getElementById('registryEntryCount').textContent = r.entryCount;
    document.getElementById('registryLastFetched').textContent = r.lastFetched ? new Date(r.lastFetched).toLocaleString() : 'Never';
    document.getElementById('registrySourceUrl').textContent = r.sourceUrl || r.configuredUrl || 'Not set';
  } catch (err) { handleAuthError(err); }
}

document.getElementById('refreshRegistryBtn')?.addEventListener('click', async () => {
  const alertBox = document.getElementById('kenyaRegistryAlert');
  const btn = document.getElementById('refreshRegistryBtn');
  alertBox.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Refreshing… this fetches and parses a real PDF, may take a few seconds';
  try {
    const r = await adminApi('/admin/kenya-registry/refresh', { method: 'POST' });
    alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
    await loadKenyaRegistryStatus();
  } catch (err) {
    alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
});

// ---------------- settings ----------------
async function saveSettings() {
  const alertBox = document.getElementById('settingsAlert');
  alertBox.innerHTML = '';
  const currentPassword = document.getElementById('setCurrentPassword').value;
  if (!currentPassword) {
    alertBox.innerHTML = '<div class="alert alert-err">Enter your current password to confirm any change.</div>';
    return;
  }
  const body = { currentPassword };
  const newFullName = document.getElementById('setFullName').value.trim();
  const newEmail = document.getElementById('setEmail').value.trim();
  const newPassword = document.getElementById('setNewPassword').value;
  if (newFullName) body.newFullName = newFullName;
  if (newEmail) body.newEmail = newEmail;
  if (newPassword) body.newPassword = newPassword;

  try {
    const r = await adminApi('/admin/settings/credentials', { method: 'POST', body: JSON.stringify(body) });
    alertBox.innerHTML = `<div class="alert alert-ok">${r.message}</div>`;
    document.getElementById('setCurrentPassword').value = '';
    document.getElementById('setNewPassword').value = '';
    document.getElementById('setFullName').value = '';
    document.getElementById('setEmail').value = '';
    loadMe();
  } catch (err) {
    alertBox.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}

// ---------------- push broadcast ----------------
async function loadPushStatus() {
  const box = document.getElementById('pushStatusBox');
  if (!box) return;
  try {
    const s = await adminApi('/admin/push/status');
    box.innerHTML = `
      <ul style="margin:6px 0 0 18px;color:var(--text);font-size:0.9rem;line-height:1.8;">
        <li>Push service: ${s.pushConfigured ? '✅ configured' : '⚠️ <strong>not configured</strong> — broadcasts will fail until VAPID keys are set in the server environment'}</li>
        <li>User devices reachable: <strong>${s.userDevices}</strong> (across ${s.usersReached} user${s.usersReached === 1 ? '' : 's'})</li>
        <li>Admin devices subscribed: <strong>${s.adminDevices}</strong></li>
      </ul>`;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}

function initBroadcast() {
  const sendBtn = document.getElementById('broadcastSendBtn');
  if (!sendBtn) return;
  sendBtn.addEventListener('click', async () => {
    const alertBox = document.getElementById('broadcastAlert');
    const title = document.getElementById('broadcastTitle').value.trim();
    const body = document.getElementById('broadcastBody').value.trim();
    const url = document.getElementById('broadcastUrl').value.trim();
    alertBox.innerHTML = '';
    if (!title || !body) {
      alertBox.innerHTML = '<div class="alert alert-err">Both a title and a message are required.</div>';
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      const r = await adminApi('/admin/push/broadcast', { method: 'POST', body: JSON.stringify({ title, body, url: url || undefined }) });
      alertBox.innerHTML = `<div class="alert alert-ok">${escapeHtml(r.message)}</div>`;
      document.getElementById('broadcastTitle').value = '';
      document.getElementById('broadcastBody').value = '';
      document.getElementById('broadcastUrl').value = '';
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send broadcast';
      loadPushStatus();
    }
  });
}

// ---------------- shared ----------------
function handleAuthError(err) {
  if (err.message.includes('token') || err.message.includes('authenticated')) window.location.href = 'login.html';
  else document.getElementById('globalAlert').innerHTML = `<div class="alert alert-err">${err.message}</div>`;
}

// ---------------- Trust API admin tabs ----------------

async function loadApiAccounts() {
  try {
    const data = await adminApi('/admin/api-accounts');
    const rows = data.accounts || [];
    const el = document.getElementById('apiAccounts');
    const pending = rows.filter((a) => a.status === 'pending').length;
    const pendingOrg = rows.filter((a) => a.verificationStatus === 'documents_submitted').length;
    const badge = document.getElementById('badgeApiAccounts');
    if (badge) {
      const n = pending + pendingOrg;
      badge.textContent = String(n);
      badge.style.display = n ? 'inline-block' : 'none';
    }
    if (!rows.length) {
      el.innerHTML = '<p class="hint">No developer (API) accounts yet.</p>';
      return;
    }
    const statusLabel = { pending: 'Awaiting approval', active: 'Active', past_due: 'Past due', suspended: 'Suspended', closed: 'Closed' };
    const pillClass = { pending: 'pill-pending', active: 'pill-approved', past_due: 'pill-pending', suspended: 'pill-rejected', closed: 'pill-regular' };
    const verifLabel = { unverified: 'Org: not submitted', documents_submitted: 'Org: documents under review', verified: 'Org: verified', rejected: 'Org: rejected' };
    const verifClass = { unverified: 'pill-regular', documents_submitted: 'pill-pending', verified: 'pill-approved', rejected: 'pill-rejected' };
    el.innerHTML = rows.map((a) => {
      const vs = a.verificationStatus || 'unverified';
      return `<div class="card" style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong>${escapeHtml(a.companyName)}</strong>
          <span style="display:flex; gap:6px; flex-wrap:wrap;">
            <span class="pill ${pillClass[a.status] || 'pill-regular'}">${statusLabel[a.status] || escapeHtml(a.status)}</span>
            <span class="pill ${verifClass[vs] || 'pill-regular'}">${verifLabel[vs] || escapeHtml(vs)}</span>
          </span>
        </div>
        <div class="hint">Plan: ${escapeHtml(a.planCode)} · KES ${Number(a.planPriceKes || 0).toLocaleString()}/mo · Checks this month: ${a.usageThisMonth || 0}/${a.monthlyQuota ?? '—'} · Active keys: ${a.activeKeys || 0} · Last activity: ${a.lastActivity ? new Date(a.lastActivity).toLocaleString() : '—'}</div>
        <div class="hint">Developer account: <b>${escapeHtml(a.ownerName || '—')}</b> · ${escapeHtml(a.ownerEmail || '')}${a.ownerPhone ? ' · ' + escapeHtml(a.ownerPhone) : ''}</div>
        ${a.orgRegistrationNo ? `<div class="hint">Reg. number: <b>${escapeHtml(a.orgRegistrationNo)}</b>${a.verifiedAt ? ' · verified ' + new Date(a.verifiedAt).toLocaleDateString() : ''}</div>` : ''}
        ${a.website ? `<div class="hint">${escapeHtml(a.website)}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          ${a.hasBusinessDoc ? `<button class="btn btn-ghost" data-view-bizdoc="${a.id}">View registration doc</button>` : ''}
          ${vs === 'documents_submitted' || vs === 'rejected' ? `<button class="icon-btn" data-org-action="approve" data-id="${a.id}" title="Verify organisation" aria-label="Verify organisation">${TICK_ICON}</button><button class="btn btn-ghost" data-org-action="reject" data-id="${a.id}">Reject org</button>` : ''}
          ${a.status === 'pending' && vs !== 'documents_submitted' ? `<button class="icon-btn" data-api-action="approve" data-id="${a.id}" title="Approve API account" aria-label="Approve API account">${TICK_ICON}</button><button class="btn btn-ghost" data-api-action="reject" data-id="${a.id}">Reject</button>` : ''}
          ${a.status === 'active' || a.status === 'past_due' ? `<button class="btn btn-ghost" data-api-action="suspend" data-id="${a.id}">Suspend</button>` : ''}
          ${a.status === 'suspended' || a.status === 'past_due' ? `<button class="btn btn-ghost" data-api-action="reactivate" data-id="${a.id}">Reactivate</button>` : ''}
          ${a.status !== 'closed' ? `<button class="btn btn-ghost" data-api-action="close" data-id="${a.id}">Close</button>` : ''}
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-api-action]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await adminApi(`/admin/api-accounts/${b.dataset.id}/${b.dataset.apiAction}`, { method: 'POST' });
        showToast(r.message || 'Done.');
        await loadApiAccounts();
      } catch (err) {
        el.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
      }
    }));
    // Organisation verification: one-step review — approving the business
    // registration document also activates a pending developer account.
    el.querySelectorAll('[data-org-action]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await adminApi(`/admin/api-accounts/${b.dataset.id}/verify-org`, {
          method: 'POST',
          body: JSON.stringify({ action: b.dataset.orgAction }),
        });
        showToast(r.message || 'Done.');
        await loadApiAccounts();
      } catch (err) {
        el.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
      }
    }));
    el.querySelectorAll('[data-view-bizdoc]').forEach((b) => b.addEventListener('click', () => viewBusinessDoc(b.dataset.viewBizdoc)));
  } catch (err) { document.getElementById('apiAccounts').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`; }
}

// Business registration document for an API (developer) account — same
// preview modal as the ID-verification documents.
async function viewBusinessDoc(accountId) {
  const overlay = document.getElementById('docPreviewOverlay');
  const body = document.getElementById('docPreviewBody');
  const title = overlay.querySelector('h2');
  if (title) title.textContent = 'Business registration document';
  body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
  overlay.classList.add('open');
  try {
    const res = await fetch(`${API_BASE}/admin/api-accounts/${accountId}/business-doc`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    });
    if (!res.ok) throw new Error('Could not load document.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    body.innerHTML = blob.type === 'application/pdf'
      ? `<a href="${url}" target="_blank" class="btn btn-outline" style="color:var(--navy);border-color:var(--navy);">Open PDF in new tab</a>`
      : `<img src="${url}" style="max-width:100%;border-radius:8px;border:1px solid var(--border);">`;
  } catch (err) {
    body.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}

async function loadWebhookFailures() {
  try {
    const data = await adminApi('/admin/webhook-failures');
    const rows = data.deliveries || [];
    const el = document.getElementById('webhookFailures');
    if (!rows.length) {
      el.innerHTML = '<p class="hint">No failed deliveries.</p>';
      return;
    }
    el.innerHTML = rows.map((w) => `<div class="card" style="padding:10px;">
      <strong>${escapeHtml(w.company_name || 'Account ' + w.account_id)}</strong> · ${escapeHtml(w.event || '')} · last code: ${w.last_response_code || '—'} · attempts: ${w.attempts || 0}
      <div style="margin-top:6px;display:flex;gap:8px;">
        <button class="btn btn-ghost" data-retry="${w.id}">Retry</button>
      </div>
    </div>`).join('');
    el.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      await adminApi('/admin/webhook-failures/' + b.dataset.retry + '/retry', { method: 'POST' });
      loadWebhookFailures();
    }));
  } catch (err) { document.getElementById('webhookFailures').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`; }
}

async function loadReportsQueue() {
  try {
    const status = document.getElementById('reportStatusFilter')?.value || 'pending';
    const type = document.getElementById('reportTypeFilter')?.value || '';
    const params = new URLSearchParams({ status });
    if (type) params.set('type', type);
    const data = await adminApi(`/admin/reports?${params.toString()}`);
    const rows = data.reports || [];
    const el = document.getElementById('reportsList');
    const badge = document.getElementById('badgeReportsPending');
    if (badge) { badge.textContent = String(rows.length); badge.style.display = rows.length ? 'inline-block' : 'none'; }
    if (!rows.length) {
      el.innerHTML = '<p class="hint">No reports pending.</p>';
      return;
    }
    const queueDescriptions = {};
    rows.forEach((r) => { queueDescriptions[r.id] = r.description || ''; });
    el.innerHTML = rows.map((r) => `<div class="card" style="padding:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>${escapeHtml(r.type)}${r.subjectName ? ' — ' + escapeHtml(r.subjectName) : ''}</strong>
        <span class="pill pill-pending">pending review</span>
      </div>
      <div class="hint"><b>Subject:</b> ${escapeHtml(r.subject)}${r.amountLostKes ? ` · <b>Lost:</b> KES ${Number(r.amountLostKes).toLocaleString()}` : ''} · ${r.reporterEmail ? escapeHtml(r.reporterEmail) + ' · ' : ''}${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</div>
      <div class="hint" style="margin-top:4px;">${escapeHtml(r.description || '')}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${r.status === 'pending' ? `<button class="icon-btn" data-rp="approve" data-id="${r.id}" title="Approve and publish" aria-label="Approve and publish">${TICK_ICON}</button>
        <button class="btn btn-ghost" data-rp="reject" data-id="${r.id}">Reject</button>
        <button class="btn btn-ghost" data-rp="duplicate" data-id="${r.id}">Mark duplicate</button>` : ''}
        <button class="btn btn-ghost" data-rp-edit="${r.id}">Edit text</button>
        ${r.evidence ? `<button class="btn btn-ghost" data-evidence="${r.id}">View evidence</button>` : '<span class="hint">No evidence attached</span>'}
      </div>
    </div>`).join('');
    el.querySelectorAll('[data-rp-edit]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.rpEdit;
      const next = prompt('Edit the description — remove victim names, phone numbers and other personal data before approval:', queueDescriptions[id] || '');
      if (next === null) return;
      if (next.trim().length < 40) { showToast('Edited description must be at least 40 characters.', true); return; }
      try {
        await adminApi(`/admin/reports/${id}/edit`, { method: 'POST', body: JSON.stringify({ description: next.trim() }) });
        showToast('Report text updated.');
        await loadReportsQueue();
      } catch (err) { showToast(err.message, true); }
    }));
    el.querySelectorAll('[data-rp]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const opts = { method: 'POST' };
        if (b.dataset.rp === 'reject') opts.body = JSON.stringify({ reason: 'Rejected during review' });
        await adminApi(`/admin/reports/${b.dataset.id}/${b.dataset.rp}`, opts);
        showToast(b.dataset.rp === 'approve'
          ? 'Report approved — it is now live on the homepage Scam reports tab.'
          : b.dataset.rp === 'duplicate'
            ? 'Report marked as duplicate.'
            : 'Report rejected.');
        await loadReportsQueue();
      } catch (err) {
        document.getElementById('reportsList').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
      }
    }));
    el.querySelectorAll('[data-evidence]').forEach((b) => b.addEventListener('click', () => viewReportEvidence(b.dataset.evidence)));
  } catch (err) { document.getElementById('reportsList').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`; }
}

// Open the evidence file the reporter attached (image/PDF) in the preview modal.
async function viewReportEvidence(reportId) {
  const overlay = document.getElementById('docPreviewOverlay');
  const body = document.getElementById('docPreviewBody');
  const title = overlay.querySelector('h2');
  if (title) title.textContent = 'Report evidence';
  body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
  overlay.classList.add('open');
  try {
    const res = await fetch(`${API_BASE}/admin/reports/${reportId}/evidence`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    });
    if (!res.ok) throw new Error('Could not load evidence.');
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      // Reporter supplied an evidence link instead of a file. Show it as an
      // explicit link the admin chooses to open — never auto-follow it.
      const data = await res.json();
      if (!data.url || !/^https?:\/\//i.test(data.url)) throw new Error('No usable evidence link.');
      body.innerHTML = `<p class="hint" style="margin-bottom:8px;">This report was submitted with an evidence link:</p><a href="${escapeHtml(data.url)}" target="_blank" rel="noopener noreferrer nofollow" class="btn btn-outline" style="color:var(--navy);border-color:var(--navy);word-break:break-all;">Open evidence link</a>`;
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    body.innerHTML = blob.type === 'application/pdf'
      ? `<a href="${url}" target="_blank" class="btn btn-outline" style="color:var(--navy);border-color:var(--navy);">Open PDF in new tab</a>`
      : `<img src="${url}" style="max-width:100%;border-radius:8px;border:1px solid var(--border);">`;
  } catch (err) {
    body.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}

async function loadDisputes() {
  try {
    const data = await adminApi('/admin/disputes');
    const rows = data.disputes || [];
    const el = document.getElementById('disputesList');
    if (!rows.length) {
      el.innerHTML = '<p class="hint">No open disputes.</p>';
      return;
    }
    el.innerHTML = rows.map((d) => `<div class="card" style="padding:12px;">
      <strong>${escapeHtml(d.submitter_name || '')}</strong> · ${escapeHtml(d.relationship || '')}
      <div class="hint">${escapeHtml(d.message || '')} · status: ${escapeHtml(d.status || '')}</div>
      <div style="margin-top:6px;display:flex;gap:8px;">
        <button class="btn btn-ghost" data-dsp="uphold" data-id="${d.id}">Uphold</button>
        <button class="btn btn-ghost" data-dsp="dismiss" data-id="${d.id}">Dismiss</button>
      </div>
    </div>`).join('');
    el.querySelectorAll('[data-dsp]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const opts = { method: 'POST' };
        if (b.dataset.dsp === 'dismiss') opts.body = JSON.stringify({ note: 'Dismissed' });
        const r = await adminApi(`/admin/disputes/${b.dataset.id}/${b.dataset.dsp}`, opts);
        showToast(r.message || 'Done.');
        await loadDisputes();
      } catch (err) { document.getElementById('disputesList').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`; }
    }));
  } catch (err) { document.getElementById('disputesList').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`; }
}

function drawUsageChart(series) {
  const canvas = document.getElementById('usageChart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 600;
  const cssHeight = 170;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const padLeft = 40, padRight = 10, padTop = 12, padBottom = 24;
  const w = cssWidth - padLeft - padRight;
  const h = cssHeight - padTop - padBottom;
  const data = [];
  const end = new Date();
  const byDay = {};
  (series || []).forEach((s) => { byDay[s.day] = s.n; });
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    data.push({ day: key, n: Number(byDay[key] || 0) });
  }
  const max = Math.max(...data.map((d) => d.n), 1);
  ctx.strokeStyle = '#e4e9f2';
  ctx.fillStyle = '#7c8aa5';
  ctx.font = '10px system-ui, sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padTop + (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + w, y); ctx.stroke();
    ctx.fillText(String(Math.round(max - (max / 4) * i)), 4, y + 3);
  }
  const step = w / data.length;
  data.forEach((d, i) => {
    const barH = (d.n / max) * h;
    const x = padLeft + i * step + 1;
    ctx.fillStyle = '#0FA3A3';
    ctx.fillRect(x, padTop + h - barH, Math.max(step - 2, 1), barH);
    if (i % 6 === 0) {
      ctx.fillStyle = '#7c8aa5';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(d.day.slice(5), x, cssHeight - 8);
    }
  });
}

async function loadApiUsage() {
  try {
    const data = await adminApi('/admin/api-usage');
    const el = document.getElementById('apiUsage');
    const totals = data.platformTotals || {};
    el.innerHTML = `<div class="card" style="padding:14px;">
      <div class="hint">Checks served (7 days)</div>
      <div style="font-size:1.6rem;font-weight:800;">${totals.checksServed || 0}</div>
    </div>
    <div class="card" style="padding:14px;">
      <div class="hint">Active API accounts</div>
      <div style="font-size:1.6rem;font-weight:800;">${totals.activeAccounts || 0}</div>
    </div>
    <div class="card" style="padding:14px;">
      <div class="hint">Verified verdicts</div>
      <div style="font-size:1.6rem;font-weight:800;">${totals.verdictMix || 0}</div>
      <div class="hint">${(totals.verdictBreakdown || []).map((v) => `${escapeHtml(v.verdict)}: ${v.count}`).join(' · ') || 'No verdicts yet'}</div>
    </div>
    <div class="card" style="padding:14px;">
      <div class="hint">Error rate (30 days)</div>
      <div style="font-size:1.6rem;font-weight:800;">${data.errorRate ?? 0}%</div>
      <div class="hint">${(data.requests30d || 0).toLocaleString()} requests</div>
    </div>
    <div class="card" style="padding:14px;">
      <div class="hint">Median latency (p50)</div>
      <div style="font-size:1.6rem;font-weight:800;">${data.latencyP50 || 0} ms</div>
    </div>
    <div class="card" style="padding:14px;">
      <div class="hint">P95 latency</div>
      <div style="font-size:1.6rem;font-weight:800;">${data.latencyP95 || 0} ms</div>
    </div>`;
    drawUsageChart(data.dailySeries || []);
    const topBox = document.getElementById('topAccountsList');
    const top = data.topAccounts || [];
    if (!top.length) {
      topBox.innerHTML = '<p class="hint">No API traffic in the last 30 days.</p>';
    } else {
      const maxN = Math.max(...top.map((t) => t.count), 1);
      topBox.innerHTML = top.map((t) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);">
          <span style="font-weight:600;font-size:0.92rem;">${escapeHtml(t.companyName || 'Unnamed account')}</span>
          <span class="hint">${t.count.toLocaleString()} checks</span>
        </div>
        <div style="height:6px;background:var(--bg);border-radius:4px;overflow:hidden;margin-bottom:6px;">
          <div style="height:100%;width:${Math.round((t.count / maxN) * 100)}%;background:#0FA3A3;"></div>
        </div>`).join('');
    }
  } catch (err) {
    const box = document.getElementById('apiUsage');
    if (box) box.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}

async function loadTab(tab) {
  try {
    if (tab === 'revenue') { await loadRevenue(currentRevDays); }
    else if (tab === 'users') { await loadUsers(); }
    else if (tab === 'jobs') { await loadJobs(document.getElementById('jobStatusFilter')?.value || 'pending'); }
    else if (tab === 'api-accounts') { await loadApiAccounts(); }
    else if (tab === 'webhook-failures') { await loadWebhookFailures(); }
    else if (tab === 'reports') { await loadReportsQueue(); }
    else if (tab === 'disputes') { await loadDisputes(); }
    else if (tab === 'usage') { await loadApiUsage(); }
  } catch (err) {
    document.getElementById('globalAlert').innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
  }
}

