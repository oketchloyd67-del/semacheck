// services/searchService.js
//
// Flow for every paid search:
//   1. Normalize + hash the query.
//   2. Check `searches` table for a cached hit within the freshness
//      window (default 30 days) — if found, return it instantly and
//      DON'T charge for a fresh external lookup (dedup requirement).
//   3. On a miss, gather THREE signals in parallel:
//        a. internal DB signal — past scam reports on file
//        b. the CBK licensed digital lenders registry — a real,
//           locally-cached copy of Central Bank of Kenya's official
//           list (see services/cbkRegistryService.js)
//        c. external web search — but as THREE separate Kenya-focused
//           queries, not one generic one: a general query, a query
//           restricted to Kenyan government/regulator sites, and a
//           query restricted to major Kenyan news outlets. Government
//           hits are weighted highest, news hits next, general web
//           hits lowest — so one random blog mentioning "scam" doesn't
//           carry the same weight as a Central Bank alert.
//   4. Merge all of it into a verdict + confidence score, persist it
//      (ON CONFLICT DO NOTHING keeps the unique index authoritative
//      if two requests race), and return it shaped to the tier paid.
//
// External search: uses a generic web-search API (SerpAPI / Bing Web
// Search / Google Programmable Search all work — set
// SEARCH_PROVIDER_URL + SEARCH_PROVIDER_KEY in .env). Without a key
// configured, this degrades to DB + CBK-registry signal only, and says
// so honestly rather than fabricating "internet" findings.
//
// IMPORTANT — this now makes up to 3 external search API calls per
// uncached search instead of 1, since it runs three targeted queries
// instead of one generic one. That roughly triples your search
// provider's call volume/cost for the same number of user searches —
// see the README section on this before assuming your current plan
// tier is still enough as volume grows.

const crypto = require('crypto');
const axios = require('axios');
const pool = require('../db/pool');
const { checkAgainstCbkRegistry } = require('./cbkRegistryService');

const FRESHNESS_DAYS = parseInt(process.env.SEARCH_FRESHNESS_DAYS || '30', 10);

// Kenyan government/regulator domains most likely to carry an official
// scam alert, licensing notice, or fraud warning.
const KENYA_GOV_DOMAINS = ['centralbank.go.ke', 'cma.or.ke', 'dci.go.ke', 'ca.go.ke', 'sasra.go.ke'];
// Major Kenyan news outlets that regularly cover scam/fraud stories in
// detail — a real, checkable secondary signal beyond a generic web hit.
const KENYA_NEWS_DOMAINS = ['nation.africa', 'standardmedia.co.ke', 'tuko.co.ke', 'citizen.digital', 'the-star.co.ke', 'kenyans.co.ke'];

const WEIGHT = { government: 3, news: 2, general: 1 };

function hashValue(v) {
  return crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
}

async function findCached(queryType, queryValue) {
  const hash = hashValue(queryValue);
  const { rows } = await pool.query(
    `SELECT * FROM searches
     WHERE query_type = $1 AND query_value_hash = $2
       AND last_verified_at > now() - ($3 || ' days')::interval
     LIMIT 1`,
    [queryType, hash, FRESHNESS_DAYS]
  );
  return rows[0] || null;
}

function buildSiteRestrict(domains) {
  return domains.map((d) => `site:${d}`).join(' OR ');
}

/** Normalizes the handful of response shapes real providers actually return. */
function normalizeSearchResults(data) {
  if (Array.isArray(data.organic_results)) { // SerpApi
    return data.organic_results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }
  if (data.webPages && Array.isArray(data.webPages.value)) { // Bing
    return data.webPages.value.map((r) => ({ title: r.name, link: r.url, snippet: r.snippet }));
  }
  if (Array.isArray(data.items)) { // Google Custom Search JSON API
    return data.items.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }
  return [];
}

async function runOneQuery(url, key, isSerpApi, isBing, q) {
  let response;
  if (isSerpApi) {
    // SerpApi: key goes in `api_key`, not `key`.
    response = await axios.get(url, { params: { engine: 'google', q, api_key: key, num: 10 }, timeout: 12000 });
  } else if (isBing) {
    response = await axios.get(url, { params: { q, count: 10 }, headers: { 'Ocp-Apim-Subscription-Key': key }, timeout: 12000 });
  } else {
    // Generic fallback for key-in-query providers.
    response = await axios.get(url, { params: { key, q }, timeout: 12000 });
  }
  return normalizeSearchResults(response.data);
}

/**
 * Runs three Kenya-focused searches in parallel instead of one generic
 * one, tagging every result with which tier it came from so the
 * verdict logic can weight official sources above news above general
 * web results.
 */
async function searchExternalWeb(queryType, queryValue) {
  const url = process.env.SEARCH_PROVIDER_URL;
  const key = process.env.SEARCH_PROVIDER_KEY;
  if (!url || !key) {
    return { available: false, snippets: [], note: 'External search provider not configured — verdict is based on internal database and CBK registry signal only.' };
  }

  const isSerpApi = url.includes('serpapi.com');
  const isBing = url.includes('bing.microsoft.com');

  const subject = queryType === 'job_offer'
    ? `"${queryValue}" scam OR fraud OR legit job offer`
    : `"${queryValue}" scam OR fraud OR legit Mpesa`;

  const queries = [
    { tier: 'general', q: `${subject} Kenya` },
    { tier: 'government', q: `${subject} (${buildSiteRestrict(KENYA_GOV_DOMAINS)})` },
    { tier: 'news', q: `${subject} (${buildSiteRestrict(KENYA_NEWS_DOMAINS)})` },
  ];

  const results = await Promise.allSettled(
    queries.map((qq) => runOneQuery(url, key, isSerpApi, isBing, qq.q))
  );

  const seenLinks = new Set();
  const snippets = [];
  let anySucceeded = false;
  let lastError = null;

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { lastError = r.reason; return; }
    anySucceeded = true;
    const tier = queries[i].tier;
    for (const item of r.value) {
      const link = item.link || '';
      if (link && seenLinks.has(link)) continue; // dedupe the same page appearing in more than one query
      if (link) seenLinks.add(link);
      snippets.push({ ...item, tier, weight: WEIGHT[tier] });
    }
  });

  if (!anySucceeded) {
    const detail = lastError?.response ? `HTTP ${lastError.response.status} from search provider` : (lastError?.message || 'all queries failed');
    return { available: false, snippets: [], note: `External search failed: ${detail}` };
  }

  return { available: true, snippets: snippets.slice(0, 15) };
}

async function internalDbSignal(queryType, queryValue) {
  // Looks for related past reports (same phone/paybill appearing in
  // other users' flagged searches, or repeated near-identical job text).
  const { rows } = await pool.query(
    `SELECT verdict, count(*)::int AS n FROM searches
     WHERE query_type = $1 AND query_value ILIKE $2
     GROUP BY verdict`,
    [queryType, `%${queryValue.slice(0, 40)}%`]
  );
  return rows;
}

function computeVerdict(dbSignal, external, cbkMatch) {
  const scamVotes = dbSignal.find((r) => r.verdict === 'scam')?.n || 0;
  const legitVotes = dbSignal.find((r) => r.verdict === 'legit')?.n || 0;

  const scamHits = external.snippets.filter((s) => /scam|fraud|fake|beware|report/i.test(`${s.title} ${s.snippet}`));
  const scamWeightedScore = scamHits.reduce((sum, s) => sum + s.weight, 0);
  const hasGovernmentScamHit = scamHits.some((s) => s.tier === 'government');

  // A government-source hit (a Central Bank/CMA/DCI/CA alert naming
  // this exact query) is treated as strong enough on its own to call
  // scam even with no prior internal reports — that's the whole point
  // of weighting official sources higher than a random web mention.
  if (scamVotes > legitVotes || hasGovernmentScamHit || scamWeightedScore >= 4) {
    return {
      verdict: 'scam',
      confidence: Math.min(97, 55 + scamVotes * 5 + scamWeightedScore * 5 + (hasGovernmentScamHit ? 15 : 0)),
    };
  }

  if (cbkMatch?.matched && scamWeightedScore === 0) {
    // A real match against CBK's official licensed-lender registry is
    // a genuine legitimacy signal, not just an absence of bad news.
    return { verdict: 'legit', confidence: Math.min(96, 82 + legitVotes * 3) };
  }

  if (legitVotes > 0 && scamWeightedScore === 0) {
    return { verdict: 'legit', confidence: Math.min(95, 55 + legitVotes * 8) };
  }

  if (!external.available && dbSignal.length === 0 && !cbkMatch?.matched) {
    return { verdict: 'unverified', confidence: 30 };
  }

  return { verdict: 'suspicious', confidence: Math.min(80, 45 + scamWeightedScore * 4) };
}

/** Tier controls how much of the result is unlocked (50 / 100 / 150 KES). */
function shapeForTier(result, tier) {
  const base = { verdict: result.verdict, confidence_score: result.confidence_score };
  if (tier === 50) return base;
  if (tier === 100) return { ...base, summary: result.summary };
  return { ...base, summary: result.summary, sources: result.sources_json };
}

/** Main entry point used by routes/search.js AFTER payment succeeds. */
async function performSearch({ userId, queryType, queryValue, tier, amountPaid }) {
  const cached = await findCached(queryType, queryValue);
  if (cached) {
    return { fromCache: true, result: shapeForTier(cached, tier) };
  }

  const [dbSignal, external, cbkMatch] = await Promise.all([
    internalDbSignal(queryType, queryValue),
    searchExternalWeb(queryType, queryValue),
    checkAgainstCbkRegistry(queryValue).catch(() => ({ matched: false })), // registry cache may be empty/not yet refreshed — never let this break a search
  ]);

  const { verdict, confidence } = computeVerdict(dbSignal, external, cbkMatch);

  const govHits = external.snippets.filter((s) => s.tier === 'government').length;
  const newsHits = external.snippets.filter((s) => s.tier === 'news').length;
  const generalHits = external.snippets.filter((s) => s.tier === 'general').length;

  let summary;
  if (external.available) {
    summary = `Checked against SemaCheck's report database, the CBK licensed-lender registry, and current web results (${govHits} official Kenyan government/regulator source(s), ${newsHits} Kenyan news source(s), ${generalHits} general web source(s)).`;
  } else {
    summary = `Checked against SemaCheck's report database and the CBK licensed-lender registry. ${external.note}`;
  }
  if (cbkMatch?.matched) {
    const entry = cbkMatch.entries[0];
    summary += ` Matches a CBK-licensed digital lender on file: "${entry.company_name}"${entry.date_licensed_raw ? ` (licensed ${entry.date_licensed_raw})` : ''}.`;
  }

  const hash = hashValue(queryValue);
  const { rows } = await pool.query(
    `INSERT INTO searches (user_id, query_type, query_value, query_value_hash, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (query_type, query_value_hash) DO UPDATE SET last_verified_at = now()
     RETURNING *`,
    [
      userId, queryType, queryValue, hash, verdict, confidence, summary,
      JSON.stringify({ db_signal: dbSignal, external_sources: external.snippets, cbk_registry_match: cbkMatch }),
      tier, amountPaid,
    ]
  );

  return { fromCache: false, result: shapeForTier(rows[0], tier) };
}

module.exports = { performSearch, findCached, hashValue };
