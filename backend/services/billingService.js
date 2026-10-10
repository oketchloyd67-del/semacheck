const pool = require('../db/pool');
const { sendSubscriptionReminderEmail } = require('./emailService');
const { sendOtpEmail } = require('./emailService');

const INVOICE_DUE_DAYS = parseInt(process.env.API_INVOICE_DUE_DAYS || '7', 10);
const GRACE_DAYS = parseInt(process.env.API_GRACE_DAYS || '5', 10);
const REMINDER_DAYS = [0, 5, 3, 1];

async function generateMonthlyInvoices(period) {
  const { rows: accounts } = await pool.query(
    `SELECT a.id AS account_id, a.plan_id, p.monthly_price_kes, a.status
     FROM api_accounts a JOIN api_plans p ON p.id = a.plan_id
     WHERE a.status IN ('active', 'past_due') AND p.is_active = TRUE`
  );
  const now = new Date();
  const created = new Date(now.getTime());
  created.setUTCDate(created.getUTCDate() + 1);

  const issued = [];
  for (const acc of accounts) {
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM api_invoices WHERE account_id=$1 AND period=$2`,
      [acc.account_id, period]
    );
    if (existing.length) continue;

    const invoiceId = await pool.query(
      `INSERT INTO api_invoices (account_id, plan_id, period, amount_kes, status, due_on, payment_id)
       VALUES ($1,$2,$3,$4,'unpaid',$5,$6) RETURNING id`,
      [acc.account_id, acc.plan_id, period, acc.monthly_price_kes, created, null]
    );
    issued.push({ accountId: acc.account_id, invoiceId: invoiceId.rows[0].id, amount: acc.monthly_price_kes, dueOn: created.toISOString().slice(0, 10) });
  }
  return issued;
}

async function markInvoicePaid(invoiceId, paymentId) {
  const { rows } = await pool.query(
    `UPDATE api_invoices SET status='paid', payment_id=$2, paid_at=now() WHERE id=$1 RETURNING *`,
    [invoiceId, paymentId]
  );
  if (!rows[0]) throw new Error('Invoice not found.');
  return rows[0];
}

async function enforceOverdue() {
  const now = new Date();
  const pastDue = new Date(now.getTime() - GRACE_DAYS * 86400000);
  const { rows: pastDueRows } = await pool.query(
    `SELECT a.id AS account_id, a.plan_id, p.monthly_price_kes, a.status, a.plan_renews_on FROM api_accounts a
     JOIN api_plans p ON p.id = a.plan_id
     WHERE a.status='past_due' AND a.plan_renews_on <= $1`
  );
  for (const r of pastDueRows) {
    await pool.query(
      `UPDATE api_accounts SET status='suspended', plan_renews_on=now() WHERE id=$1`,
      [r.account_id]
    );
  }
  const { rows: activeWithInvoices } = await pool.query(
    `SELECT a.id AS account_id, a.plan_id, p.monthly_price_kes, a.status, a.plan_renews_on
     FROM api_accounts a JOIN api_plans p ON p.id = a.plan_id
     WHERE a.status='active' AND p.is_active = FALSE`
  );
  for (const r of activeWithInvoices) {
    await pool.query(
      `UPDATE api_accounts SET status='suspended' WHERE id=$1`,
      [r.account_id]
    );
  }
  return { pastDue: pastDueRows.length, suspended: pastDueRows.length };
}

async function changePlan(accountId, planCode) {
  const { rows: planRows } = await pool.query(
    `SELECT id, monthly_price_kes, monthly_quota, rate_limit_per_min, webhooks_enabled, batch_enabled FROM api_plans WHERE code=$1 AND is_active=TRUE`,
    [planCode]
  );
  if (!planRows[0]) throw new Error('Plan not found or inactive.');
  const plan = planRows[0];

  const now = new Date();
  const period = String(now.toISOString().slice(0, 7));
  const today = new Date(now.getTime());
  today.setUTCDate(today.getUTCDate() + 1);

  await pool.query(
    `UPDATE api_accounts SET plan_id=$1, plan_renews_on=$2, status='active' WHERE id=$3`,
    [plan.id, today.toISOString().slice(0, 10), accountId]
  );

  const { rows: existing } = await pool.query(
    `SELECT 1 FROM api_invoices WHERE account_id=$1 AND period=$2`,
    [accountId, period]
  );
  if (!existing.length) {
    await pool.query(
      `INSERT INTO api_invoices (account_id, plan_id, period, amount_kes, status, due_on, payment_id)
       VALUES ($1,$2,$3,$4,'unpaid',$5,$6)`,
      [accountId, plan.id, period, plan.monthly_price_kes, today, null]
    );
  }
  return plan;
}

module.exports = { generateMonthlyInvoices, markInvoicePaid, enforceOverdue, changePlan, INVOICE_DUE_DAYS, GRACE_DAYS };
