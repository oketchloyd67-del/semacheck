const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendContactMessageToManagement({ fromEmail, message }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured (see .env.example) — message was saved but not emailed.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  await t.sendMail({
    from: `"SemaCheck Contact Form" <${process.env.SMTP_USER}>`,
    to: process.env.MANAGEMENT_EMAIL,
    replyTo: fromEmail,
    subject: 'New SemaCheck contact form message',
    text: `From: ${fromEmail}\n\n${message}`,
  });
}

async function sendOtpEmail({ toEmail, fullName, code }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured (see .env.example) — could not send the verification code.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  await t.sendMail({
    from: `"SemaCheck" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Your SemaCheck verification code: ${code}`,
    text: `Hi ${fullName || ''},\n\nYour SemaCheck verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });
}

async function sendSubscriptionReminderEmail({ toEmail, fullName, daysRemaining, expiresAt }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured — subscription reminder was not emailed.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const urgency = daysRemaining <= 1 ? 'today' : `in ${daysRemaining} days`;
  await t.sendMail({
    from: `"SemaCheck" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Your SemaCheck subscription expires ${urgency}`,
    text: `Hi ${fullName || ''},\n\nYour job-owner subscription expires ${urgency} (${new Date(expiresAt).toLocaleDateString()}).\n\nOnce it expires, your job postings are temporarily hidden from search results until you renew. Renew from your dashboard to keep your listings visible.\n\n— SemaCheck`,
  });
}

module.exports = { sendContactMessageToManagement, sendOtpEmail, sendSubscriptionReminderEmail };
