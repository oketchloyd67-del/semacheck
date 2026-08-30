
require('dotenv').config();
const nodemailer = require('nodemailer');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

async function testEmail() {
  console.log('Testing SMTP connection...');
  console.log('SMTP_HOST:', process.env.SMTP_HOST);
  console.log('SMTP_PORT:', process.env.SMTP_PORT);
  console.log('SMTP_USER:', process.env.SMTP_USER);
  console.log('SMTP_PASS:', process.env.SMTP_PASS ? 'Set' : 'Missing');
  console.log('MANAGEMENT_EMAIL:', process.env.MANAGEMENT_EMAIL);

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
        rejectUnauthorized: false,
      },
      family: 4,
      socketTimeout: 30000,
      connectionTimeout: 30000,
    });

    await transporter.verify();
    console.log('SMTP connection verified successfully');

    const info = await transporter.sendMail({
      from: '"SemaCheck Test" <' + process.env.SMTP_USER + '>',
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