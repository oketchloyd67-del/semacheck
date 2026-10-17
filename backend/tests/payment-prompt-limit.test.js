// CHK-08: a payment-prompt limit is a rate limit, not "pay or wait". The
// fourth paid check for the same phone in an hour must answer 429
// payment_prompt_limited (with Retry-After), never 402 rate_limited.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { gateAbuseLimiter, PHONE_LIMIT_PER_HOUR } = require('../routes/paidCheckLimiter');

function post(port, body, keyId) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/gate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Test-Key': String(keyId),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('the fourth M-Pesa prompt to one phone is 429 payment_prompt_limited', async (t) => {
  const app = express();
  app.use(express.json());
  // The route normally sets req.apiKeyId from the bearer key.
  app.use((req, res, next) => { req.apiKeyId = req.headers['x-test-key'] || 'key-a'; next(); });
  app.use(gateAbuseLimiter);
  app.post('/gate', (req, res) => res.status(201).json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  const phone = '254712345678';
  for (let i = 1; i <= PHONE_LIMIT_PER_HOUR; i++) {
    const ok = await post(port, { checkType: 'phone', subject: phone, phone }, 'key-' + i);
    assert.equal(ok.status, 201, `prompt ${i} should be allowed`);
  }

  const limited = await post(port, { checkType: 'phone', subject: phone, phone }, 'key-other');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'payment_prompt_limited');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(Number(limited.headers['retry-after']), limited.body.retryAfter);
});

test('a per-key paid-check flood is 429 rate_limited, not 402', async (t) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.apiKeyId = req.headers['x-test-key'] || 'key-flood'; next(); });
  app.use(gateAbuseLimiter);
  app.post('/gate', (req, res) => res.status(201).json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  // 50 gates per key per hour; use one phone per gate so the phone limit never trips.
  let last;
  for (let i = 0; i <= 50; i++) {
    last = await post(port, { checkType: 'phone', subject: 'x', phone: `2547${String(10000000 + i).slice(0, 8)}` }, 'key-flood');
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
});
