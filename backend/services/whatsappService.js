// services/whatsappService.js
//
// Sends subscription-renewal reminders over WhatsApp. Built against
// Meta's WhatsApp Business Cloud API (the standard way to send
// templated WhatsApp messages programmatically) — you'll need a
// WhatsApp Business Account and an approved message template before
// this can send anything for real. See:
// https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
//
// WhatsApp requires pre-approved message templates for any
// business-initiated message (you can't just send free-form text the
// way you can with SMS/email) — so WHATSAPP_TEMPLATE_NAME below must
// match a template you've created and had approved in Meta Business
// Manager. Without real credentials configured, this fails loudly and
// honestly rather than pretending a message was sent.

const axios = require('axios');

const {
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_TEMPLATE_NAME,
  WHATSAPP_API_VERSION = 'v20.0',
} = process.env;

async function sendSubscriptionReminderWhatsApp({ toPhone, fullName, daysRemaining, expiresAt }) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    const err = new Error('WhatsApp is not configured (see .env.example: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_TEMPLATE_NAME).');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const expiryDateStr = new Date(expiresAt).toLocaleDateString();

  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: toPhone, // expects international format, e.g. 2547XXXXXXXX
      type: 'template',
      template: {
        name: WHATSAPP_TEMPLATE_NAME || 'subscription_reminder',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: fullName || 'there' },
              { type: 'text', text: String(daysRemaining) },
              { type: 'text', text: expiryDateStr },
            ],
          },
        ],
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` }, timeout: 10000 }
  );

  return data;
}

module.exports = { sendSubscriptionReminderWhatsApp };
