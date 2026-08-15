// routes/contact.js
const express = require('express');
const pool = require('../db/pool');
const { isValidEmail } = require('../utils/validators');
const { generalLimiter } = require('../middleware/rateLimiter');
const { sendContactMessageToManagement } = require('../services/emailService');

const router = express.Router();

router.post('/', generalLimiter, async (req, res) => {
  const { email, message } = req.body;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!message || message.trim().length < 5) return res.status(400).json({ error: 'Enter a message.' });

  const { rows } = await pool.query(
    `INSERT INTO contact_messages (email, message) VALUES ($1,$2) RETURNING id`,
    [email.trim().toLowerCase(), message.trim()]
  );

  try {
    await sendContactMessageToManagement({ fromEmail: email.trim(), message: message.trim() });
    await pool.query('UPDATE contact_messages SET emailed_ok = TRUE WHERE id=$1', [rows[0].id]);
    res.json({ message: 'Message sent to management. They\'ll get back to you by email.' });
  } catch (err) {
    // Message is safely saved either way; be honest if the email leg failed.
    res.json({ message: 'Message received and saved. (Email delivery is not configured in this environment yet.)', warning: err.message });
  }
});

module.exports = router;
