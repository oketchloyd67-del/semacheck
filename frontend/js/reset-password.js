const API_BASE = 'https://semacheck.onrender.com/api';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const alertBox = document.getElementById('resetAlert');
  const formBox = document.getElementById('resetForm');
  const doneBox = document.getElementById('resetDone');

  if (!token || token.length < 32) {
    formBox.style.display = 'none';
    alertBox.innerHTML = '<div class="alert alert-err">This reset link is invalid. Request a new one from the login screen.</div>';
    return;
  }

  const passwordInput = document.getElementById('rpPassword');
  passwordInput.addEventListener('input', (e) => renderStrengthMeter(e.target.value));

  document.getElementById('rpSubmit').addEventListener('click', async () => {
    const btn = document.getElementById('rpSubmit');
    const label = document.getElementById('rpBtnLabel');
    const confirmMsg = document.getElementById('rpConfirmMsg');
    const password = passwordInput.value;
    const confirm = document.getElementById('rpPasswordConfirm').value;
    alertBox.innerHTML = '';
    confirmMsg.textContent = '';
    confirmMsg.className = 'field-msg';

    if (password !== confirm) {
      confirmMsg.textContent = 'Passwords do not match.';
      confirmMsg.className = 'field-msg err';
      return;
    }
    if (password.length < 8) {
      confirmMsg.textContent = 'Use at least 8 characters.';
      confirmMsg.className = 'field-msg err';
      return;
    }

    btn.disabled = true;
    label.innerHTML = '<span class="spinner"></span> Updating...';
    try {
      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.message || data.error || 'Could not reset the password.');
        if (data.strength) renderStrengthMeter(password);
        throw err;
      }
      formBox.style.display = 'none';
      doneBox.style.display = 'block';
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-err">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      label.textContent = 'Update password';
    }
  });
});
