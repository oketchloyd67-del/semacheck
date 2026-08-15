// services/tuma.js — Tuma Payment Solutions gateway (api.tuma.co.ke)
// Replaces a direct Safaricom Daraja integration: Tuma sits in front of
// M-Pesa (and Kenyan banks) and gives one simpler API + one dashboard,
// at the cost of Tuma taking a small cut/holding the merchant relationship
// instead of you dealing with Safaricom directly.
//
// Auth flow: exchange TUMA_EMAIL + TUMA_API_KEY for a short-lived JWT via
// POST /auth/token, then use that token as a Bearer token on STK push
// calls. We cache the token in memory and only re-fetch when it's close
// to expiry, so we're not re-authenticating on every payment request.

const axios = require('axios');

const BASE_URL = process.env.TUMA_BASE_URL || 'https://api.tuma.co.ke';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : Date.now() + 15 * 60 * 1000;
  } catch {
    return Date.now() + 15 * 60 * 1000; // fall back to a conservative 15 min
  }
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken; // still valid for at least another minute
  }
  if (!process.env.TUMA_EMAIL || !process.env.TUMA_API_KEY) {
    const err = new Error('Tuma credentials are not configured (see .env.example: TUMA_EMAIL, TUMA_API_KEY).');
    err.code = 'TUMA_NOT_CONFIGURED';
    throw err;
  }

  const { data } = await axios.post(
    `${BASE_URL}/auth/token`,
    { email: process.env.TUMA_EMAIL, api_key: process.env.TUMA_API_KEY },
    { timeout: 10000 }
  );
  if (!data.success) throw new Error(data.message || 'Tuma authentication failed.');

  cachedToken = data.data.token;
  cachedTokenExpiresAt = decodeJwtExp(cachedToken);
  return cachedToken;
}

/**
 * Initiates an STK push via Tuma. Caller persists a `payments` row with
 * the returned checkout_request_id *before* awaiting user action, then
 * updates it when Tuma's callback lands (routes/payments.js).
 */
async function stkPush({ phone, amount, description = 'SemaCheck payment' }) {
  const token = await getAccessToken();
  const { data } = await axios.post(
    `${BASE_URL}/payment/stk-push`,
    {
      amount,
      phone,
      callback_url: process.env.TUMA_CALLBACK_URL,
      description,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  if (!data.success) {
    const err = new Error(data.message || 'Tuma STK push failed.');
    err.code = 'TUMA_STK_FAILED';
    throw err;
  }
  return data.data; // { merchant_request_id, checkout_request_id, customer_message }
}

module.exports = { stkPush, getAccessToken };
