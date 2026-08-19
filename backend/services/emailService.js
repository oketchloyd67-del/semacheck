// emailService.js
const nodemailer = require('nodemailer');
const dns = require('dns');

// Force IPv4 to avoid ENETUNREACH errors on cloud platforms
dns.setDefaultResultOrder('ipv4first');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP is not fully configured. Missing one or more required variables:');
    if (!process.env.SMTP_HOST) console.warn('  - SMTP_HOST is missing');
    if (!process.env.SMTP_USER) console.warn('  - SMTP_USER is missing');
    if (!process.env.SMTP_PASS) console.warn('  - SMTP_PASS is missing (app password)');
    return null;
  }

  try {
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const isSecure = process.env.SMTP_SECURE === 'true';

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: isSecure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
      socketTimeout: 30000,
      connectionTimeout: 30000,
    });

    // Force IPv4 by setting the family option
    transporter.options = transporter.options || {};
    transporter.options.family = 4;

    // Verify the connection
    transporter.verify(function(error, success) {
      if (error) {
        console.error('SMTP connection error:', error.message);
        transporter = null;
      } else {
        console.log('SMTP connection verified successfully');
      }
    });

    return transporter;
  } catch (error) {
    console.error('SMTP setup error:', error.message);
    return null;
  }
}

function getFromEmail() {
  return process.env.SMTP_USER || 'noreply@semacheck.co.ke';
}

async function sendContactMessageToManagement({ fromEmail, message }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured (see .env.example) — message was saved but not emailed.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  try {
    const info = await t.sendMail({
      from: '"SemaCheck Contact Form" <' + getFromEmail() + '>',
      to: process.env.MANAGEMENT_EMAIL || process.env.SMTP_USER,
      replyTo: fromEmail,
      subject: 'New SemaCheck contact form message',
      text: 'From: ' + fromEmail + '\n\n' + message,
    });
    console.log('Contact message email sent to management:', info.messageId);
    return info;
  } catch (error) {
    console.error('Failed to send contact message email:', error.message);
    throw error;
  }
}

async function sendOtpEmail({ toEmail, fullName, code }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured (see .env.example) — could not send the verification code.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  try {
    const info = await t.sendMail({
      from: '"SemaCheck" <' + getFromEmail() + '>',
      to: toEmail,
      subject: 'Your SemaCheck verification code: ' + code,
      text: 'Hi ' + (fullName || '') + ',\n\nYour SemaCheck verification code is: ' + code + '\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.',
    });
    console.log('OTP email sent to:', toEmail);
    return info;
  } catch (error) {
    console.error('Failed to send OTP email:', error.message);
    throw error;
  }
}

async function sendSubscriptionReminderEmail({ toEmail, fullName, daysRemaining, expiresAt }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured — subscription reminder was not emailed.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  try {
    var urgency = daysRemaining <= 1 ? 'today' : 'in ' + daysRemaining + ' days';
    const info = await t.sendMail({
      from: '"SemaCheck" <' + getFromEmail() + '>',
      to: toEmail,
      subject: 'Your SemaCheck subscription expires ' + urgency,
      text: 'Hi ' + (fullName || '') + ',\n\nYour job-owner subscription expires ' + urgency + ' (' + new Date(expiresAt).toLocaleDateString() + ').\n\nOnce it expires, your job postings are temporarily hidden from search results until you renew. Renew from your dashboard to keep your listings visible.\n\n— SemaCheck',
    });
    console.log('Subscription reminder email sent to:', toEmail);
    return info;
  } catch (error) {
    console.error('Failed to send subscription reminder:', error.message);
    throw error;
  }
}

module.exports = { 
  sendContactMessageToManagement, 
  sendOtpEmail, 
  sendSubscriptionReminderEmail 
};