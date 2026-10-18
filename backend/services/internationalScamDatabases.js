const axios = require('axios');
const pool = require('../db/pool');

const BBB_SEARCH_URL = 'https://www.bbb.org/scamtracker/search';
const FTC_DATA_URL = 'https://www.ftc.gov/reports/consumer-sentinel-network-data-book-2024';
const INTERPOL_ALERTS_URL = 'https://www.interpol.int/en/Crimes/Scams-and-fraud';

const REQUEST_TIMEOUT = 15000;

// These three are best-effort searches of public web pages, not official data
// feeds. A source is only ever reported as a match when the subject itself
// appears in a result row that page returned — see textMentions(). Reporting a
// "match" because a page merely mentions the words fraud or scam (or because a
// search box echoes the term back) is exactly the kind of overstated evidence a
// trust product must not publish.
const SOURCE_LABELS = {
  bbb: 'BBB Scam Tracker search',
  ftc: 'FTC consumer-fraud data',
  interpol: 'INTERPOL public notices',
};

function normalizeQuery(value) {
  return (value || '').trim().toLowerCase();
}

// The needles we look for inside a source's own result rows: the raw term, and
// the digits only (so "0712 345 678" still matches "254712345678").
function subjectNeedles(queryValue) {
  const raw = String(queryValue == null ? '' : queryValue).trim();
  const needles = [];
  if (raw.length >= 3) needles.push(raw.toLowerCase());
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 6 && !needles.includes(digits)) needles.push(digits);
  return needles;
}

// Visible text only — tag attributes (a search box echoing ?q=…) must not count
// as a mention of the subject.
function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function textMentions(text, needles) {
  if (!needles.length) return false;
  const plain = visibleText(text).toLowerCase();
  const collapsed = plain.replace(/[^a-z0-9]/g, '');
  return needles.some((needle) => (/^[0-9]+$/.test(needle) ? collapsed.includes(needle) : plain.includes(needle)));
}

// Keep only the rows that mention the subject; a row that merely mentions
// "scam" is not evidence about this subject.
function pickMatchedEntries(entries, needles) {
  return (entries || [])
    .filter((entry) => textMentions(`${entry.title || ''} ${entry.snippet || ''}`, needles))
    .slice(0, 5);
}

function failed(err) {
  return { matched: false, checked: false, results: [], error: err && err.message ? err.message : String(err) };
}

async function lookupBBBScamTracker(queryValue, http = axios) {
  const needles = subjectNeedles(queryValue);
  if (!needles.length) return { matched: false, checked: false, results: [], error: 'query too short' };

  try {
    const searchUrl = `${BBB_SEARCH_URL}?q=${encodeURIComponent(queryValue)}`;
    const { data: html } = await http.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    const entries = [];
    const reportPattern = /class="scam-report[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = reportPattern.exec(html)) !== null) {
      const title = visibleText(match[1]).trim();
      const snippet = visibleText(match[2]).trim();
      if (title) entries.push({ title, snippet, source: SOURCE_LABELS.bbb });
    }

    const results = pickMatchedEntries(entries, needles);
    return {
      matched: results.length > 0,
      checked: true,
      results,
      entries_seen: entries.length,
      note: results.length ? 'public scam report naming this subject' : 'no public scam report on this page names this subject',
    };
  } catch (err) {
    return failed(err);
  }
}

async function lookupFTCFraudData(queryValue, http = axios) {
  const needles = subjectNeedles(queryValue);
  if (!needles.length) return { matched: false, checked: false, results: [], error: 'query too short' };

  try {
    const searchUrl = `https://www.ftc.gov/news-events/explore-data?search_api_fulltext=${encodeURIComponent(queryValue)}`;
    const { data: html } = await http.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    const entries = [];
    const titlePattern = /<h[23][^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = titlePattern.exec(html)) !== null) {
      const link = match[1];
      const title = visibleText(match[2]).trim();
      if (title && title.length > 5) entries.push({ title, link, source: SOURCE_LABELS.ftc });
    }

    const results = pickMatchedEntries(entries, needles);
    return {
      matched: results.length > 0,
      checked: true,
      results,
      entries_seen: entries.length,
      note: results.length ? 'FTC page naming this subject' : 'no FTC page on this search names this subject',
    };
  } catch (err) {
    return failed(err);
  }
}

async function lookupInterpolAlerts(queryValue, http = axios) {
  const needles = subjectNeedles(queryValue);
  if (!needles.length) return { matched: false, checked: false, results: [], error: 'query too short' };

  try {
    const searchUrl = `https://www.interpol.int/en/How-we-work/Databases/Notices/search-conditions?notice_type=warrants&q=${encodeURIComponent(queryValue)}`;
    const { data: html } = await http.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    // INTERPOL publishes wanted-person notices, not consumer complaint records:
    // only a returned notice row naming the subject counts as a match.
    const entries = [];
    const namePattern = /class="[^"]*notice[^"]*"[^>]*>[\s\S]*?<(?:h[23]|a)[^>]*>([\s\S]*?)<\/(?:h[23]|a)>/gi;
    let match;
    while ((match = namePattern.exec(html)) !== null) {
      const name = visibleText(match[1]).trim();
      if (name && name.length > 2) entries.push({ title: name, source: SOURCE_LABELS.interpol });
    }

    const results = pickMatchedEntries(entries, needles);
    return {
      matched: results.length > 0,
      checked: true,
      results,
      entries_seen: entries.length,
      note: results.length ? 'INTERPOL public notice naming this subject' : 'no INTERPOL public notice names this subject',
    };
  } catch (err) {
    return failed(err);
  }
}

async function lookupAllInternationalDatabases(queryValue, queryType, http = axios) {
  const [bbb, ftc, interpol] = await Promise.allSettled([
    lookupBBBScamTracker(queryValue, http),
    lookupFTCFraudData(queryValue, http),
    lookupInterpolAlerts(queryValue, http),
  ]);

  const bbbResult = bbb.status === 'fulfilled' ? bbb.value : failed(bbb.reason);
  const ftcResult = ftc.status === 'fulfilled' ? ftc.value : failed(ftc.reason);
  const interpolResult = interpol.status === 'fulfilled' ? interpol.value : failed(interpol.reason);

  const allMatched = bbbResult.matched || ftcResult.matched || interpolResult.matched;
  const totalResults = bbbResult.results.length + ftcResult.results.length + interpolResult.results.length;
  const checkedSources = [bbbResult, ftcResult, interpolResult].filter((r) => r.checked).length;

  return {
    matched: allMatched,
    totalResults,
    // How many of the three public pages actually answered. When it is zero, no
    // cross-referencing happened and no result may be claimed from them.
    checkedSources,
    allChecked: checkedSources === 3,
    bbb: bbbResult,
    ftc: ftcResult,
    interpol: interpolResult,
  };
}

// Human-readable names of the sources that actually matched, for use in the
// summary string. Never lists a source that did not match.
function matchedSourceNames(result) {
  if (!result) return [];
  const names = [];
  if (result.bbb && result.bbb.matched) names.push(SOURCE_LABELS.bbb);
  if (result.ftc && result.ftc.matched) names.push(SOURCE_LABELS.ftc);
  if (result.interpol && result.interpol.matched) names.push(SOURCE_LABELS.interpol);
  return names;
}

async function cacheInternationalLookup(queryType, queryValue, lookupResult) {
  const hash = require('crypto').createHash('sha256').update(queryValue.trim().toLowerCase()).digest('hex');
  try {
    await pool.query(
      `INSERT INTO international_scam_lookups (query_type, query_value, query_value_hash, matched, bbb_results, ftc_results, interpol_results)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (query_type, query_value_hash) DO UPDATE SET
         matched = EXCLUDED.matched, bbb_results = EXCLUDED.bbb_results,
         ftc_results = EXCLUDED.ftc_results, interpol_results = EXCLUDED.interpol_results,
         last_checked_at = now()`,
      [queryType, queryValue, hash, lookupResult.matched,
       JSON.stringify(lookupResult.bbb), JSON.stringify(lookupResult.ftc), JSON.stringify(lookupResult.interpol)]
    );
  } catch (err) {
    console.error('Failed to cache international lookup:', err.message);
  }
}

async function getCachedInternationalLookup(queryType, queryValue) {
  const hash = require('crypto').createHash('sha256').update(queryValue.trim().toLowerCase()).digest('hex');
  try {
    const { rows } = await pool.query(
      `SELECT * FROM international_scam_lookups
       WHERE query_type = $1 AND query_value_hash = $2
         AND last_checked_at > now() - interval '7 days'
       LIMIT 1`,
      [queryType, hash]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function internationalLookupStatus() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total, count(*) filter (where matched)::int AS matched, max(last_checked_at) AS last_checked FROM international_scam_lookups`
  );
  return rows[0];
}

module.exports = {
  SOURCE_LABELS,
  subjectNeedles,
  textMentions,
  pickMatchedEntries,
  matchedSourceNames,
  lookupBBBScamTracker,
  lookupFTCFraudData,
  lookupInterpolAlerts,
  lookupAllInternationalDatabases,
  cacheInternationalLookup,
  getCachedInternationalLookup,
  internationalLookupStatus,
};
