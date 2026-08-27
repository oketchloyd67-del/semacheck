// backend/routes/whatsapp.js
const express = require('express');
const router = express.Router();
const { verifyWebhook, handleIncomingMessage } = require('../services/whatsappService');

// GET request for webhook verification
router.get('/webhook', verifyWebhook);

// POST request for incoming messages
router.post('/webhook', handleIncomingMessage);

module.exports = router;