// test-email.js
require('dotenv').config();
const nodemailer = require('nodemailer');

async function testEmail() {
  console.log('Testing SMTP connection...');
  console.log('Host:', process.env.SMTP_HOST);
  console.log('Port:', process.env.SMTP_PORT);
  console.log('User:', process.env.SMTP_USER);
  console.log('Pass:', process.env.SMTP_PASS ? 'Set' : 'Missing');

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error('ERROR: SMTP configuration is incomplete.');
    console.error('Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file.');
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    await transporter.verify();
    console.log('SMTP connection verified successfully');

    const info = await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.MANAGEMENT_EMAIL || process.env.SMTP_USER,
      subject: 'Test Email from SemaCheck',
      text: 'If you received this, your SMTP is working correctly.',
      html: '<h1>SMTP Test Successful</h1><p>Your email configuration is correct.</p>',
    });

    console.log('Email sent successfully:', info.messageId);
  } catch (error) {
    console.error('SMTP error:', error.message);
    if (error.code) console.error('Error code:', error.code);
  }
}

testEmail();