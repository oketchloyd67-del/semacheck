// emailService.js - Using Brevo API
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MANAGEMENT_EMAIL = process.env.MANAGEMENT_EMAIL || process.env.SMTP_USER;

async function sendContactMessageToManagement({ fromEmail, message }) {
  if (!BREVO_API_KEY) {
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: {
        sender: {
          email: 'semacheck254@gmail.com',
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
      },
    });

    console.log('Contact message email sent successfully via Brevo API');
    return response.data;
  } catch (error) {
    console.error('Failed to send contact message email:', error.response?.data || error.message);
    throw error;
  }
}

async function sendOtpEmail({ toEmail, fullName, code }) {
  if (!BREVO_API_KEY) {
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: {
        sender: {
          email: 'semacheck254@gmail.com',
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
      },
    });

    console.log('OTP email sent to:', toEmail);
    return response.data;
  } catch (error) {
    console.error('Failed to send OTP email:', error.response?.data || error.message);
    throw error;
  }
}

async function sendSubscriptionReminderEmail({ toEmail, fullName, daysRemaining, expiresAt }) {
  if (!BREVO_API_KEY) {
    const err = new Error('Brevo API key is not configured.');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  try {
    const urgency = daysRemaining <= 1 ? 'today' : 'in ' + daysRemaining + ' days';
    const response = await axios({
      method: 'POST',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: {
        sender: {
          email: 'semacheck254@gmail.com',
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
      },
    });

    console.log('Subscription reminder email sent to:', toEmail);
    return response.data;
  } catch (error) {
    console.error('Failed to send subscription reminder:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { 
  sendContactMessageToManagement, 
  sendOtpEmail, 
  sendSubscriptionReminderEmail 
};