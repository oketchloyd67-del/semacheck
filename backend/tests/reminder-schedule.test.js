const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STEPS, GRACE_DAYS, nextReminder, daysUntilRenewal } = require('../services/reminderSchedule');
const { sendApiReminders } = require('../jobs/sendApiReminders');

const NOW = new Date('2026-10-17T09:00:00Z');

function renewsIn(days) {
  return new Date(NOW.getTime() + days * 86400000).toISOString().slice(0, 10);
}

test('the schedule runs 14, 7, 3, 1, 0 then the grace period and suspension', () => {
  assert.deepEqual(STEPS.map((s) => s.code), ['T-14', 'T-7', 'T-3', 'T-1', 'T0', 'G+3', 'G+6', 'G+7']);
  assert.equal(GRACE_DAYS, 7);
});

test('no reminder before the 14-day mark', () => {
  assert.equal(nextReminder(renewsIn(20), NOW, new Set()).due, null);
});

test('the latest reached step is due, earlier ones are skipped', () => {
  const { due, skipped } = nextReminder(renewsIn(6), NOW, new Set());
  assert.equal(due.code, 'T-7');
  assert.deepEqual(skipped.map((s) => s.code), ['T-14']);
});

test('after downtime only the latest due step is sent, never a burst', () => {
  // Renewal was 4 days ago: T-14, T-7, T-3, T-1, T0 and G+3 are all reached.
  const { due, skipped } = nextReminder(renewsIn(-4), NOW, new Set());
  assert.equal(due.code, 'G+3');
  assert.deepEqual(skipped.map((s) => s.code), ['T-14', 'T-7', 'T-3', 'T-1', 'T0']);
});

test('sent steps are never repeated', () => {
  const sent = new Set(['T-14', 'T-7', 'T-3']);
  assert.equal(nextReminder(renewsIn(1), NOW, sent).due.code, 'T-1');
  sent.add('T-1');
  assert.equal(nextReminder(renewsIn(1), NOW, sent).due, null);
});

test('daysUntilRenewal counts forward and backward', () => {
  assert.equal(daysUntilRenewal(renewsIn(3), NOW), 3);
  assert.equal(daysUntilRenewal(renewsIn(-2), NOW), -2);
});

function fakePool(accounts, sentCodes = []) {
  const inserts = [];
  return {
    inserts,
    async query(sql, params) {
      if (/FROM api_accounts/.test(sql)) return { rows: accounts };
      if (/SELECT step FROM api_reminders_sent/.test(sql)) return { rows: sentCodes.map((step) => ({ step })) };
      if (/INSERT INTO api_reminders_sent/.test(sql)) {
        inserts.push(params[2]);
        return { rowCount: 1 };
      }
      if (/DELETE FROM api_reminders_sent/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the job sends one email for the latest step and claims the skipped ones', async () => {
  const pool = fakePool([
    { id: 1, company_name: 'Acme', plan_renews_on: renewsIn(6), status: 'active', email: 'a@example.com', full_name: 'A', plan_name: 'Starter' },
  ]);
  const mails = [];
  const sent = await sendApiReminders(pool, async (mail) => mails.push(mail), NOW);

  assert.equal(sent, 1);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].step.code, 'T-7');
  assert.deepEqual(pool.inserts, ['T-14', 'T-7']);
});

test('the job sends nothing when the due step was already sent', async () => {
  const pool = fakePool(
    [{ id: 1, company_name: 'Acme', plan_renews_on: renewsIn(6), status: 'active', email: 'a@example.com', full_name: 'A', plan_name: 'Starter' }],
    ['T-14', 'T-7']
  );
  const mails = [];
  const sent = await sendApiReminders(pool, async (mail) => mails.push(mail), NOW);
  assert.equal(sent, 0);
  assert.equal(mails.length, 0);
});

test('a failed send releases its claim so the next run retries', async () => {
  const pool = fakePool([
    { id: 1, company_name: 'Acme', plan_renews_on: renewsIn(1), status: 'active', email: 'a@example.com', full_name: 'A', plan_name: 'Starter' },
  ]);
  const sent = await sendApiReminders(pool, async () => { throw new Error('provider down'); }, NOW);
  assert.equal(sent, 0);
  assert.ok(pool.inserts.includes('T-1'));
});
