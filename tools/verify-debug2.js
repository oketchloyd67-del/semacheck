const crypto = require('crypto');

const secret = 'test-secret';
const ts = 1700000000;
const EVENT = 'webhook.test_event';
const PAYLOAD = { event: EVENT, data: { id: '1' } };
const body = JSON.stringify(PAYLOAD);

function sign(secret, timestamp, body) {
  const data = `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

function verifySignature(body, timestamp, expected, header) {
  if (!body || timestamp === undefined || expected === undefined || !header) return false;
  const parts = {};
  try {
    for (const segment of header.split(',')) {
      const [k, v] = segment.split('=');
      parts[k.trim()] = v.trim();
    }
  } catch {
    return false;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  const digest = crypto.createHmac('sha256', expected).update(`${t}.${body}`).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const token = sign(secret, ts, body);
const expect = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('base64');
const header = 't=' + ts + ',v1=' + token;

console.log('token len', Buffer.byteLength(token));
console.log('parts.v1 len', Buffer.byteLength(header.split(',')[1].split('=')[1]));
console.log('verify', verifySignature(body, ts, expect, header));
