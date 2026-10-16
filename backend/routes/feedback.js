const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { authLimiter } = require('../middleware/rateLimiter');
const { normalizeSubject, hashSubject } = require('../services/normalizeService');

const router = express.Router();

// POST /api/feedback/verdict — "this verdict is wrong" button on result pages.
// Stores only a hashed subject reference (never the raw phone number etc.),
// the verdict shown, and the reviewer's free-text explanation.
router.post('/verdict', authLimiter, async (req, res) => {
  try {
    const { checkType, subject, verdict, message, email } = req.body || {};
    if (!message || String(message).trim().length < 10) {
      return res.status(400).json({ error: 'Tell us what looks wrong in at least 10 characters.' });
    }
    if (verdict && !['reported', 'caution', 'registered', 'unverified'].includes(String(verdict))) {
      return res.status(400).json({ error: 'Unrecognised verdict value.' });
    }

    let subjectHash = null;
    if (subject && checkType) {
      try {
        const normalized = normalizeSubject(checkType, subject);
        subjectHash = hashSubject(checkType, normalized);
      } catch {
        // Unnormalisable subject (e.g. free text) — keep the feedback without it.
      }
    }

    await pool.query(
      `INSERT INTO verdict_feedback (check_type, subject_hash, previous_verdict, message, contact_email)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        checkType ? String(checkType).slice(0, 20) : null,
        subjectHash,
        verdict ? String(verdict).slice(0, 20) : null,
        String(message).trim().slice(0, 2000),
        email ? String(email).trim().slice(0, 255) || null : null,
      ]
    );

    res.status(201).json({ message: 'Thanks — the review team will look at this verdict.' });
  } catch (err) {
    console.error('verdict feedback failed:', err);
    res.status(500).json({ error: 'Could not save your feedback. Please try again.' });
  }
});

module.exports = router;
