'use strict';
// backend/jobs/sendApiReminders.js — run hourly (safe to run more often: each
// step is sent once per billing cycle thanks to api_reminders_sent).
//
// Schedule (see services/reminderSchedule.js): 14, 7, 3 and 1 days before the
// renewal date, on the due date, then 3 and 6 days into the 7-day grace
// period, then the suspension notice. After downtime only the latest due step
// is sent, never a burst of old ones.
require('dotenv').config();
const pool = require('./../db/pool');
const { nextReminder } = require('../services/reminderSchedule');
const { sendApiPlanReminderEmail } = require('../services/emailService');

const ACCOUNTS_SQL = `
SELECT a.id, a.company_name, a.plan_renews_on, a.status, u.email, u.full_name, p.name AS plan_name
FROM api_accounts a
JOIN users u ON u.id = a.user_id
JOIN api_plans p ON p.id = a.plan_id
WHERE a.plan_renews_on IS NOT NULL
  AND a.status IN ('active', 'past_due', 'suspended')
  AND p.monthly_price_kes > 0
  AND a.plan_renews_on BETWEEN CURRENT_DATE - 10 AND CURRENT_DATE + 15`;

async function sendApiReminders(pool, sendMail, now = new Date()) {
  const { rows } = await pool.query(ACCOUNTS_SQL);
  let sent = 0;
  for (const acct of rows) {
    const cycleEnd = new Date(acct.plan_renews_on).toISOString().slice(0, 10);
    const done = await pool.query(
      'SELECT step FROM api_reminders_sent WHERE account_id = $1 AND cycle_end = $2',
      [acct.id, cycleEnd]
    );
    const sentCodes = new Set(done.rows.map((r) => r.step));
    const { due, skipped } = nextReminder(acct.plan_renews_on, now, sentCodes);
    if (!due) continue;

    // Claim every reached step first, so a second server or a re-run can never
    // send it twice. The latest step decides whether this run emails anyone.
    let claimedDue = false;
    for (const s of [...skipped, due]) {
      const ins = await pool.query(
        `INSERT INTO api_reminders_sent (account_id, cycle_end, step)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [acct.id, cycleEnd, s.code]
      );
      if (s.code === due.code) claimedDue = ins.rowCount === 1;
    }
    if (!claimedDue) continue;   // another worker already sent this step

    try {
      await sendMail({
        toEmail: acct.email,
        fullName: acct.full_name,
        companyName: acct.company_name,
        planName: acct.plan_name,
        renewsOn: acct.plan_renews_on,
        step: due,
      });
    } catch (err) {
      // A provider outage must not crash the job. Release the claim so the next
      // run retries this step instead of silently skipping it.
      await pool.query(
        'DELETE FROM api_reminders_sent WHERE account_id = $1 AND cycle_end = $2 AND step = $3',
        [acct.id, cycleEnd, due.code]
      );
      console.warn(`API reminder ${due.code} failed for account ${acct.id}: ${err.message}`);
      continue;
    }
    sent += 1;
  }
  if (rows.length) console.log(`API reminders: ${sent}/${rows.length} sent.`);
  return sent;
}

async function run(now) {
  return sendApiReminders(pool, sendApiPlanReminderEmail, now);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('API reminders failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { run, sendApiReminders, ACCOUNTS_SQL };
