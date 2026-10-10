const express = require('express');
const pool = require('../db/pool');
const usageService = require('../services/usageService');

const router = express.Router();

// 10-minute in-memory cache for aggregate numbers.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;
let cacheExpiry = 0;

async function refreshCache() {
  const stats = await usageService.getPlatformStats();
  cache = stats;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
}

router.get('/', async (req, res) => {
  if (cache && cacheExpiry > Date.now()) {
    res.json(cache);
    return;
  }
  try {
    await refreshCache();
    res.json(cache);
  } catch (err) {
    console.error('publicStats failed:', err);
    if (cache) res.json(cache);
    else res.json({ checksServed: 0, approvedReports: 0, verdictMix: [], activeAccounts: 0, dailySeries: [], latencyP50: 0, latencyP95: 0 });
  }
});

module.exports = router;
