// jobs/subscriptionMaintenance.js
//
// Run this once a day (see package.json "reminders" script + README for
// the cron entry). It does two things:
//
//   1. Flips any subscription whose expires_at has passed from 'active'
//      to 'expired'. Note: job visibility in search results does NOT
//      depend on this flag — routes/jobs.js checks expires_at directly
//      on every request, so suspension is already instant regardless of
//      whether this job has run yet. This step exists purely so the
//      admin panel and the job owner's own dashboard show an honest,
//      explicit "expired" status rather than a stale "active" label.
//
//   2. Sends renewal reminders at exactly 5, 3, and 1 day(s) before
//      expiry, once each — tracked via reminder_5_sent_at /
//      reminder_3_sent_at / reminder_1_sent_at so re-running this job
//      never double-sends the same reminder.
//
// Safe to run more than once a day: everything here is idempotent.

require('dotenv').config();
const pool = require('../db/pool');
const { sendSubscriptionReminderEmail } = require('../services/emailService');
// WhatsApp service is optional - comment out if not configured
// const { sendSubscriptionReminderWhatsApp } = require('../services/whatsappService');

async function expireLapsedSubscriptions() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE subscriptions SET status = 'expired'
       WHERE status = 'active' AND expires_at <= now()
       RETURNING id, user_id`
    );
    if (rows.length) {
      console.log(`Expired ${rows.length} lapsed subscription(s).`);
    }
    return rows.length;
  } catch (err) {
    console.error('Error expiring subscriptions:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function sendRemindersForWindow(daysOut, columnName) {
  const client = await pool.connect();
  try {
    // Matches subscriptions expiring on the calendar day exactly `daysOut`
    // days from now, that haven't had this specific reminder sent yet.
    const { rows } = await client.query(
      `SELECT s.id AS subscription_id, s.expires_at, u.id AS user_id, u.full_name, u.email, u.phone
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active'
         AND s.${columnName} IS NULL
         AND s.expires_at::date = (now() + ($1 || ' days')::interval)::date`,
      [daysOut]
    );

    let sent = 0;
    for (const row of rows) {
      let emailOk = false;
      let whatsappOk = false;

      // Send email reminder
      try {
        await sendSubscriptionReminderEmail({
          toEmail: row.email,
          fullName: row.full_name,
          daysRemaining: daysOut,
          expiresAt: row.expires_at,
        });
        emailOk = true;
        console.log(`Reminder email sent to ${row.email} (${daysOut} days remaining)`);
      } catch (e) {
        console.warn(`Reminder email failed for ${row.email}: ${e.message}`);
      }

      // Send WhatsApp reminder (optional - uncomment if configured)
      // try {
      //   await sendSubscriptionReminderWhatsApp({
      //     toPhone: row.phone,
      //     fullName: row.full_name,
      //     daysRemaining: daysOut,
      //     expiresAt: row.expires_at,
      //   });
      //   whatsappOk = true;
      // } catch (e) {
      //   console.warn(`Reminder WhatsApp message failed for ${row.phone}: ${e.message}`);
      // }

      // Mark as sent even on partial failure — this reminder window has
      // passed either way, and we don't want to retry-spam someone daily
      // just because WhatsApp wasn't configured. Failures are logged above
      // for follow-up instead.
      if (emailOk || whatsappOk) {
        await client.query(`UPDATE subscriptions SET ${columnName} = now() WHERE id = $1`, [row.subscription_id]);
        sent++;
      } else {
        console.warn(`No reminder sent for subscription ${row.subscription_id} - both email and WhatsApp failed`);
      }
    }
    if (rows.length) {
      console.log(`${daysOut}-day reminders: ${sent}/${rows.length} sent.`);
    }
    return sent;
  } catch (err) {
    console.error(`Error sending ${daysOut}-day reminders:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function runMaintenance() {
  console.log('Starting subscription maintenance...');
  try {
    const expiredCount = await expireLapsedSubscriptions();
    const r5 = await sendRemindersForWindow(5, 'reminder_5_sent_at');
    const r3 = await sendRemindersForWindow(3, 'reminder_3_sent_at');
    const r1 = await sendRemindersForWindow(1, 'reminder_1_sent_at');
    
    const result = { 
      expiredCount, 
      remindersSent: r5 + r3 + r1,
      details: {
        '5-day': r5,
        '3-day': r3,
        '1-day': r1
      }
    };
    
    console.log('Subscription maintenance completed:', result);
    return result;
  } catch (err) {
    console.error('Subscription maintenance failed:', err.message);
    throw err;
  }
}

// Allow running directly (`node jobs/subscriptionMaintenance.js`) as well
// as being imported by server.js for an in-process daily convenience run.
if (require.main === module) {
  runMaintenance()
    .then(() => {
      console.log('Maintenance run completed, closing database connection...');
      return pool.end();
    })
    .catch((err) => {
      console.error('Subscription maintenance failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { runMaintenance };