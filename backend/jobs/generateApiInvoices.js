const { generateMonthlyInvoices } = require('../services/billingService');
const { sendSubscriptionReminderEmail } = require('../services/emailService');

const period = String(new Date().toISOString().slice(0, 7));
console.log(`[api-invoices] Generating invoices for period ${period}...`);

const issued = await generateMonthlyInvoices(period);
if (!issued.length) {
  console.log('[api-invoices] No new invoices issued this month.');
} else {
  for (const inv of issued) {
    console.log(`[api-invoices] Invoice ${inv.invoiceId} for account ${inv.accountId} — KES ${inv.amount}, due ${inv.dueOn}.`);
    try {
      await sendSubscriptionReminderEmail({
        toEmail: process.env.MANAGEMENT_EMAIL || 'claimsagency254@gmail.com',
        fullName: 'Customer',
        daysRemaining: 7,
        expiresAt: new Date(inv.dueOn).toISOString(),
      });
    } catch (e) {
      console.error('[api-invoices] Email failed:', e.message);
    }
  }
}
console.log('[api-invoices] Done.');
