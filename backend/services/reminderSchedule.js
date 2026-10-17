'use strict';
// backend/services/reminderSchedule.js
// Which renewal reminder is due for an account right now? Pure function, easy to test.
// Offsets are days relative to the renewal date (plan_renews_on). Negative = before.
const GRACE_DAYS = 7;
const STEPS = [
  { code: 'T-14', offset: -14, subject: 'Your SemaCheck API plan renews in 14 days' },
  { code: 'T-7', offset: -7, subject: 'Your SemaCheck API plan renews in 7 days' },
  { code: 'T-3', offset: -3, subject: 'Your SemaCheck API plan renews in 3 days' },
  { code: 'T-1', offset: -1, subject: 'Your SemaCheck API plan renews tomorrow' },
  { code: 'T0', offset: 0, subject: 'Your SemaCheck API plan is due today' },
  { code: 'G+3', offset: 3, subject: 'Payment overdue: live API keys will stop in 4 days' },
  { code: 'G+6', offset: 6, subject: 'Final notice: live API keys stop tomorrow' },
  { code: 'G+7', offset: GRACE_DAYS, subject: 'Your SemaCheck live API keys are now suspended' },
];

const DAY = 86400000;
const startOfDayUTC = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// Returns { due: step | null, skipped: [steps] }
// "due" is the LATEST step already reached and not yet sent. Earlier unsent steps are "skipped"
// (so after downtime a customer gets one email, not five).
function nextReminder(renewsOn, now, sentCodes) {
  const days = Math.floor((startOfDayUTC(now) - startOfDayUTC(new Date(renewsOn))) / DAY); // negative before renewal
  const reached = STEPS.filter((s) => days >= s.offset && !sentCodes.has(s.code));
  if (reached.length === 0) return { due: null, skipped: [] };
  const due = reached[reached.length - 1];
  return { due, skipped: reached.slice(0, -1) };
}

// Days until the renewal date; negative once it is past. Used by the dashboard
// countdown and by the reminder copy.
function daysUntilRenewal(renewsOn, now) {
  return Math.floor((startOfDayUTC(new Date(renewsOn)) - startOfDayUTC(now)) / DAY);
}

module.exports = { STEPS, GRACE_DAYS, nextReminder, daysUntilRenewal };
