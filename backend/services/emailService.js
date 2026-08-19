// emailService.js
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MANAGEMENT_EMAIL = process.env.MANAGEMENT_EMAIL || process.env.SMTP_USER || 'claimsagency254@gmail.com';
const SENDER_EMAIL = 'semacheck254@gmail.com';

// Helper function to send email via Brevo API
async function sendBrevoEmail({ to, subject, textContent, htmlContent, replyTo }) {
  if (!BREVO_API_KEY) {
    console.error('BREVO_API_KEY is missing in environment variables');
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
          email: to,
        },
      ],
      subject: subject,
      textContent: textContent,
      htmlContent: htmlContent || textContent.replace(/\n/g, '<br>'),
    };

    if (replyTo) {
      payload.replyTo = {
        email: replyTo,
      };
    }

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
    throw error;
  }
}

// Send OTP email
async function sendOtpEmail({ toEmail, fullName, code }) {
  const subject = 'Your SemaCheck verification code: ' + code;
  const textContent = 'Hi ' + (fullName || '') + ',\n\nYour SemaCheck verification code is: ' + code + '\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.\n\n— SemaCheck';
  const htmlContent = '<h2>Your Verification Code</h2><p>Hi ' + (fullName || '') + ',</p><p>Your SemaCheck verification code is: <strong>' + code + '</strong></p><p>This code expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p><p>— SemaCheck</p>';

  console.log('Sending OTP email to:', toEmail);
  console.log('OTP code:', code);

  return sendBrevoEmail({
    to: toEmail,
    subject: subject,
    textContent: textContent,
    htmlContent: htmlContent,
  });
}

// Send contact message to management
async function sendContactMessageToManagement({ fromEmail, message }) {
  const subject = 'New SemaCheck contact form message';
  const textContent = 'From: ' + fromEmail + '\n\n' + message;
  const htmlContent = '<h2>New Contact Form Message</h2><p><strong>From:</strong> ' + fromEmail + '</p><p><strong>Message:</strong></p><p>' + message.replace(/\n/g, '<br>') + '</p>';

  console.log('Sending contact message email to management');

  return sendBrevoEmail({
    to: MANAGEMENT_EMAIL,
    subject: subject,
    textContent: textContent,
    htmlContent: htmlContent,
    replyTo: fromEmail,
  });
}

// Send subscription reminder email
async function sendSubscriptionReminderEmail({ toEmail, fullName, daysRemaining, expiresAt }) {
  const urgency = daysRemaining <= 1 ? 'today' : 'in ' + daysRemaining + ' days';
  const subject = 'Your SemaCheck subscription expires ' + urgency;
  const textContent = 'Hi ' + (fullName || '') + ',\n\nYour job-owner subscription expires ' + urgency + ' (' + new Date(expiresAt).toLocaleDateString() + ').\n\nOnce it expires, your job postings are temporarily hidden from search results until you renew. Renew from your dashboard to keep your listings visible.\n\n— SemaCheck';
  const htmlContent = '<h2>Subscription Expiring</h2><p>Hi ' + (fullName || '') + ',</p><p>Your job-owner subscription expires <strong>' + urgency + '</strong> (' + new Date(expiresAt).toLocaleDateString() + ').</p><p>Once it expires, your job postings are temporarily hidden from search results until you renew.</p><p>Renew from your dashboard to keep your listings visible.</p><p>— SemaCheck</p>';

  console.log('Sending subscription reminder email to:', toEmail);

  return sendBrevoEmail({
    to: toEmail,
    subject: subject,
    textContent: textContent,
    htmlContent: htmlContent,
  });
}

module.exports = {
  sendOtpEmail,
  sendContactMessageToManagement,
  sendSubscriptionReminderEmail,
};