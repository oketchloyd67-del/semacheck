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
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
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
      alert(`STK push sent to ${phone}. Enter your M-Pesa PIN to activate your 30-day subscription.`);
      await loadSummary();
    } catch (err) {
      alert(err.message);
    }
  });
});

async function loadSummary() {
  try {
    const r = await api('/jobs/dashboard-summary');
    document.getElementById('subDays').textContent = r.subscription.daysRemaining;
    const counts = Object.fromEntries((r.jobCounts || []).map((c) => [c.status, c.n]));
    document.getElementById('statPending').textContent = counts.pending || 0;
    document.getElementById('statApproved').textContent = counts.approved || 0;
    document.getElementById('statRejected').textContent = counts.rejected || 0;
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
        <span class="status-pill status-${j.status}">${j.status}</span>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="alert alert-err">${err.message}</div>`;
  }
}
