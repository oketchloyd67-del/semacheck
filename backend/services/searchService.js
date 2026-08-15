// services/searchService.js
//
// Flow for every paid search:
//   1. Normalize + hash the query.
//   2. Check `searches` table for a cached hit within the freshness
//      window (default 30 days) — if found, return it instantly and
//      DON'T charge for a fresh external lookup (dedup requirement).
//   3. On a miss, query internal DB signal (past scam reports, known
//      Paybill registry if the platform maintains one) AND an external
//      web-search provider to see what the wider internet says about
//      that number/job posting.
//   4. Merge both into a verdict + confidence score, persist it
//      (ON CONFLICT DO NOTHING keeps the unique index authoritative
//      if two requests race), and return it shaped to the tier paid.
//
// External search: uses a generic web-search API (SerpAPI / Google
// Programmable Search / Bing Web Search all work — set
// SEARCH_PROVIDER_URL + SEARCH_PROVIDER_KEY in .env). Without a key
// configured, this degrades to DB-only results and says so honestly
// rather than fabricating "internet" findings.

const crypto = require('crypto');
const axios = require('axios');
const pool = require('../db/pool');

const FRESHNESS_DAYS = parseInt(process.env.SEARCH_FRESHNESS_DAYS || '30', 10);

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

async function searchExternalWeb(queryType, queryValue) {
  const url = process.env.SEARCH_PROVIDER_URL;
  const key = process.env.SEARCH_PROVIDER_KEY;
  if (!url || !key) {
    return { available: false, snippets: [], note: 'External search provider not configured — verdict is based on internal database signal only.' };
  }
  try {
    const q = queryType === 'job_offer'
      ? `"${queryValue}" scam OR fraud OR legit job offer Kenya`
      : `"${queryValue}" scam OR fraud OR legit Kenya Mpesa`;
    const { data } = await axios.get(url, { params: { key, q }, timeout: 10000 });
    const snippets = (data.results || data.items || []).slice(0, 5).map((r) => ({
      title: r.title, link: r.link || r.url, snippet: r.snippet || r.description,
    }));
    return { available: true, snippets };
  } catch (err) {
    return { available: false, snippets: [], note: `External search failed: ${err.message}` };
  }
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

function computeVerdict(dbSignal, external) {
  const scamVotes = dbSignal.find((r) => r.verdict === 'scam')?.n || 0;
  const legitVotes = dbSignal.find((r) => r.verdict === 'legit')?.n || 0;
  const scamKeywordHit = external.snippets.some((s) =>
    /scam|fraud|fake|beware|report/i.test(`${s.title} ${s.snippet}`)
  );

  if (scamVotes > legitVotes || (scamKeywordHit && legitVotes === 0)) {
    return { verdict: 'scam', confidence: Math.min(95, 60 + scamVotes * 5 + (scamKeywordHit ? 15 : 0)) };
  }
  if (legitVotes > 0 && !scamKeywordHit) {
    return { verdict: 'legit', confidence: Math.min(95, 55 + legitVotes * 8) };
  }
  if (!external.available && dbSignal.length === 0) {
    return { verdict: 'unverified', confidence: 30 };
  }
  return { verdict: 'suspicious', confidence: 50 };
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

  const [dbSignal, external] = await Promise.all([
    internalDbSignal(queryType, queryValue),
    searchExternalWeb(queryType, queryValue),
  ]);

  const { verdict, confidence } = computeVerdict(dbSignal, external);
  const summary = external.available
    ? `Checked against SemaCheck's report database and current web results. ${external.snippets.length} related web mentions reviewed.`
    : `Checked against SemaCheck's report database. ${external.note}`;

  const hash = hashValue(queryValue);
  const { rows } = await pool.query(
    `INSERT INTO searches (user_id, query_type, query_value, query_value_hash, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (query_type, query_value_hash) DO UPDATE SET last_verified_at = now()
     RETURNING *`,
    [userId, queryType, queryValue, hash, verdict, confidence, summary, JSON.stringify({ db_signal: dbSignal, external_sources: external.snippets }), tier, amountPaid]
  );

  return { fromCache: false, result: shapeForTier(rows[0], tier) };
}

module.exports = { performSearch, findCached, hashValue };
