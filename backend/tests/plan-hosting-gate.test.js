// Growth (KES 20,000/mo) and Scale (KES 75,000/mo) customers call the API inside
// live payment flows, and free hosting sleeps — a first request can take about a
// minute. Until the API runs on an always-on instance those two plans must not be
// purchasable: the API answers 503 infrastructure_not_ready instead of starting an
// M-Pesa charge. These tests pin the switch so a later refactor cannot quietly
// remove it.
const test = require('node:test');
const assert = require('node:assert/strict');

const infra = require('../config/infrastructure');

function withAlwaysOn(value, fn) {
  const original = process.env[infra.ALWAYS_ON_ENV];
  if (value === undefined) delete process.env[infra.ALWAYS_ON_ENV];
  else process.env[infra.ALWAYS_ON_ENV] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[infra.ALWAYS_ON_ENV];
    else process.env[infra.ALWAYS_ON_ENV] = original;
  }
}

test('freemium defaults block Growth and Scale, and leave Free and Starter alone', () => {
  withAlwaysOn(undefined, () => {
    assert.equal(infra.isAlwaysOn(), false);
    assert.equal(infra.planBlockedByHosting('growth'), true);
    assert.equal(infra.planBlockedByHosting('scale'), true);
    assert.equal(infra.planBlockedByHosting('starter'), false);
    assert.equal(infra.planBlockedByHosting('free'), false);
    assert.equal(infra.planBlockedByHosting(''), false);
    assert.equal(infra.planBlockedByHosting(undefined), false);
  });
});

test('the block is lifted only by an explicit true', () => {
  withAlwaysOn('true', () => {
    assert.equal(infra.planBlockedByHosting('growth'), false);
    assert.deepEqual(infra.planSaleState('scale'), { onSale: true, onSaleNote: null });
  });
  // "true" in any letter case opens the plans (env vars get typed by hand).
  for (const value of ['TRUE', 'True']) {
    withAlwaysOn(value, () => {
      assert.equal(infra.isAlwaysOn(), true, `${JSON.stringify(value)} is still true`);
    });
  }
  // Anything that is not a form of "true" keeps the interlock on — a typo must
  // fail closed rather than silently open a plan the host cannot serve.
  for (const value of ['false', '1', 'yes', 'on', '']) {
    withAlwaysOn(value, () => {
      assert.equal(infra.isAlwaysOn(), false, `${JSON.stringify(value)} must not open the plans`);
      assert.equal(infra.planBlockedByHosting('growth'), true);
    });
  }
  withAlwaysOn(' TRUE ', () => {
    assert.equal(infra.isAlwaysOn(), true, 'surrounding whitespace is tolerated');
  });
});

test('a withheld plan carries the reason a customer can act on', () => {
  withAlwaysOn('false', () => {
    const sale = infra.planSaleState('growth');
    assert.equal(sale.onSale, false);
    assert.match(sale.onSaleNote, /always-on/);
    assert.match(sale.onSaleNote, /ALWAYS_ON_HOST/);
    // Starter stays purchasable, so the API can still be sold while the
    // always-on upgrade is pending.
    assert.equal(infra.planSaleState('starter').onSale, true);
  });
});
