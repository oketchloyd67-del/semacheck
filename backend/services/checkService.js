const crypto = require('crypto');
const pool = require('../db/pool');
const normalize = require('./normalizeService');
const verdictMapper = require('./verdictMapper');
const cbk = require('./cbkRegistryService');
const searchService = require('./searchService');
const { notifySearchResults } = require('./pushNotificationService');

const CACHE_TTL_HOURS = parseInt(process.env.API_CACHE_TTL_HOURS || '6', 10);
const EXTERNAL_SEARCH_TIMEOUT_MS = parseInt(process.env.API_EXTERNAL_SEARCH_TIMEOUT_MS || '6000', 10);

function hashSubject(type, value) {
  return normalize.hashSubject(type, value);
}

async function cacheKey(type, value, region) {
  return `${type}:${value}:${region || 'kenya'}`;
}

async function run({ userId, checkType, rawValue, region = 'kenya' }) {
  const { value, hash } = normalize.normalizeSubject(checkType, rawValue);
  const cacheId = await cacheKey(checkType, value, region);

  // 1. Cache lookup
  const cached = await findCached(checkType, value, region);
  if (cached) {
    return { cached: true, result: cached };
  }

  // 2. Signals
  const dbSignal = await internalDbSignal(checkType, value);
  const external = await searchService.searchExternalWeb(checkType, value, region);
  const cbkResult = await checkCbk(checkType, value, region);
  const internationalResult = await checkInternational(checkType, value, region);
  const disputeOpen = await hasOpenDispute(checkType, hash);

  const signals = {
    scamVotes: dbSignal.scamVotes || 0,
    legitVotes: dbSignal.legitVotes || 0,
    cbkMatch: Boolean(cbkResult && cbkResult.matched),
    internationalScamScore: internationalResult.internationalScamScore || 0,
    externalBreachScore: externalBreachScore(external),
    hasGovernmentScamHit: externalBreachScore(external) >= 4,
    externalAvailable: external.available,
    hasDispute: disputeOpen,
  };

  // 3. Verdict
  const mapped = verdictMapper.verdictMapper(signals);
  const { verdict, confidence, reasons, displayVerdict } = mapped;

  // 4. Summary and sources
  const { summary, sourcesData } = buildSummary({ checkType, value, dbSignal, external, cbkMatch, internationalResult, region });

  // 5. Persist
  const result = await persistSearch({
    userId,
    checkType,
    value,
    hash,
    region,
    verdict,
    confidence,
    summary,
    sourcesData,
    tier: Number(userId ? 100 : 100),
    amountPaid: 0,
  });

  return { cached: false, result: { ...result, summary, reasons, displayVerdict, disputed: disputeOpen } };
}

async function findCached(checkType, value, region) {
  const hash = hashSubject(checkType, value);
  const { rows } = await pool.query(
    `SELECT * FROM searches
     WHERE query_type = $1 AND query_value_hash = $2 AND region = $3
       AND last_verified_at > now() - ($4 || ' hours')::interval
     LIMIT 1`,
    [checkType, hash, region, CACHE_TTL_HOURS]
  );
  return rows[0] || null;
}

async function hasOpenDispute(checkType, hash) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM report_disputes d
       JOIN scam_reports r ON r.id = d.report_id
       WHERE d.status = 'open' AND r.status = 'approved' AND r.report_type = $1 AND r.subject_hash = $2
       LIMIT 1`,
      [checkType, hash]
    );
    return Boolean(rows[0]);
  } catch {
    return false;
  }
}

async function internalDbSignal(checkType, value) {
  const { rows } = await pool.query(
    `SELECT verdict, count(*)::int AS n FROM searches
     WHERE query_type = $1 AND query_value ILIKE $2
     GROUP BY verdict`,
    [checkType, `%${value.slice(0, 40)}%`]
  );
  const scamVotes = rows.find((r) => r.verdict === 'scam')?.n || 0;
  const legitVotes = rows.find((r) => r.verdict === 'legit')?.n || 0;
  return { scamVotes, legitVotes };
}

async function checkCbk(checkType, value, region) {
  if (region === 'international' || checkType !== 'paybill') {
    return { matched: false };
  }
  try {
    return await cbk.checkAgainstCbkRegistry(value);
  } catch {
    return { matched: false };
  }
}

async function checkInternational(checkType, value, region) {
  if (region !== 'international') return { internationalScamScore: 0 };
  try {
    const result = await searchService.checkInternationalDatabases(checkType, value);
    let score = 0;
    if (result.matched) score = 20;
    if (result.bbb?.matched) score += 5;
    if (result.interpol?.matched) score += 15;
    return { internationalScamScore: score, matched: result.matched, bbb: result.bbb, ftc: result.ftc, interpol: result.interpol };
  } catch {
    return { internationalScamScore: 0 };
  }
}

function externalBreachScore(external) {
  if (!external || !external.available) return 0;
  const hits = external.snippets.filter((s) => /scam|fraud|fake|beware|report/i.test(`${s.title} ${s.snippet || ''}`));
  return hits.length;
}

function buildSummary({ checkType, value, dbSignal, external, cbkMatch, internationalResult, region }) {
  const govHits = external && external.available ? external.snippets.filter((s) => s.tier === 'government').length : 0;
  const newsHits = external && external.available ? external.snippets.filter((s) => s.tier === 'news').length : 0;
  const generalHits = external && external.available ? external.snippets.filter((s) => s.tier === 'general').length : 0;

  let summary;
  if (external && external.available) {
    if (region === 'international') {
      const dbNames = [];
      if (internationalResult.bbb?.matched) dbNames.push('BBB Scam Tracker');
      if (internationalResult.ftc?.matched) dbNames.push('FTC fraud data');
      if (internationalResult.interpol?.matched) dbNames.push('INTERPOL alerts');
      const dbText = dbNames.length ? `, plus cross-referenced against ${dbNames.join(', ')}` : '';
      summary = `Checked against SemaCheck's report database and current worldwide web results (${govHits} official government/regulator source(s), ${newsHits} news/outlet source(s), ${generalHits} general web source(s))${dbText}.`;
    } else {
      summary = `Checked against SemaCheck's report database, the CBK licensed-lender registry, and current web results (${govHits} official Kenyan government/regulator source(s), ${newsHits} Kenyan news source(s), ${generalHits} general web source(s)).`;
    }
  } else {
    summary = `Checked against SemaCheck's report database${cbkMatch.matched ? '' : ''}${cbkMatch.matched ? ' and the CBK licensed-lender registry' : ''}. ${external?.note || ''}`;
  }
  if (cbkMatch.matched) {
    const entry = cbkMatch.entries && cbkMatch.entries[0];
    if (entry) {
      summary += ` Matches a CBK-licensed digital lender on file: "${entry.company_name}"${entry.date_licensed_raw ? ` (licensed ${entry.date_licensed_raw})` : ''}.`;
    }
  }
  return { summary, sourcesData: { db_signal: dbSignal, external_sources: external && external.available ? external.snippets : [], cbk_registry_match: cbkMatch, international_databases: internationalResult } };
}

async function persistSearch({ userId, checkType, value, hash, region, verdict, confidence, summary, sourcesData, tier, amountPaid }) {
  const { rows } = await pool.query(
    `INSERT INTO searches (user_id, query_type, query_value, query_value_hash, region, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (query_type, query_value_hash, region) DO UPDATE SET verdict = EXCLUDED.verdict, confidence_score = EXCLUDED.confidence_score, summary = EXCLUDED.summary, sources_json = EXCLUDED.sources_json, last_verified_at = now()
     RETURNING *`,
    [userId, checkType, value, hash, region, verdict, confidence, summary, JSON.stringify(sourcesData), tier, amountPaid]
  );
  return rows[0];
}

async function invalidateSubject(type, hash) {
  await pool.query(
    `UPDATE searches SET verdict = 'unverified', confidence_score = 30, last_verified_at = now()
     WHERE query_type = $1 AND query_value_hash = $2`,
    [type, hash]
  );
  return { invalidated: true };
}

module.exports = { run, invalidateSubject, findCached, hashSubject, internalDbSignal, checkCbk, checkInternational };
