const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { saveSubscription, removeSubscription } = require('../services/pushNotificationService');

const router = express.Router();

// VAPID public key endpoint — frontend fetches this to subscribe
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  }
  res.json({ publicKey: key });
});

// Save a push subscription for the authenticated user
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }

    await saveSubscription(req.user.id, subscription, req.headers['user-agent']);
    res.json({ message: 'Push notifications enabled.' });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Could not save push subscription.' });
  }
});

// Remove a push subscription (user opts out or unsubscribes)
router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await removeSubscription(endpoint);
    }
    res.json({ message: 'Push notifications disabled for this device.' });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Could not remove push subscription.' });
  }
});

module.exports = router;
