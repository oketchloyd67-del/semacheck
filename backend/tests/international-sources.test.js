// The home page used to claim verdicts were powered by FTC, BBB and Interpol
// databases. It turned out the code did look at those pages for Worldwide
// checks — but reported a "match" for essentially every query, because a page
// merely containing the words scam/fraud, or echoing the search term back in a
// form field, was treated as evidence. That is overstated evidence in a trust
// product, so the lookups must fail closed: a source is a match only when the
// subject itself appears in a result row that page returned.
const test = require('node:test');
const assert = require('node:assert/strict');

// Hermetic: the module only touches the DB from the cache helpers, which these
// tests never call.
const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};

const sources = require('../services/internationalScamDatabases');

function stubHttp(html) {
  return { get: async () => ({ data: html }) };
}

test('subject needles cover the raw term and a digits-only form', () => {
  assert.deepEqual(sources.subjectNeedles('0712 345 678'), ['0712 345 678', '0712345678']);
  assert.deepEqual(sources.subjectNeedles('Acme Traders Ltd'), ['acme traders ltd']);
  assert.deepEqual(sources.subjectNeedles('ab'), []);
});

test('a page that only echoes the query in a form field is not a mention', () => {
  const echoed = '<form><input name="q" value="0712345678"></form>';
  assert.equal(sources.textMentions(echoed, sources.subjectNeedles('0712345678')), false);
  assert.equal(sources.textMentions('<p>Report for 0712 345 678 filed</p>', sources.subjectNeedles('0712 345 678')), true);
});

test('BBB: an unrelated scam report is not a match, a named one is', async () => {
  const unrelated = '<div class="scam-report"><h3>Fake Landlord</h3><p>Scam deposit fraud beware report</p></div>';
  const named =
    '<div class="scam-report"><h3>Fake Paybill 1234567</h3><p>Reported scam collecting deposits</p></div>' +
    unrelated;

  const miss = await sources.lookupBBBScamTracker('1234567', stubHttp(unrelated));
  assert.equal(miss.matched, false, 'scam keywords alone must not count as a match');
  assert.equal(miss.checked, true);
  assert.deepEqual(miss.results, []);

  const hit = await sources.lookupBBBScamTracker('1234567', stubHttp(named));
  assert.equal(hit.matched, true);
  assert.equal(hit.results.length, 1);
  assert.match(hit.results[0].title, /1234567/);
});

test('INTERPOL: a page full of fraud wording with no named notice is not a match', async () => {
  const noNotice = '<main><h1>Scams and fraud</h1><p>INTERPOL fights fraud and scam crime worldwide.</p></main>';
  const notice = '<div class="notice-item"><a href="/notices/1">OKECH LOYD, wanted</a></div>';

  const miss = await sources.lookupInterpolAlerts('Okech Loyd', stubHttp(noNotice));
  assert.equal(miss.matched, false);
  assert.equal(miss.checked, true);

  const hit = await sources.lookupInterpolAlerts('Okech Loyd', stubHttp(notice));
  assert.equal(hit.matched, true);
  assert.equal(hit.results.length, 1);
});

test('FTC: keyword-bearing page with no row naming the subject is not a match', async () => {
  const generic = '<h2><a href="/x">Fraud data book</a></h2>';
  const miss = await sources.lookupFTCFraudData('Acme Traders Ltd', stubHttp(generic));
  assert.equal(miss.matched, false);

  const named = '<h2><a href="/y">Case: Acme Traders Ltd impersonation</a></h2>';
  const hit = await sources.lookupFTCFraudData('Acme Traders Ltd', stubHttp(named));
  assert.equal(hit.matched, true);
});

test('a lookup that errors is reported as not checked, never as clean', async () => {
  const boom = { get: async () => { throw new Error('ECONNRESET'); } };
  const result = await sources.lookupBBBScamTracker('1234567', boom);
  assert.equal(result.matched, false);
  assert.equal(result.checked, false);
  assert.match(result.error, /ECONNRESET/);

  const all = await sources.lookupAllInternationalDatabases('1234567', 'paybill', boom);
  assert.equal(all.matched, false);
  assert.equal(all.checkedSources, 0);
  assert.equal(all.allChecked, false);
  assert.deepEqual(sources.matchedSourceNames(all), []);
});

test('matchedSourceNames lists only sources that matched', () => {
  const partial = {
    bbb: { matched: true },
    ftc: { matched: false },
    interpol: { matched: true },
  };
  assert.deepEqual(sources.matchedSourceNames(partial), [
    sources.SOURCE_LABELS.bbb,
    sources.SOURCE_LABELS.interpol,
  ]);
  assert.deepEqual(sources.matchedSourceNames(null), []);
});
