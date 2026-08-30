










const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { generalLimiter } = require('../middleware/rateLimiter');
const { normalizeKenyanPhone } = require('../utils/validators');

const router = express.Router();

const MIN_LOSS_KES = 1000;

router.post('/intake', requireAuth, generalLimiter, async (req, res) => {
  const { amountLost, scamDescription, evidenceNotes, contactPhone } = req.body;
  const amount = Number(amountLost);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter the amount you lost, in KES.' });
  }
  if (amount < MIN_LOSS_KES) {
    return res.status(400).json({
      error: `This service is currently available for losses of KES ${MIN_LOSS_KES.toLocaleString()} or more.`,
      belowMinimum: true,
    });
  }
  if (!scamDescription || scamDescription.trim().length < 20) {
    return res.status(400).json({ error: 'Describe what happened in a bit more detail (at least a couple of sentences) — this is what the investigator starts from.' });
  }

  const normalizedPhone = contactPhone ? normalizeKenyanPhone(contactPhone) : normalizeKenyanPhone(req.user.phone);

  const { rows } = await pool.query(
    `INSERT INTO forensics_cases (user_id, amount_lost, scam_description, evidence_notes, contact_phone)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, amount_lost, status, created_at`,
    [req.user.id, amount, scamDescription.trim(), (evidenceNotes || '').trim() || null, normalizedPhone]
  );

  res.status(201).json({ case: rows[0], message: 'Case created. Pay the case-opening fee to submit it for review.' });
});


router.get('/my-cases', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, amount_lost, status, created_at, updated_at FROM forensics_cases WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ cases: rows });
});

router.get('/:caseId', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, amount_lost, scam_description, evidence_notes, status, created_at, updated_at FROM forensics_cases WHERE id=$1 AND user_id=$2`,
    [req.params.caseId, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Case not found.' });
  res.json({ case: rows[0] });
});

module.exports = router;
