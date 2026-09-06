const express = require('express');
const tuma = require('../services/tuma');

const router = express.Router();

router.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SemaCheck — Tuma Sandbox Test</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  .logo{text-align:center;margin-bottom:24px}
  .logo img{height:48px;border-radius:10px}
  .logo h1{font-size:20px;color:#5eead4;margin-top:8px}
  .logo p{font-size:13px;color:#94a3b8;margin-top:4px}
  label{display:block;font-size:14px;color:#94a3b8;margin-bottom:6px;margin-top:16px}
  input[type=text]{width:100%;padding:12px 16px;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;font-size:16px;outline:none;transition:border .2s}
  input:focus{border-color:#5eead4}
  .note{font-size:12px;color:#64748b;margin-top:4px}
  button{width:100%;margin-top:20px;padding:14px;background:linear-gradient(135deg,#5eead4,#14b8a6);color:#0f172a;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s}
  button:disabled{opacity:.5;cursor:not-allowed}
  button:hover:not(:disabled){opacity:.9}
  #result{margin-top:20px;padding:16px;background:#0f172a;border:1px solid #334155;border-radius:10px;display:none;font-size:13px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto}
  .success{border-color:#22c55e !important}
  .error{border-color:#ef4444 !important}
  .spinner{display:none;text-align:center;margin-top:16px}
  .spinner::after{content:'';display:inline-block;width:24px;height:24px;border:3px solid #334155;border-top-color:#5eead4;border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;margin-left:8px}
  .badge-sandbox{background:#f59e0b;color:#0f172a}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>SemaCheck Sandbox Test</h1>
    <p>M-Pesa STK Push Integration Test <span class="badge badge-sandbox">SANDBOX</span></p>
  </div>
  <form id="testForm">
    <label for="phone">M-Pesa Phone Number</label>
    <input type="text" id="phone" placeholder="0712345678" pattern="0[17]\\d{8}" required>
    <p class="note">Enter a valid Safaricom M-Pesa number. An STK push for <strong>KES 1</strong> will be sent.</p>
    <button type="submit" id="sendBtn">Send Test STK Push (KES 1)</button>
  </form>
  <div class="spinner" id="spinner"></div>
  <div id="result"></div>
</div>
<script>
  const form = document.getElementById('testForm');
  const btn = document.getElementById('sendBtn');
  const result = document.getElementById('result');
  const spinner = document.getElementById('spinner');
  const phoneInput = document.getElementById('phone');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = phoneInput.value.trim();
    if (!phone) return;

    btn.disabled = true;
    btn.textContent = 'Sending...';
    spinner.style.display = 'block';
    result.style.display = 'none';
    result.className = '';

    try {
      const res = await fetch('/api/sandbox-test/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await res.json();

      result.style.display = 'block';
      if (res.ok && data.success) {
        result.className = 'success';
        result.textContent = 'SUCCESS\\n\\n' + JSON.stringify(data, null, 2);
      } else {
        result.className = 'error';
        result.textContent = 'FAILED\\n\\n' + JSON.stringify(data, null, 2);
      }
    } catch (err) {
      result.style.display = 'block';
      result.className = 'error';
      result.textContent = 'ERROR\\n\\n' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Test STK Push (KES 1)';
      spinner.style.display = 'none';
    }
  });
</script>
</body>
</html>`);
});

router.post('/test', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^0[17]\d{8}$/.test(phone)) {
    return res.status(400).json({ success: false, error: 'Invalid phone number. Use format 0712345678.' });
  }

  try {
    const stk = await tuma.stkPush({
      phone,
      amount: 1,
      description: 'SemaCheck sandbox test — KES 1',
    });
    res.json({
      success: true,
      message: 'STK push sent successfully. Check your phone for the M-Pesa PIN prompt.',
      checkout_request_id: stk.checkout_request_id,
      merchant_request_id: stk.merchant_request_id,
      customer_message: stk.customer_message,
      amount: 1,
      phone,
    });
  } catch (err) {
    console.error('Sandbox test STK push failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(502).json({
      success: false,
      error: err.message,
      details: err.response ? err.response.data : null,
    });
  }
});

module.exports = router;
