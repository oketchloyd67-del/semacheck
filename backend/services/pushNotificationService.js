const pool = require('../db/pool');

// Load web-push defensively: a missing/stale node_modules on the host must never
// crash the whole API at require-time (this bit us on Render — MODULE_NOT_FOUND
// in this file cascaded through every route into server.js).
let webpush = null;
try {
  webpush = require('web-push');
} catch (err) {
  console.error('[push] web-push module not installed — push notifications disabled. Run `npm install` in backend/.');
}

// VAPID keys — generate once and persist in env.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:semacheck254@gmail.com';

if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications will not work. Run: node -e "const w=require(\'web-push\');const k=w.generateVAPIDKeys();console.log(JSON.stringify(k))"');
}

/**
 * Generate and log VAPID keys (run once: node services/pushNotificationService.js)
 */
if (require.main === module && webpush) {
  const keys = webpush.generateVAPIDKeys();
  console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
}

/**
 * Save a push subscription for a user.
 * Deduplicates by endpoint (one subscription per browser/device).
 */
async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Invalid subscription payload');
  }

  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       created_at = now()`,
    [userId, endpoint, keys.p256dh, keys.auth, userAgent || null]
  );
}

/**
 * Remove a push subscription by endpoint.
 */
async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/**
 * Send a push notification to a single subscription.
 * Returns true on success, false if the subscription is expired/invalid.
 */
async function sendPush(subscription, payload) {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { TTL: 60 * 60 } // 1 hour
    );
    return true;
  } catch (err) {
    // 404 / 410 = subscription expired or unsubscribed
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [subscription.endpoint]);
      console.log('[push] Removed stale subscription:', subscription.endpoint.substring(0, 60));
      return false;
    }
    console.error('[push] Send failed:', err.message);
    return false;
  }
}

/**
 * Send a push notification to all subscriptions of a given user.
 */
async function sendToUser(userId, payload) {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { targeted: 0, sent: 0 };

  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );

  let sent = 0;
  for (const sub of rows) {
    const ok = await sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    if (ok) sent++;
  }
  return { targeted: rows.length, sent };
}

/**
 * Convenience: notify a user about account creation.
 */
async function notifyAccountCreated(userId, fullName) {
  await sendToUser(userId, {
    title: 'Welcome to SemaCheck! 🛡️',
    body: `Hi ${fullName || 'there'}, your account is ready. You can now verify numbers, Paybills, and job offers before you pay.`,
    url: '/',
  });
}

/**
 * Convenience: notify a user that search results are ready.
 */
async function notifySearchResults(userId, queryType, queryValue, verdict) {
  const typeLabels = { paybill: 'Paybill', phone: 'Phone number', job_offer: 'Job offer' };
  const verdictEmoji = { legit: '✅', scam: '🚨', suspicious: '⚠️', unverified: '❓' };
  const label = typeLabels[queryType] || queryType;
  const emoji = verdictEmoji[verdict] || '📋';
  const masked = queryValue.length > 8
    ? queryValue.substring(0, 4) + '****' + queryValue.slice(-3)
    : queryValue;

  await sendToUser(userId, {
    title: `${emoji} Search results ready`,
    body: `Your ${label} verification for ${masked} is ${verdict || 'complete'}. Tap to view the full result.`,
    url: '/',
  });
}

/**
 * Save a push subscription for an admin.
 * Deduplicates by endpoint (one subscription per browser/device).
 */
async function saveAdminSubscription(adminId, subscription, userAgent) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Invalid subscription payload');
  }

  await pool.query(
    `INSERT INTO push_subscriptions (admin_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       admin_id = EXCLUDED.admin_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       created_at = now()`,
    [adminId, endpoint, keys.p256dh, keys.auth, userAgent || null]
  );
}

/**
 * Send a push notification to all admin subscriptions.
 */
async function sendToAdmins(payload) {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { targeted: 0, sent: 0 };

  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE admin_id IS NOT NULL'
  );

  let sent = 0;
  for (const sub of rows) {
    const ok = await sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    if (ok) sent++;
  }
  return { targeted: rows.length, sent };
}

/**
 * Broadcast a push notification to ALL user subscriptions (admin broadcast).
 * Throws when push is not configured so the admin gets explicit feedback.
 */
async function broadcastToUsers(title, body, url) {
  if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('Push notifications are not configured on this server.');
  }

  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IS NOT NULL'
  );

  let sent = 0;
  for (const sub of rows) {
    const ok = await sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      { title, body, url: url || '/' }
    );
    if (ok) sent++;
  }
  return { targeted: rows.length, sent };
}

/**
 * Convenience: notify all admins that a new user has registered.
 */
async function notifyAdminsNewUser(fullName, accountType, email) {
  await sendToAdmins({
    title: '👤 New user registered',
    body: `${fullName || 'A user'} (${accountType || 'regular'}) just created an account. Email: ${email || 'N/A'}`,
    url: '/admin/deploy/dashboard.html',
  });
}

/**
 * Convenience: notify all admins that a forensics case was submitted.
 */
async function notifyAdminsForensicsCase(caseId, userName, amountLost) {
  const amount = Number(amountLost);
  await sendToAdmins({
    title: '🔍 New forensics case',
    body: `${userName || 'A user'} reported losing KES ${amount ? amount.toLocaleString() : '???'}. Case needs review.`,
    url: '/admin/deploy/dashboard.html',
  });
}

module.exports = {
  saveSubscription,
  removeSubscription,
  sendToUser,
  notifyAccountCreated,
  notifySearchResults,
  saveAdminSubscription,
  sendToAdmins,
  notifyAdminsNewUser,
  notifyAdminsForensicsCase,
  broadcastToUsers,
};
