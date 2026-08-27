// backend/services/whatsappService.js
const axios = require('axios');

const {
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_TEMPLATE_NAME,
  WHATSAPP_API_VERSION = 'v20.0',
  WHATSAPP_VERIFY_TOKEN,
} = process.env;

// ---- Webhook Verification (GET) ----
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Webhook verification request:', { mode, token, challenge });

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed: Invalid token');
      res.sendStatus(403);
    }
  } else {
    console.error('Webhook verification failed: Missing mode or token');
    res.sendStatus(400);
  }
}

// ---- Handle Incoming Messages (POST) ----
async function handleIncomingMessage(req, res) {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry[0];
      const changes = entry.changes[0];
      const value = changes.value;

      if (value.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const from = message.from;
        const text = message.text?.body;

        console.log(`Received message from ${from}: ${text}`);

        // Reply to the user (optional)
        if (text) {
          await sendWhatsAppMessage(from, 'Thank you for your message! We will get back to you shortly.');
        }
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Error handling incoming message:', error);
    res.sendStatus(500);
  }
}

// ---- Send a Text Message ----
async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    const err = new Error('WhatsApp is not configured');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: {
          preview_url: false,
          body: message,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    console.log('WhatsApp message sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// ---- Send Subscription Reminder (Your existing function) ----
async function sendSubscriptionReminderWhatsApp({ toPhone, fullName, daysRemaining, expiresAt }) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    const err = new Error('WhatsApp is not configured (see .env.example: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_TEMPLATE_NAME).');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const expiryDateStr = new Date(expiresAt).toLocaleDateString();

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: toPhone,
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
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    console.log('Subscription reminder sent via WhatsApp:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending subscription reminder:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  verifyWebhook,
  handleIncomingMessage,
  sendWhatsAppMessage,
  sendSubscriptionReminderWhatsApp,
};