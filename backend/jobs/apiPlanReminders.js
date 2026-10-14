// API plan renewal reminders.
//
// Paid API plans renew monthly (see billingService.generateInvoices). This job
// emails each active paid-plan account owner within 3 days of plan_renews_on,
// at most once every 2 days per account (last_plan_reminder_at dedupe).
//
// A separate billing job (enforceApiBilling) moves past-due accounts to a
// suspended state after the 7-day grace period documented in the API terms.
require('dotenv').config();
const pool = require('../db/pool');
const { sendApiPlanReminderEmail } = require('../services/emailService');

async function run() {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_name, a.plan_renews_on, u.email, u.full_name, p.name AS plan_name
     FROM api_accounts a
     JOIN users u ON u.id = a.user_id
     JOIN api_plans p ON p.id = a.plan_id
     WHERE a.status = 'active'
       AND p.monthly_price_kes > 0
       AND a.plan_renews_on IS NOT NULL
       AND a.plan_renews_on <= (now() + interval '3 days')::date
       AND a.plan_renews_on >= now()::date
       AND (a.last_plan_reminder_at IS NULL OR a.last_plan_reminder_at <= now() - interval '2 days')`
  );

  let sent = 0;
  for (const row of rows) {
    try {
      await sendApiPlanReminderEmail({
        toEmail: row.email,
        fullName: row.full_name,
        companyName: row.company_name,
        planName: row.plan_name,
        renewsOn: row.plan_renews_on,
      });
      await pool.query(`UPDATE api_accounts SET last_plan_reminder_at = now() WHERE id = $1`, [row.id]);
      sent++;
    } catch (err) {
      // Missing BREVO_API_KEY or a provider outage must never crash the job.
      console.warn(`API plan reminder failed for account ${row.id}: ${err.message}`);
    }
  }
  if (rows.length) console.log(`API plan reminders: ${sent}/${rows.length} sent.`);
  return sent;
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('API plan reminders failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { run };
