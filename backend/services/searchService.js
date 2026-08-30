const crypto = require('crypto');
const axios = require('axios');
const pool = require('../db/pool');
const { checkAgainstCbkRegistry } = require('./cbkRegistryService');
const internationalDb = require('./internationalScamDatabases');

const FRESHNESS_DAYS = parseInt(process.env.SEARCH_FRESHNESS_DAYS || '30', 10);

const KENYA_GOV_DOMAINS = ['centralbank.go.ke', 'cma.or.ke', 'dci.go.ke', 'ca.go.ke', 'sasra.go.ke'];
const KENYA_NEWS_DOMAINS = ['nation.africa', 'standardmedia.co.ke', 'tuko.co.ke', 'citizen.digital', 'the-star.co.ke', 'kenyans.co.ke'];

const INTERNATIONAL_SCAM_DOMAINS = ['ftc.gov', 'bbb.org', 'scamwatch.gov.au', 'consumer.ftc.gov', 'bbc.co.uk', 'bbc.com'];

const WEIGHT = { government: 3, news: 2, general: 1 };

const INTERNATIONAL_JOB_SCAM_PATTERNS = [
  'work permit fee', 'visa processing fee', 'upfront training cost',
  'registration fee', 'processing fee', 'deposit fee', 'activation fee',
  'guarantee fee', 'security deposit', 'orientation fee', 'uniform fee',
];

function hashValue(v) {
  return crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
}

async function findCached(queryType, queryValue, region = 'kenya') {
  const hash = hashValue(queryValue);
  const { rows } = await pool.query(
    `SELECT * FROM searches
     WHERE query_type = $1 AND query_value_hash = $2 AND region = $3
       AND last_verified_at > now() - ($4 || ' days')::interval
     LIMIT 1`,
    [queryType, hash, region, FRESHNESS_DAYS]
  );
  return rows[0] || null;
}

function buildSiteRestrict(domains) {
  return domains.map((d) => `site:${d}`).join(' OR ');
}

function normalizeSearchResults(data) {
  if (Array.isArray(data.organic_results)) {
    return data.organic_results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }
  if (data.webPages && Array.isArray(data.webPages.value)) {
    return data.webPages.value.map((r) => ({ title: r.name, link: r.url, snippet: r.snippet }));
  }
  if (Array.isArray(data.items)) {
    return data.items.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }
  return [];
}

async function runOneQuery(url, key, isSerpApi, isBing, q) {
  let response;
  if (isSerpApi) {
    response = await axios.get(url, { params: { engine: 'google', q, api_key: key, num: 10 }, timeout: 12000 });
  } else if (isBing) {
    response = await axios.get(url, { params: { q, count: 10 }, headers: { 'Ocp-Apim-Subscription-Key': key }, timeout: 12000 });
  } else {
    response = await axios.get(url, { params: { key, q }, timeout: 12000 });
  }
  return normalizeSearchResults(response.data);
}

async function searchExternalWeb(queryType, queryValue, region = 'kenya') {
  const url = process.env.SEARCH_PROVIDER_URL;
  const key = process.env.SEARCH_PROVIDER_KEY;
  if (!url || !key) {
    return { available: false, snippets: [], note: 'External search provider not configured — verdict is based on internal database and CBK registry signal only.' };
  }

  const isSerpApi = url.includes('serpapi.com');
  const isBing = url.includes('bing.microsoft.com');

  const isInternational = region === 'international';

  let subject;
  if (queryType === 'job_offer') {
    const scamPatterns = isInternational ? INTERNATIONAL_JOB_SCAM_PATTERNS.join(' OR ') : 'scam OR fraud OR legit job offer';
    subject = isInternational
      ? `"${queryValue}" ${scamPatterns} job offer`
      : `"${queryValue}" scam OR fraud OR legit job offer`;
  } else {
    subject = `"${queryValue}" scam OR fraud OR legit Mpesa`;
  }

  let queries;
  if (isInternational && queryType === 'job_offer') {
    queries = [
      { tier: 'general', q: `${subject}` },
      { tier: 'government', q: `${subject} (${buildSiteRestrict(INTERNATIONAL_SCAM_DOMAINS)})` },
    ];
  } else {
    queries = [
      { tier: 'general', q: `${subject} Kenya` },
      { tier: 'government', q: `${subject} (${buildSiteRestrict(KENYA_GOV_DOMAINS)})` },
      { tier: 'news', q: `${subject} (${buildSiteRestrict(KENYA_NEWS_DOMAINS)})` },
    ];
  }

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
      if (link && seenLinks.has(link)) continue;
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
  const { rows } = await pool.query(
    `SELECT verdict, count(*)::int AS n FROM searches
     WHERE query_type = $1 AND query_value ILIKE $2
     GROUP BY verdict`,
    [queryType, `%${queryValue.slice(0, 40)}%`]
  );
  return rows;
}

function computeVerdict(dbSignal, external, cbkMatch, internationalMatch) {
  const scamVotes = dbSignal.find((r) => r.verdict === 'scam')?.n || 0;
  const legitVotes = dbSignal.find((r) => r.verdict === 'legit')?.n || 0;

  const scamHits = external.snippets.filter((s) => /scam|fraud|fake|beware|report/i.test(`${s.title} ${s.snippet}`));
  const scamWeightedScore = scamHits.reduce((sum, s) => sum + s.weight, 0);
  const hasGovernmentScamHit = scamHits.some((s) => s.tier === 'government');

  let internationalScamScore = 0;
  if (internationalMatch?.matched) {
    internationalScamScore = 10;
    if (internationalMatch.bbb?.matched) internationalScamScore += 5;
    if (internationalMatch.interpol?.matched) internationalScamScore += 15;
  }

  if (scamVotes > legitVotes || hasGovernmentScamHit || scamWeightedScore >= 4 || internationalScamScore >= 20) {
    return {
      verdict: 'scam',
      confidence: Math.min(97, 55 + scamVotes * 5 + scamWeightedScore * 5 + internationalScamScore + (hasGovernmentScamHit ? 15 : 0)),
    };
  }

  if (cbkMatch?.matched && scamWeightedScore === 0 && internationalScamScore === 0) {
    return { verdict: 'legit', confidence: Math.min(96, 82 + legitVotes * 3) };
  }

  if (legitVotes > 0 && scamWeightedScore === 0 && internationalScamScore === 0) {
    return { verdict: 'legit', confidence: Math.min(95, 55 + legitVotes * 8) };
  }

  if (!external.available && dbSignal.length === 0 && !cbkMatch?.matched && internationalScamScore === 0) {
    return { verdict: 'unverified', confidence: 30 };
  }

  return { verdict: 'suspicious', confidence: Math.min(80, 45 + scamWeightedScore * 4 + internationalScamScore * 2) };
}

function shapeForTier(result, tier) {
  const base = { verdict: result.verdict, confidence_score: result.confidence_score };
  if (tier === 50) return base;
  if (tier === 100) return { ...base, summary: result.summary };
  return { ...base, summary: result.summary, sources: result.sources_json };
}

async function checkInternationalDatabases(queryType, queryValue) {
  const cached = await internationalDb.getCachedInternationalLookup(queryType, queryValue);
  if (cached) {
    return {
      matched: cached.matched,
      bbb: cached.bbb_results || { matched: false, results: [] },
      ftc: cached.ftc_results || { matched: false, results: [] },
      interpol: cached.interpol_results || { matched: false, results: [] },
      fromCache: true,
    };
  }

  const result = await internationalDb.lookupAllInternationalDatabases(queryValue, queryType);
  await internationalDb.cacheInternationalLookup(queryType, queryValue, result);
  return { ...result, fromCache: false };
}

async function performSearch({ userId, queryType, queryValue, tier, amountPaid, region = 'kenya' }) {
  const cached = await findCached(queryType, queryValue, region);
  if (cached) {
    return { fromCache: true, result: shapeForTier(cached, tier) };
  }

  const isInternational = region === 'international';
  const skipCbk = isInternational || queryType !== 'paybill';

  const promises = [
    internalDbSignal(queryType, queryValue),
    searchExternalWeb(queryType, queryValue, region),
    skipCbk ? Promise.resolve({ matched: false }) : checkAgainstCbkRegistry(queryValue).catch(() => ({ matched: false })),
  ];

  if (isInternational) {
    promises.push(checkInternationalDatabases(queryType, queryValue).catch(() => ({ matched: false, bbb: {}, ftc: {}, interpol: {} })));
  }

  const results = await Promise.all(promises);
  const dbSignal = results[0];
  const external = results[1];
  const cbkMatch = results[2];
  const internationalMatch = isInternational ? results[3] : null;

  const { verdict, confidence } = computeVerdict(dbSignal, external, cbkMatch, internationalMatch);

  const govHits = external.snippets.filter((s) => s.tier === 'government').length;
  const newsHits = external.snippets.filter((s) => s.tier === 'news').length;
  const generalHits = external.snippets.filter((s) => s.tier === 'general').length;

  let summary;
  if (external.available) {
    if (isInternational) {
      const dbNames = [];
      if (internationalMatch?.bbb?.matched) dbNames.push('BBB Scam Tracker');
      if (internationalMatch?.ftc?.matched) dbNames.push('FTC fraud data');
      if (internationalMatch?.interpol?.matched) dbNames.push('INTERPOL alerts');
      const dbText = dbNames.length > 0 ? `, plus cross-referenced against ${dbNames.join(', ')}` : '';
      summary = `Checked against SemaCheck's report database and current worldwide web results (${govHits} official government/regulator source(s), ${newsHits} news/outlet source(s), ${generalHits} general web source(s))${dbText}.`;
    } else {
      summary = `Checked against SemaCheck's report database, the CBK licensed-lender registry, and current web results (${govHits} official Kenyan government/regulator source(s), ${newsHits} Kenyan news source(s), ${generalHits} general web source(s)).`;
    }
  } else {
    summary = `Checked against SemaCheck's report database${skipCbk ? '' : ' and the CBK licensed-lender registry'}. ${external.note}`;
  }
  if (cbkMatch?.matched) {
    const entry = cbkMatch.entries[0];
    summary += ` Matches a CBK-licensed digital lender on file: "${entry.company_name}"${entry.date_licensed_raw ? ` (licensed ${entry.date_licensed_raw})` : ''}.`;
  }

  const sourcesData = {
    db_signal: dbSignal,
    external_sources: external.snippets,
    cbk_registry_match: cbkMatch,
  };
  if (internationalMatch) {
    sourcesData.international_databases = {
      bbb: internationalMatch.bbb,
      ftc: internationalMatch.ftc,
      interpol: internationalMatch.interpol,
    };
  }

  const hash = hashValue(queryValue);
  const { rows } = await pool.query(
    `INSERT INTO searches (user_id, query_type, query_value, query_value_hash, region, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (query_type, query_value_hash, region) DO UPDATE SET last_verified_at = now()
     RETURNING *`,
    [
      userId, queryType, queryValue, hash, region, verdict, confidence, summary,
      JSON.stringify(sourcesData),
      tier, amountPaid,
    ]
  );

  return { fromCache: false, result: shapeForTier(rows[0], tier) };
}

module.exports = { performSearch, findCached, hashValue };
