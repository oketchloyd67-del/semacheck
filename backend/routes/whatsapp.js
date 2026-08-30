
const express = require('express');
const router = express.Router();
const { verifyWebhook, handleIncomingMessage } = require('../services/whatsappService');


router.get('/webhook', verifyWebhook);


router.post('/webhook', handleIncomingMessage);

module.exports = router;