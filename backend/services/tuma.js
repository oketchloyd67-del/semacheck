










const axios = require('axios');

const BASE_URL = process.env.TUMA_BASE_URL || 'https://api.tuma.co.ke';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : Date.now() + 15 * 60 * 1000;
  } catch {
    return Date.now() + 15 * 60 * 1000; 
  }
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken; 
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
  return data.data; 
}

module.exports = { stkPush, getAccessToken };
