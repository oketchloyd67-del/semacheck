// End-to-end contract for the result-token flow: /v1/check with gate:true must
// return a decision and a signed token, and /v1/result/verify must accept it
// exactly once. Hermetic: the API-key middleware, check service and database
// pool are stubbed, so no live database is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

process.env.RESULT_TOKEN_SECRET = 'test-result-secret';

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const usedTokens = new Set();

stub('../db/pool', {
  async query(sql, params) {
    const text = String(sql);
    if (text.includes('INSERT INTO used_result_tokens')) {
      const jti = params[0];
      if (usedTokens.has(jti)) return { rowCount: 0 };
      usedTokens.add(jti);
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
});

stub('../middleware/apiKeyAuth', {
  apiKeyAuth(req, res, next) {
    req.id = 'req-test';
    req.apiKey = 'sk_live_test';
    req.apiKeyMode = 'live';
    req.apiKeyId = 1;
    req.apiAccount = {
      id: 7,
      userId: 'user-1',
      planName: 'Starter',
      planCode: 'starter',
      monthlyQuota: 2000,
      rateLimitPerMin: 60,
    };
    next();
  },
});

const passThrough = (req, res, next) => next();
stub('../middleware/apiRateLimit', { apiRateLimit: passThrough });
stub('../middleware/quotaMeter', { quotaMeter: passThrough });
stub('../middleware/widgetOrigin', { widgetOrigin: passThrough });
stub('../middleware/reportAbuseGuard', { reportAbuseGuard: passThrough });

stub('../services/usageService', {
  async logUsage() {},
  async getDailySeries() { return []; },
  async getMonthUsage() { return {}; },
});

// The check service stores a normalised display value; the token must still
// bind to the exact subject string the caller sent and later verifies with.
let lastRawValue = '+254 712 345 678';
stub('../services/checkService', {
  async run() {
    return {
      cached: false,
      result: {
        verdict: 'caution',
        confidence: 61,
        displayVerdict: 'Caution',
        reasons: [{ verdict: 'caution', source: 'reports', label: 'Some reports link this subject to a scam.' }],
        summary: 'Caution.',
        disputed: false,
        query_value: lastRawValue,
      },
    };
  },
});

const apiV1 = require('../routes/apiV1');

function post(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error('non-JSON response: ' + data)); }
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('gated check returns a token that verifies once and then cannot be reused', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/v1', apiV1);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  const gated = await post(port, '/v1/check', { checkType: 'phone', subject: '254712345678', gate: true });
  assert.equal(gated.status, 200);
  assert.equal(gated.body.verdict, 'caution');
  assert.equal(gated.body.decision, 'warn');
  assert.match(gated.body.resultToken, /^rt_/);

  const verifyBody = {
    resultToken: gated.body.resultToken,
    checkType: 'phone',
    subject: '254712345678',
    acknowledged: true,
  };

  const first = await post(port, '/v1/result/verify', verifyBody);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.proceed, true);
  assert.equal(first.body.decision, 'warn');
  assert.equal(first.body.reason, 'acknowledged');

  const second = await post(port, '/v1/result/verify', verifyBody);
  assert.equal(second.status, 400);
  assert.equal(second.body.ok, false);
  assert.equal(second.body.reason, 'token_used');
});

test('a token for another number is rejected as subject_mismatch', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/v1', apiV1);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  const gated = await post(port, '/v1/check', { checkType: 'phone', subject: '254712345678', gate: true });
  const res = await post(port, '/v1/result/verify', {
    resultToken: gated.body.resultToken,
    checkType: 'phone',
    subject: '254799999999',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'subject_mismatch');
});

test('a check without gate does not issue a token but still reports the decision', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/v1', apiV1);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  const plain = await post(port, '/v1/check', { checkType: 'phone', subject: '254712345678' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.decision, 'warn');
  assert.equal(plain.body.resultToken, undefined);
});
