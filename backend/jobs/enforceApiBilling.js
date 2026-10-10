const { enforceOverdue } = require('../services/billingService');
const { sendSubscriptionReminderEmail } = require('../services/emailService');

const GREETING = 'SemaCheck billing';

console.log('[enforce-api-billing] Running daily overdue + suspension check...');

const result = await enforceOverdue();
console.log(`[enforce-api-billing] past_due: ${result.pastDue}, suspended: ${result.suspended}.`);

console.log('[enforce-api-billing] Done.');
