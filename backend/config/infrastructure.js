// Hosting readiness gate.
//
// A payment-triggered API cannot wait on a sleeping free-tier instance: Render
// spins a free web service down after 15 minutes without traffic and the next
// request can take about a minute to answer, which would stall a customer's
// checkout. The KES 20,000 Growth and KES 75,000 Scale plans put SemaCheck in
// the middle of money-moving flows, so those two plans stay off sale until the
// API runs on an always-on (paid) instance.
//
// The operator flips the switch by setting ALWAYS_ON_HOST=true in the Render
// environment after upgrading the web service plan — see HOSTING.md.

const ALWAYS_ON_ENV = 'ALWAYS_ON_HOST';

// Plans whose customers are in live payment paths (and so need no cold start).
const ALWAYS_ON_REQUIRED_PLANS = ['growth', 'scale'];

const BLOCKED_REASON =
  'This plan is not on sale yet. Growth and Scale customers rely on checks inside live payment flows, and this deployment still runs on hosting that sleeps when idle — a first request can take up to a minute. Upgrade the API to an always-on instance, then set ALWAYS_ON_HOST=true to open these plans.';

function isAlwaysOn() {
  return String(process.env[ALWAYS_ON_ENV] || '').trim().toLowerCase() === 'true';
}

function planRequiresAlwaysOn(code) {
  return ALWAYS_ON_REQUIRED_PLANS.includes(String(code || '').trim().toLowerCase());
}

function planBlockedByHosting(code) {
  return planRequiresAlwaysOn(code) && !isAlwaysOn();
}

function planSaleState(code) {
  if (!planRequiresAlwaysOn(code)) return { onSale: true, onSaleNote: null };
  if (isAlwaysOn()) return { onSale: true, onSaleNote: null };
  return { onSale: false, onSaleNote: BLOCKED_REASON };
}

module.exports = {
  ALWAYS_ON_ENV,
  ALWAYS_ON_REQUIRED_PLANS,
  BLOCKED_REASON,
  isAlwaysOn,
  planRequiresAlwaysOn,
  planBlockedByHosting,
  planSaleState,
};
