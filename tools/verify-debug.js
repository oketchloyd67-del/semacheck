const crypto = require('crypto');
const svc = require('../backend/services/webhookService');

const secret = 'test-secret';
const ts = 1700000000;
const EVENT = 'webhook.test_event';
const PAYLOAD = { event: EVENT, data: { id: '1' } };
const body = JSON.stringify(PAYLOAD);

const token = svc.sign(secret, ts, body);
const expect = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('base64');
const header = 't=' + ts + ',v1=' + token;

console.log('token      ', JSON.stringify(token), 'len', Buffer.byteLength(token));
console.log('expect     ', JSON.stringify(expect), 'len', Buffer.byteLength(expect));
console.log('equal      ', token === expect);
console.log('verify     ', svc.verifySignature(body, ts, expect, header));
console.log('verifyBad  ', svc.verifySignature(body, ts, 'bad', header));
console.log('verifyWide ', svc.verifySignature(body + 'x', ts, expect, header));
