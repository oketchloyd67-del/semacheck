const axios = require('axios');
const pool = require('../db/pool');

const BBB_SEARCH_URL = 'https://www.bbb.org/scamtracker/search';
const FTC_DATA_URL = 'https://www.ftc.gov/reports/consumer-sentinel-network-data-book-2024';
const INTERPOL_ALERTS_URL = 'https://www.interpol.int/en/Crimes/Scams-and-fraud';

const REQUEST_TIMEOUT = 15000;

function normalizeQuery(value) {
  return (value || '').trim().toLowerCase();
}

async function lookupBBBScamTracker(queryValue) {
  const normalized = normalizeQuery(queryValue);
  if (normalized.length < 3) return { matched: false, results: [] };

  try {
    const searchUrl = `${BBB_SEARCH_URL}?q=${encodeURIComponent(queryValue)}`;
    const { data: html } = await axios.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    const results = [];
    const reportPattern = /class="scam-report[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = reportPattern.exec(html)) !== null) {
      const title = match[1].replace(/<[^>]+>/g, '').trim();
      const snippet = match[2].replace(/<[^>]+>/g, '').trim();
      if (title) results.push({ title, snippet, source: 'BBB Scam Tracker' });
    }

    const hasScamMention = /scam|fraud|fake|beware|report/i.test(html) &&
      (html.toLowerCase().includes(normalized) || results.length > 0);

    return { matched: hasScamMention, results: results.slice(0, 5) };
  } catch (err) {
    return { matched: false, results: [], error: err.message };
  }
}

async function lookupFTCFraudData(queryValue) {
  const normalized = normalizeQuery(queryValue);
  if (normalized.length < 3) return { matched: false, results: [] };

  try {
    const searchUrl = `https://www.ftc.gov/news-events/explore-data?search_api_fulltext=${encodeURIComponent(queryValue)}`;
    const { data: html } = await axios.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    const results = [];
    const titlePattern = /<h[23][^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = titlePattern.exec(html)) !== null) {
      const link = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (title && title.length > 5) results.push({ title, link, source: 'FTC' });
    }

    const hasFraudMention = /fraud|scam|deceptive|fake/i.test(html) && results.length > 0;

    return { matched: hasFraudMention, results: results.slice(0, 5) };
  } catch (err) {
    return { matched: false, results: [], error: err.message };
  }
}

async function lookupInterpolAlerts(queryValue) {
  const normalized = normalizeQuery(queryValue);
  if (normalized.length < 3) return { matched: false, results: [] };

  try {
    const searchUrl = `https://www.interpol.int/en/How-we-work/Databases/Notices/search-conditions?notice_type=warrants&q=${encodeURIComponent(queryValue)}`;
    const { data: html } = await axios.get(searchUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'SemaCheck/1.0 (scam-verification)' },
    });

    const results = [];
    const namePattern = /class="[^"]*notice[^"]*"[^>]*>[\s\S]*?<(?:h[23]|a)[^>]*>([\s\S]*?)<\/(?:h[23]|a)>/gi;
    let match;
    while ((match = namePattern.exec(html)) !== null) {
      const name = match[1].replace(/<[^>]+>/g, '').trim();
      if (name && name.length > 2) results.push({ title: name, source: 'INTERPOL' });
    }

    const hasMention = results.length > 0 || /fraud|scam/i.test(html);

    return { matched: hasMention, results: results.slice(0, 5) };
  } catch (err) {
    return { matched: false, results: [], error: err.message };
  }
}

async function lookupAllInternationalDatabases(queryValue, queryType) {
  const [bbb, ftc, interpol] = await Promise.allSettled([
    lookupBBBScamTracker(queryValue),
    lookupFTCFraudData(queryValue),
    lookupInterpolAlerts(queryValue),
  ]);

  const bbbResult = bbb.status === 'fulfilled' ? bbb.value : { matched: false, results: [], error: bbb.reason?.message };
  const ftcResult = ftc.status === 'fulfilled' ? ftc.value : { matched: false, results: [], error: ftc.reason?.message };
  const interpolResult = interpol.status === 'fulfilled' ? interpol.value : { matched: false, results: [], error: interpol.reason?.message };

  const allMatched = bbbResult.matched || ftcResult.matched || interpolResult.matched;
  const totalResults = bbbResult.results.length + ftcResult.results.length + interpolResult.results.length;

  return {
    matched: allMatched,
    totalResults,
    bbb: bbbResult,
    ftc: ftcResult,
    interpol: interpolResult,
  };
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
  lookupBBBScamTracker,
  lookupFTCFraudData,
  lookupInterpolAlerts,
  lookupAllInternationalDatabases,
  cacheInternationalLookup,
  getCachedInternationalLookup,
  internationalLookupStatus,
};
