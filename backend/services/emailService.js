
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MANAGEMENT_EMAIL = process.env.MANAGEMENT_EMAIL || 'claimsagency254@gmail.com';
const SENDER_EMAIL = 'semacheck254@gmail.com';

console.log('emailService.js loaded');
console.log('BREVO_API_KEY exists:', !!BREVO_API_KEY);
console.log('MANAGEMENT_EMAIL:', MANAGEMENT_EMAIL);
console.log('SENDER_EMAIL:', SENDER_EMAIL);

async function sendOtpEmail({ toEmail, fullName, code }) {
  console.log('sendOtpEmail called with:', { toEmail, fullName, code });

  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY is missing');
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const payload = {
      sender: {
        email: SENDER_EMAIL,
        name: 'SemaCheck',
      },
      to: [
        {
          email: toEmail,
        },
      ],
      subject: 'Your SemaCheck verification code: ' + code,
      textContent: 'Hi ' + (fullName || '') + ',\n\nYour SemaCheck verification code is: ' + code + '\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.',
      htmlContent: '<h2>Your Verification Code</h2><p>Hi ' + (fullName || '') + ',</p><p>Your SemaCheck verification code is: <strong>' + code + '</strong></p><p>This code expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p>',
    };

    console.log('Sending Brevo email with payload:', JSON.stringify(payload, null, 2));

    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: payload,
    });

    console.log('Brevo email sent successfully. MessageId:', response.data.messageId);
    return response.data;
  } catch (error) {
    console.error('Brevo API error:');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);
    throw error;
  }
}

async function sendContactMessageToManagement({ fromEmail, message }) {
  console.log('sendContactMessageToManagement called');

  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY is missing');
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const payload = {
      sender: {
        email: SENDER_EMAIL,
        name: 'SemaCheck Contact Form',
      },
      to: [
        {
          email: MANAGEMENT_EMAIL,
        },
      ],
      replyTo: {
        email: fromEmail,
      },
      subject: 'New SemaCheck contact form message',
      textContent: 'From: ' + fromEmail + '\n\n' + message,
      htmlContent: '<h2>New Contact Form Message</h2><p><strong>From:</strong> ' + fromEmail + '</p><p><strong>Message:</strong></p><p>' + message.replace(/\n/g, '<br>') + '</p>',
    };

    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: payload,
    });

    console.log('Contact email sent successfully. MessageId:', response.data.messageId);
    return response.data;
  } catch (error) {
    console.error('Brevo API error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendSubscriptionReminderEmail({ toEmail, fullName, daysRemaining, expiresAt }) {
  console.log('sendSubscriptionReminderEmail called');

  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY is missing');
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const urgency = daysRemaining <= 1 ? 'today' : 'in ' + daysRemaining + ' days';
    const payload = {
      sender: {
        email: SENDER_EMAIL,
        name: 'SemaCheck',
      },
      to: [
        {
          email: toEmail,
        },
      ],
      subject: 'Your SemaCheck subscription expires ' + urgency,
      textContent: 'Hi ' + (fullName || '') + ',\n\nYour job-owner subscription expires ' + urgency + ' (' + new Date(expiresAt).toLocaleDateString() + ').\n\nOnce it expires, your job postings are temporarily hidden from search results until you renew. Renew from your dashboard to keep your listings visible.\n\n— SemaCheck',
      htmlContent: '<h2>Subscription Expiring</h2><p>Hi ' + (fullName || '') + ',</p><p>Your job-owner subscription expires <strong>' + urgency + '</strong> (' + new Date(expiresAt).toLocaleDateString() + ').</p><p>Once it expires, your job postings are temporarily hidden from search results until you renew.</p><p>Renew from your dashboard to keep your listings visible.</p><p>— SemaCheck</p>',
    };

    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: payload,
    });

    console.log('Subscription reminder sent. MessageId:', response.data.messageId);
    return response.data;
  } catch (error) {
    console.error('Brevo API error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendPasswordResetEmail({ toEmail, fullName, resetUrl }) {
  if (!BREVO_API_KEY) {
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }
  const payload = {
    sender: { email: SENDER_EMAIL, name: 'SemaCheck' },
    to: [{ email: toEmail }],
    subject: 'Reset your SemaCheck password',
    textContent: 'Hi ' + (fullName || '') + ',\n\nUse the link below to choose a new password for your SemaCheck account:\n\n' + resetUrl + '\n\nThe link expires in 30 minutes. If you did not request this, you can ignore this email — your password stays unchanged.',
    htmlContent: '<h2>Reset your password</h2><p>Hi ' + (fullName || '') + ',</p><p>Choose a new password for your SemaCheck account:</p><p><a href="' + resetUrl + '">Reset my password</a></p><p>This link expires in 30 minutes. If you did not request it, you can ignore this email — your password stays unchanged.</p>',
  };
  const response = await axios({
    method: 'POST',
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    data: payload,
  });
  return response.data;
}

async function sendApiPlanReminderEmail({ toEmail, fullName, companyName, planName, renewsOn }) {
  if (!BREVO_API_KEY) {
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }
  const renewsText = new Date(renewsOn).toLocaleDateString();
  const payload = {
    sender: { email: SENDER_EMAIL, name: 'SemaCheck' },
    to: [{ email: toEmail }],
    subject: 'Your SemaCheck API ' + planName + ' plan renews on ' + renewsText,
    textContent: 'Hi ' + (fullName || '') + ',\n\nYour ' + planName + ' API plan for ' + (companyName || 'your organisation') + ' renews on ' + renewsText + '.\n\nMake sure your invoice is settled by then — after the renewal date you get a 7-day grace period before live keys are suspended. You can review plans and invoices in the API dashboard.\n\n— SemaCheck',
    htmlContent: '<h2>API plan renewal reminder</h2><p>Hi ' + (fullName || '') + ',</p><p>Your <strong>' + planName + '</strong> API plan for ' + (companyName || 'your organisation') + ' renews on <strong>' + renewsText + '</strong>.</p><p>Make sure your invoice is settled by then — after the renewal date you get a 7-day grace period before live keys are suspended.</p><p><a href="https://semacheck.vercel.app/api-dashboard.html">Open your API dashboard</a></p><p>— SemaCheck</p>',
  };
  const response = await axios({
    method: 'POST',
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    data: payload,
  });
  console.log('API plan reminder sent. MessageId:', response.data.messageId);
  return response.data;
}

module.exports = {
  sendOtpEmail,
  sendContactMessageToManagement,
  sendSubscriptionReminderEmail,
  sendPasswordResetEmail,
  sendApiPlanReminderEmail,
};