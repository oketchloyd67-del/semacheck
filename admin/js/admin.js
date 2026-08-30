


const API_BASE = 'http://localhost:4800/api';

function getAdminToken() { return sessionStorage.getItem('semacheck_admin_token'); }
function setAdminToken(t) { sessionStorage.setItem('semacheck_admin_token', t); }
function clearAdminToken() { sessionStorage.removeItem('semacheck_admin_token'); }

async function adminApi(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
  if (!getAdminToken()) { window.location.href = 'login.html'; return; }
  logoutBtn.addEventListener('click', () => { clearAdminToken(); window.location.href = 'login.html'; });

  initTabs();
  loadMe();
  loadStats();
  loadRegistrations('pending');
  loadUsers();
  loadJobs('pending');
  loadForensicsCases('submitted');
  loadMessages();
  loadKenyaRegistryStatus();

  document.getElementById('regStatusFilter').addEventListener('change', (e) => loadRegistrations(e.target.value));
  document.getElementById('jobStatusFilter').addEventListener('change', (e) => loadJobs(e.target.value));
  document.getElementById('forensicsStatusFilter').addEventListener('change', (e) => loadForensicsCases(e.target.value));
  document.getElementById('userFilterBtn').addEventListener('click', loadUsers);
  document.getElementById('userSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUsers(); });

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { closeDocModal(); closeUserDetailModal(); }));
  document.getElementById('docPreviewOverlay').addEventListener('click', (e) => { if (e.target.id === 'docPreviewOverlay') closeDocModal(); });
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
          <button class="btn btn-primary" data-approve-id="${u.id}">Approve</button>
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
  tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);">Loading…</td></tr>';
  try {
    const params = new URLSearchParams();
    const q = document.getElementById('userSearchInput').value.trim();
    const type = document.getElementById('userTypeFilter').value;
    const status = document.getElementById('userStatusFilter').value;
    if (q) params.set('q', q);
    if (type) params.set('accountType', type);
    if (status) params.set('verificationStatus', status);

    const r = await adminApi(`/admin/users?${params.toString()}`);
    if (!r.users.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);">No accounts match.</td></tr>'; return; }

    tbody.innerHTML = r.users.map((u) => `
      <tr data-user-row="${u.id}" style="cursor:pointer;">
        <td data-label="Name"><b>${escapeHtml(u.full_name)}</b>${u.business_name ? `<div style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(u.business_name)}</div>` : ''}</td>
        <td data-label="Type"><span class="pill pill-${u.account_type}">${u.account_type === 'job_owner' ? 'Job owner' : 'Regular'}</span></td>
        <td data-label="Email">${escapeHtml(u.email)}</td>
        <td data-label="Phone">${escapeHtml(u.phone)}</td>
        <td data-label="ID number">${escapeHtml(u.national_id)}</td>
        <td data-label="Verification">${pill(u.id_verification_status)}</td>
        <td data-label="Joined">${new Date(u.created_at).toLocaleDateString()}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('[data-user-row]').forEach((row) => {
      row.addEventListener('click', () => viewUserDetail(row.dataset.userRow));
    });
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
          <div style="font-size:0.82rem;color:var(--text-muted);">${escapeHtml(j.location || '')} &middot; Reg#: ${escapeHtml(j.business_reg_number || 'n/a')} &middot; KRA: ${escapeHtml(j.kra_pin || 'n/a')} &middot; ${escapeHtml(j.owner_email)}</div>
          <p style="font-size:0.85rem;margin-top:6px;">${escapeHtml(j.description)}</p>
          ${j.rejection_reason ? `<div style="font-size:0.8rem;color:var(--scam-red);margin-top:4px;">Reason: ${escapeHtml(j.rejection_reason)}</div>` : ''}
        </div>
        ${status === 'pending' ? `
        <div class="action-btns">
          <button class="btn btn-primary" data-approve="${j.id}">Approve</button>
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

// ---------------- shared ----------------
function handleAuthError(err) {
  if (err.message.includes('token') || err.message.includes('authenticated')) window.location.href = 'login.html';
  else document.getElementById('globalAlert').innerHTML = `<div class="alert alert-err">${err.message}</div>`;
}
