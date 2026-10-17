const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verdictMapper, THRESHOLDS, VERDICT_LABELS } = require('../services/verdictMapper');

function signals(over = {}) {
  return {
    scamVotes: 0,
    legitVotes: 0,
    cbkMatch: false,
    internationalScamScore: 0,
    externalBreachScore: 0,
    hasGovernmentScamHit: false,
    externalAvailable: false,
    hasDispute: false,
    ...over,
  };
}

test('reports linking the subject to scams -> reported', () => {
  const out = verdictMapper(signals({ scamVotes: 3, legitVotes: 0 }));
  assert.equal(out.verdict, 'reported');
  assert.ok(out.reasons.some((r) => r.code === 'reported'));
});

test('government or regulator mention -> reported', () => {
  const out = verdictMapper(signals({ hasGovernmentScamHit: true }));
  assert.equal(out.verdict, 'reported');
  assert.ok(out.reasons.some((r) => r.code === 'government_hit'));
});

test('registry match with no adverse signal -> registered', () => {
  const out = verdictMapper(signals({ cbkMatch: true }));
  assert.equal(out.verdict, 'registered');
  assert.ok(out.reasons.some((r) => r.code === 'cbk_match'));
});

test('unverified subject with no signals -> unverified', () => {
  const out = verdictMapper(signals({}));
  assert.equal(out.verdict, 'unverified');
  assert.ok(out.reasons.some((r) => r.code === 'unverified'));
});

test('open dispute caps a reported subject at caution with disputed reason', () => {
  const out = verdictMapper(signals({ scamVotes: 3, legitVotes: 0, hasDispute: true }));
  assert.equal(out.verdict, 'caution');
  assert.ok(out.reasons.some((r) => r.code === 'disputed'));
});

test('government flag overrides the dispute cap', () => {
  const out = verdictMapper(signals({ hasGovernmentScamHit: true, hasDispute: true }));
  assert.equal(out.verdict, 'reported');
});

test('dispute subtracts 15 from confidence', () => {
  const plain = verdictMapper(signals({ externalAvailable: true, externalBreachScore: 1 }));
  const disputed = verdictMapper(signals({ externalAvailable: true, externalBreachScore: 1, hasDispute: true }));
  assert.equal(plain.verdict, 'caution');
  assert.equal(disputed.verdict, 'caution');
  assert.equal(disputed.confidence, plain.confidence - 15);
});

test('verdict vocabulary matches the spec', () => {
  assert.deepEqual(Object.keys(VERDICT_LABELS).sort(), ['caution', 'registered', 'reported', 'unverified']);
});

test('outputs are JSON-safe and deterministic', () => {
  const input = signals({ externalAvailable: true, externalBreachScore: 2, legitVotes: 1 });
  const a = verdictMapper(input);
  const b = verdictMapper(input);
  assert.deepEqual(a, b);
  assert.deepEqual(a, JSON.parse(JSON.stringify(a)));
  assert.equal(typeof a.displayVerdict, 'string');
});

test('confidence is clamped to 0-100', () => {
  const high = verdictMapper(signals({ scamVotes: 50, externalAvailable: true, externalBreachScore: 50, hasGovernmentScamHit: true }));
  assert.ok(high.confidence <= 100);
  assert.ok(high.confidence >= 0);
  const low = verdictMapper(signals({}));
  assert.ok(low.confidence >= 0);
  assert.ok(low.confidence <= 100);
});

test('THRESHOLDS exposes tunable starting values', () => {
  assert.equal(typeof THRESHOLDS.defaultUnverified, 'number');
  assert.equal(typeof THRESHOLDS.maxBreachScore, 'number');
});
