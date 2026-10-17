/**
 * SemaCheck embeddable widget.
 *
 * Plain JavaScript, no dependencies. Renders a "Check before you pay" box
 * inside a Shadow DOM. Exposes SemaCheckWidget.check() globally.
 *
 * Embed:
 *   <div id="semacheck-check"></div>
 *   <script src="https://YOUR-FRONTEND-DOMAIN/widget/semacheck-widget.js"
 *           data-key="pk_live_xxxx"
 *           data-types="phone,paybill"
 *           data-theme="light"
 *           data-target="#semacheck-check"
 *           async></script>
 */

(function () {
  'use strict';

  const CONFIG = {
    API_BASE: (null && document.currentScript && document.currentScript.dataset.apiBase) || null,
    WIDGET_KEY: document.currentScript ? document.currentScript.dataset.key : null,
    ALLOWED_TYPES: (document.currentScript ? document.currentScript.dataset.types : null || 'phone,paybill').split(',').map((s) => s.trim()).filter(Boolean),
    THEME: document.currentScript ? document.currentScript.dataset.theme || 'light' : 'light',
    TARGET: document.currentScript ? document.currentScript.dataset.target : '#semacheck-check',
    // Gate mode (all optional). Without any of these the widget is a plain
    // checker. With them the pay button stays locked until the check passes,
    // and any edit to the number clears the token (CHK-05).
    GATE_INPUT: document.currentScript ? document.currentScript.dataset.input || null : null,
    GATE_BUTTON: document.currentScript ? document.currentScript.dataset.payButton || null : null,
    GATE_TOKEN_FIELD: document.currentScript ? document.currentScript.dataset.tokenField || null : null,
  };

  const SVG = {
    shield: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    dollar: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    users: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M16 5a3 3 0 0 1 0 5"/><path d="M17 16a3 3 0 0 1 0 5"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 1 1-8.49 8.49l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 1 1 8.49-8.49l-3.76 3.76z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><triangle-filled points="12 2 2 7 12 12 22 7" /><line x1="12" y1="12" x2="12" y2="22"/><line x1="12" y1="12" x2="16" y2="16"/></svg>',
    dispute: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16v-4"/><path d="M14 16v-4"/><path d="M8 20h8"/><circle cx="12" cy="10" r="1.5" fill="currentColor"/></svg>',
    ban: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  };

  const VERDICT_CLASS = {
    reported: 'v-reported',
    caution: 'v-caution',
    registered: 'v-registered',
    unverified: 'v-unverified',
  };

  const LABEL_CLASS = {
    reported: 'label-reported',
    caution: 'label-caution',
    registered: 'label-registered',
    unverified: 'label-unverified',
  };

  const LABEL_TEXT = {
    reported: 'Reported',
    caution: 'Caution',
    registered: 'Registered',
    unverified: 'Unverified',
  };

  const STATUS_BG = {
    reported: 'var(--scam-red)',
    caution: 'var(--suspicious-amber)',
    registered: 'var(--legit-green)',
    unverified: 'var(--border)',
  };

  function resolveApiBase() {
    if (CONFIG.API_BASE) return CONFIG.API_BASE;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://localhost:4800';
    }
    return window.location.origin;
  }

  const API_BASE = resolveApiBase();

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function formatMoney(kes) {
    if (kes === 0 || !kes) return 'Free';
    return 'KES ' + Number(kes).toLocaleString();
  }

  function buildWidget() {
    const shadow = document.createElement('div');
    shadow.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; }
      .widget { --w: 340px; max-width: 100%; border-radius: var(--radius); box-shadow: var(--shadow); background: var(--card); color: var(--text); font-family: var(--font-stack, 'Inter', system-ui, -apple-system, sans-serif); }
      .top { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding: 14px 16px; }
      .top-left { display: flex; align-items: center; gap: 10px; }
      .top .brand { font-weight: 800; font-size: 0.95rem; color: var(--navy); }
      .top .badge { font-size: 0.7rem; color: var(--text-muted); background: var(--bg); border-radius: 999px; padding: 2px 9px; }
      .btn-check { flex: 1; background: var(--teal); color: #06282a; border: none; border-radius: 9px; padding: 12px; font-size: 0.95rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: transform 0.15s ease, box-shadow 0.15s ease; }
      .btn-check:hover { box-shadow: 0 6px 18px rgba(15,163,163,0.35); }
      .btn-check:disabled { opacity: 0.5; cursor: not-allowed; }
      .body { padding: 14px 16px; }
      .input-wrap { position: relative; margin-bottom: 10px; }
      .input-wrap label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
      .input-wrap input { width: 100%; padding: 11px 12px; border-radius: 8px; border: 1.5px solid var(--border); font-size: 0.95rem; font-family: inherit; box-sizing: border-box; }
      .input-wrap input:focus { outline: none; border-color: var(--teal); box-shadow: 0 0 0 3px rgba(15,163,163,0.15); }
      .types { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
      .types span { font-size: 0.75rem; padding: 4px 10px; border-radius: 999px; border: 1.5px solid var(--border); background: #fff; cursor: pointer; user-select: none; }
      .types span.active { border-color: var(--teal); background: rgba(15,163,163,0.1); }
      .result { display: none; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); margin-top: 10px; }
      .result.visible { display: block; }
      .verdict { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .verdict .label { color: var(--text-muted); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
      .verdict .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
      .verdict .dot.reported { background: var(--scam-red); box-shadow: 0 0 0 3px rgba(214,69,92,0.25); }
      .verdict .dot.caution { background: var(--suspicious-amber); box-shadow: 0 0 0 3px rgba(224,162,39,0.25); }
      .verdict .dot.registered { background: var(--legit-green); box-shadow: 0 0 0 3px rgba(35,164,106,0.25); }
      .verdict .dot.unverified { background: var(--border); box-shadow: 0 0 0 3px rgba(226,232,240,0.25); }
      .reasons { font-size: 0.85rem; color: var(--text); margin-top: 8px; line-height: 1.5; }
      .reasons .item { margin-bottom: 4px; }
      .spinner { display: none; text-align: center; padding: 20px; color: var(--text-muted); }
      .spinner.visible { display: block; }
      .spinner svg { animation: spin 0.9s linear infinite; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .status { font-size: 0.8rem; color: var(--text-muted); margin-top: 8px; }
      .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 0.75rem; color: var(--text-muted); }
      .footer a { color: var(--teal); text-decoration: none; }
      .label-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; }
      .label-reported { background: var(--scam-red); }
      .label-caution { background: var(--suspicious-amber); color: #3a2400; }
      .label-registered { background: var(--legit-green); }
      .label-unverified { background: var(--border); color: var(--text-muted); }
      .error { display: none; padding: 10px 12px; border-radius: 8px; background: rgba(214,69,92,0.1); border: 1px solid var(--scam-red); color: var(--scam-red); font-size: 0.85rem; margin-top: 10px; }
      .error.visible { display: block; }
      @media (max-width: 420px) { .widget { --w: 100%; } }
    `;

    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'widget';
    root.id = 'sc-widget-root';

    const top = document.createElement('div');
    top.className = 'top';

    const topLeft = document.createElement('div');
    topLeft.className = 'top-left';
    topLeft.innerHTML = SVG.shield + '<span class="brand">SemaCheck</span>';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Check before you pay';
    topLeft.appendChild(badge);

    const btnCheck = document.createElement('button');
    btnCheck.className = 'btn-check';
    btnCheck.innerHTML = SVG.check + 'Check';
    top.appendChild(topLeft);
    top.appendChild(btnCheck);

    root.appendChild(top);

    const body = document.createElement('div');
    body.className = 'body';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'input-wrap';

    const inputLabel = document.createElement('label');
    inputLabel.textContent = 'Enter a phone number, paybill or business';
    inputWrap.appendChild(inputLabel);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'e.g. 254712345678 or 1234567';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Subject to check');
    inputWrap.appendChild(input);
    body.appendChild(inputWrap);

    const types = document.createElement('div');
    types.className = 'types';
    CONFIG.ALLOWED_TYPES.forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      s.dataset.type = t;
      s.setAttribute('role', 'radio');
      s.setAttribute('aria-checked', 'true');
      s.addEventListener('click', () => {
        CONFIG.ALLOWED_TYPES.forEach((x) => { document.querySelector(`.types span[data-type="${x}"]`).classList.toggle('active'); });
        s.classList.add('active');
        input.placeholder = t === 'phone' ? 'e.g. 254712345678' : t === 'paybill' ? 'e.g. 1234567' : 'e.g. Acme Ltd';
      });
      types.appendChild(s);
    });
    body.appendChild(types);
    root.appendChild(body);

    const resultEl = document.createElement('div');
    resultEl.className = 'result';
    resultEl.setAttribute('role', 'region');
    resultEl.setAttribute('aria-live', 'polite');
    resultEl.id = 'sc-widget-result';

    const spacer = document.createElement('div');

    const verdictRow = document.createElement('div');
    verdictRow.className = 'verdict';
    const vLabel = document.createElement('span');
    vLabel.className = 'label';
    vLabel.textContent = 'Verdict';
    const vDot = document.createElement('span');
    vDot.className = 'dot unverified';
    verdictRow.appendChild(vLabel);
    verdictRow.appendChild(vDot);
    resultEl.appendChild(verdictRow);

    const reasonsEl = document.createElement('div');
    reasonsEl.className = 'reasons';
    reasonsEl.id = 'sc-widget-reasons';
    resultEl.appendChild(reasonsEl);

    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.innerHTML = SVG.refresh + 'Checking, please wait…';
    spacer.appendChild(spinner);

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.id = 'sc-widget-status';
    resultEl.appendChild(statusEl);

    spacer.appendChild(statusEl);

    const errEl = document.createElement('div');
    errEl.className = 'error';
    errEl.id = 'sc-widget-error';
    errEl.setAttribute('role', 'alert');

    root.appendChild(resultEl);
    root.appendChild(spacer);
    root.appendChild(errEl);

    const footer = document.createElement('div');
    footer.className = 'footer';
    const powered = document.createElement('span');
    powered.textContent = 'Powered by SemaCheck';
    powered.innerHTML = SVG.info;
    const link = document.createElement('a');
    link.href = '/developers.html';
    link.textContent = 'Learn more';
    footer.appendChild(powered);
    footer.appendChild(link);
    root.appendChild(footer);

    shadow.appendChild(root);
    return shadow;
  }

  function mount(targetSelector) {
    const target = document.querySelector(targetSelector);
    if (!target) {
      console.warn('SemaCheck widget: target not found —', targetSelector);
      return;
    }
    if (target._scMounted) return;
    target._scMounted = true;

    const shadow = buildWidget();
    target.appendChild(shadow);

    const btnCheck = shadow.querySelector('.btn-check');
    const input = shadow.querySelector('.input-wrap input');
    const spinner = shadow.querySelector('.spinner');
    const resultEl = shadow.querySelector('.result');
    const errEl = shadow.querySelector('.error');
    const statusEl = shadow.querySelector('.status');
    const verdictRow = shadow.querySelector('.verdict');
    const vLabel = verdictRow ? verdictRow.querySelector('.label') : null;
    const reasonsEl = shadow.querySelector('.reasons');

    const typeEls = shadow.querySelectorAll('.types span');
    if (typeEls.length) typeEls[0].classList.add('active');

    // ── Gate mode ────────────────────────────────────────────────────────────
    // A browser lock is convenience, not security: the page's server must still
    // call POST /v1/result/verify with the token before it charges anyone.
    const gateBtn = CONFIG.GATE_BUTTON ? document.querySelector(CONFIG.GATE_BUTTON) : null;
    const gateInput = CONFIG.GATE_INPUT ? document.querySelector(CONFIG.GATE_INPUT) : null;
    const gateTokenField = CONFIG.GATE_TOKEN_FIELD ? document.querySelector(CONFIG.GATE_TOKEN_FIELD) : null;
    const gateOn = Boolean(gateBtn || gateTokenField);

    const lockPay = (reason) => {
      if (gateTokenField) gateTokenField.value = '';
      if (!gateBtn) return;
      gateBtn.disabled = true;
      gateBtn.setAttribute('aria-disabled', 'true');
      gateBtn.setAttribute('data-semacheck-locked', reason || 'unchecked');
      gateBtn.title = reason === 'blocked'
        ? 'SemaCheck reported this number. Payment is locked.'
        : 'Check the number with SemaCheck first.';
    };

    const unlockPay = (token) => {
      if (token && gateTokenField) gateTokenField.value = token;
      if (!gateBtn) return;
      gateBtn.disabled = false;
      gateBtn.removeAttribute('aria-disabled');
      gateBtn.removeAttribute('data-semacheck-locked');
      gateBtn.removeAttribute('title');
    };

    if (gateOn) {
      lockPay('unchecked');
      if (gateInput) {
        gateInput.addEventListener('input', () => {
          input.value = gateInput.value;      // the widget checks what the form will pay
          lockPay('changed');                 // any edit invalidates the token
          resultEl.classList.remove('visible');
        });
      }
    }

    const widget = {
      check() {
        if (btnCheck.disabled) return;
        btnCheck.disabled = true;
        btnCheck.innerHTML = '<span class="spinner"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Checking…</span>';
        resultEl.classList.remove('visible');
        errEl.classList.remove('visible');
        spinner.classList.add('visible');
        statusEl.textContent = '';

        const type = CONFIG.ALLOWED_TYPES.find((t) => { const s = document.querySelector(`.types span[data-type="${t}"]`); return s && s.classList.contains('active'); }) || CONFIG.ALLOWED_TYPES[0] || 'phone';
        const subject = input.value.trim();
        if (!subject) {
          errEl.textContent = 'Enter something to check.';
          errEl.classList.add('visible');
          btnCheck.disabled = false;
          btnCheck.innerHTML = SVG.check + 'Check';
          return;
        }
        statusEl.textContent = 'Checking…';

        fetch(`${API_BASE}/v1/widget/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkType: type, subject, region: 'kenya', gate: gateOn }),
        })
          .then(async (r) => {
            const data = await r.json();
            if (!r.ok) {
              throw new Error(data.error || 'Check failed.');
            }
            return data;
          })
          .then((data) => {
            spinner.classList.remove('visible');
            resultEl.classList.add('visible');
            const v = data.displayVerdict || data.verdict || 'Unverified';
            verdictRow.querySelector('.dot').className = 'dot ' + (VERDICT_CLASS[v] || 'unverified');
            vLabel.textContent = LABEL_TEXT[v] || v;
            (data.reasons || []).forEach((r) => {
              const item = document.createElement('div');
              item.className = 'item';
              item.innerHTML = '<span class="label-pill ' + (LABEL_CLASS[r.verdict] || 'label-unverified') + '">' + escapeHtml(r.source || '') + '</span> ' + escapeHtml(r.label);
              reasonsEl.appendChild(item);
            });
            statusEl.textContent = 'Done — check the result above.';
            if (gateOn) {
              // The server's decision is authoritative (reported -> block,
              // caution -> warn, registered -> allow, unverified -> warn).
              const decision = data.decision
                || (data.verdict === 'reported' ? 'block' : data.verdict === 'registered' ? 'allow' : 'warn');
              if (decision === 'block') {
                lockPay('blocked');
                statusEl.textContent = 'Reported — payment stays locked.';
              } else {
                unlockPay(data.resultToken);
                statusEl.textContent = decision === 'warn'
                  ? 'Caution or unverified — your server must acknowledge this before payment.'
                  : 'Registered — your server can now verify the result token.';
                if (gateInput && gateInput.value !== input.value) gateInput.value = input.value;
              }
            }
          })
          .catch((err) => {
            spinner.classList.remove('visible');
            statusEl.textContent = '';
            errEl.textContent = err.message || 'Could not check. Please try again.';
            errEl.classList.add('visible');
            btnCheck.disabled = false;
            btnCheck.innerHTML = SVG.check + 'Check';
            if (gateOn) lockPay('failed');
          });
      },
    };

    btnCheck.addEventListener('click', () => widget.check());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') widget.check(); });

    window.SemaCheckWidget = widget;
    console.log('SemaCheck widget mounted. Call SemaCheckWidget.check() to verify.');
  }

  const script = document.currentScript || (document.querySelector('script[src*="semacheck-widget.js"]') || null);
  const target = script ? (script.dataset.target || '#semacheck-check') : '#semacheck-check';
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(target));
  } else {
    mount(target);
  }
})();
