



















require('dotenv').config();
const pool = require('../db/pool');
const { sendSubscriptionReminderEmail } = require('../services/emailService');
const { sendSubscriptionReminderWhatsApp } = require('../services/whatsappService');

async function expireLapsedSubscriptions() {
  const { rows } = await pool.query(
    `UPDATE subscriptions SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()
     RETURNING id, user_id`
  );
  if (rows.length) console.log(`Expired ${rows.length} lapsed subscription(s).`);
  return rows.length;
}

async function sendRemindersForWindow(daysOut, columnName) {
  
  
  const { rows } = await pool.query(
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

    try {
      await sendSubscriptionReminderEmail({
        toEmail: row.email, fullName: row.full_name, daysRemaining: daysOut, expiresAt: row.expires_at,
      });
      emailOk = true;
    } catch (e) {
      console.warn(`Reminder email failed for ${row.email}: ${e.message}`);
    }

    try {
      await sendSubscriptionReminderWhatsApp({
        toPhone: row.phone, fullName: row.full_name, daysRemaining: daysOut, expiresAt: row.expires_at,
      });
      whatsappOk = true;
    } catch (e) {
      console.warn(`Reminder WhatsApp message failed for ${row.phone}: ${e.message}`);
    }

    
    
    
    
    if (emailOk || whatsappOk) {
      await pool.query(`UPDATE subscriptions SET ${columnName} = now() WHERE id = $1`, [row.subscription_id]);
      sent++;
    }
  }
  if (rows.length) console.log(`${daysOut}-day reminders: ${sent}/${rows.length} sent.`);
  return sent;
}

async function runMaintenance() {
  const expiredCount = await expireLapsedSubscriptions();
  const r5 = await sendRemindersForWindow(5, 'reminder_5_sent_at');
  const r3 = await sendRemindersForWindow(3, 'reminder_3_sent_at');
  const r1 = await sendRemindersForWindow(1, 'reminder_1_sent_at');
  return { expiredCount, remindersSent: r5 + r3 + r1 };
}



if (require.main === module) {
  runMaintenance()
    .then((result) => {
      console.log('Subscription maintenance complete:', result);
      return pool.end();
    })
    .catch((err) => {
      console.error('Subscription maintenance failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { runMaintenance };
