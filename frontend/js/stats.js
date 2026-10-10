const API_BASE = 'https://semacheck.onrender.com/api';

function drawDailyChart(series) {
  const canvas = document.getElementById('daily-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 600;
  const cssHeight = 160;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padLeft = 34;
  const padBottom = 22;
  const padTop = 10;
  const padRight = 8;
  const w = cssWidth - padLeft - padRight;
  const h = cssHeight - padTop - padBottom;

  if (!series.length) {
    ctx.fillStyle = '#7c8aa5';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('No data yet.', padLeft, cssHeight / 2);
    return;
  }

  const max = Math.max(...series.map((s) => s.n), 1);
  ctx.strokeStyle = '#e4e9f2';
  ctx.fillStyle = '#7c8aa5';
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padTop + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + w, y);
    ctx.stroke();
    const val = Math.round(max - (max / 4) * i);
    ctx.fillText(String(val), 4, y + 3);
  }

  const step = series.length > 1 ? w / (series.length - 1) : 0;
  const points = series.map((s, i) => ({
    x: padLeft + (series.length > 1 ? i * step : w / 2),
    y: padTop + h - (s.n / max) * h,
  }));

  ctx.beginPath();
  ctx.moveTo(points[0].x, padTop + h);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, padTop + h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(11,31,58,0.08)';
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = '#0B1F3A';
  ctx.lineWidth = 2;
  ctx.stroke();

  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0B1F3A';
    ctx.fill();
  });

  const every = Math.ceil(series.length / 7);
  series.forEach((s, i) => {
    if (i % every !== 0 && i !== series.length - 1) return;
    ctx.fillStyle = '#7c8aa5';
    ctx.font = '9px system-ui, sans-serif';
    const label = s.day.slice(5);
    ctx.fillText(label, points[i].x - 12, cssHeight - 6);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch(`${API_BASE}/public/stats`, { cache: 'no-store' });
    const data = await res.json();
    document.getElementById('st-checks').textContent = Number(data.checksServed || 0).toLocaleString();
    document.getElementById('st-reports').textContent = Number(data.approvedReports || 0).toLocaleString();
    document.getElementById('st-accounts').textContent = Number(data.activeAccounts || 0).toLocaleString();
    document.getElementById('st-p50').textContent = `${Math.round(data.latencyP50 || 0)} ms`;
    document.getElementById('st-p95').textContent = `${Math.round(data.latencyP95 || 0)} ms`;
    drawDailyChart(Array.isArray(data.dailySeries) ? data.dailySeries : []);
    window.addEventListener('resize', () => drawDailyChart(Array.isArray(data.dailySeries) ? data.dailySeries : []));
  } catch {
    document.getElementById('st-checks').textContent = '—';
    document.getElementById('st-reports').textContent = '—';
    document.getElementById('st-accounts').textContent = '—';
    document.getElementById('st-p50').textContent = '—';
    document.getElementById('st-p95').textContent = '—';
  }
});
