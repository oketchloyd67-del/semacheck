const API_BASE = 'https://semacheck.onrender.com/api';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function typeLabel(type) {
  const map = { phone: 'Phone number', paybill: 'Paybill', business: 'Business', website: 'Website', job: 'Job offer' };
  return map[type] || type;
}

function feedback(kind, message) {
  const box = document.getElementById('ds-feedback');
  box.innerHTML = `<div class="alert alert-${kind}">${escapeHtml(message)}</div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('dispute-form');
  const summary = document.getElementById('report-summary');
  const params = new URLSearchParams(location.search);
  const reportId = Number(params.get('id'));

  if (!reportId || !Number.isInteger(reportId) || reportId < 1) {
    summary.style.display = 'block';
    document.getElementById('ds-report-title').textContent = 'No listing selected';
    document.getElementById('ds-report-subject').textContent = 'Open a dispute from a report on the Alerts page — each unlocked listing has a "Dispute this listing" link.';
    form.style.display = 'block';
    form.querySelector('button[type="submit"]').disabled = true;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/reports/public/${reportId}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.report) throw new Error(data.error || 'Report not found.');
    const r = data.report;
    summary.style.display = 'block';
    document.getElementById('ds-report-title').textContent = 'Report summary';
    document.getElementById('ds-report-subject').textContent = r.name || r.subject;
    document.getElementById('ds-report-type').textContent = `${typeLabel(r.type)} · Reported ${new Date(r.reportedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    document.getElementById('ds-report-description').textContent = r.description || 'Details are locked for this listing.';
  } catch (err) {
    summary.style.display = 'block';
    document.getElementById('ds-report-title').textContent = 'Report summary';
    document.getElementById('ds-report-subject').textContent = err.message;
  }

  form.style.display = 'block';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('ds-submit');
    const message = document.getElementById('ds-msg').value.trim();
    if (message.length < 40) {
      feedback('err', 'Explain the dispute in at least 40 characters so the team can act on it.');
      return;
    }
    const fd = new FormData();
    fd.append('name', document.getElementById('ds-name').value.trim());
    fd.append('email', document.getElementById('ds-email').value.trim());
    fd.append('phone', document.getElementById('ds-phone').value.trim());
    fd.append('relationship', document.getElementById('ds-rel').value);
    fd.append('message', message);
    const fileInput = document.getElementById('ds-evidence');
    if (fileInput.files && fileInput.files[0]) fd.append('evidence', fileInput.files[0]);

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    try {
      const res = await fetch(`${API_BASE}/reports/${reportId}/dispute`, { method: 'POST', body: fd, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Could not submit the dispute.');
      form.innerHTML = `
        <div class="alert alert-ok" style="margin-bottom:14px;"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:-3px;margin-right:4px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Dispute opened</div>
        <p>${escapeHtml(data.message || 'Dispute opened. A first response is promised within three working days and we email the outcome.')}</p>
        <p style="margin-top:14px;"><a class="btn btn-ghost" href="alerts.html">Back to alerts</a></p>`;
      form.style.display = 'block';
    } catch (err) {
      feedback('err', err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit dispute';
    }
  });
});
