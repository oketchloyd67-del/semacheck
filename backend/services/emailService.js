// services/emailService.js
// The contact dialogue box is the ONLY support channel — a message
// typed on the site is emailed straight to management via SMTP.
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

module.exports = { sendContactMessageToManagement };
