// Per-key, per-minute rate limiting. Single-process in-memory sliding
// window (token bucket per key id). Move to Postgres/Redis when you
// scale beyond one server instance.
const map = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, { last, count }] of map.entries()) {
    if (now - last > 60_000) map.delete(key);
  }
}

function apiRateLimit(req, res, next) {
  const accountId = Number(req.apiAccount && req.apiAccount.id);
  const keyId = Number(req.apiKeyId);
  const identifier = accountId && keyId ? `${accountId}:${keyId}` : null;
  if (!identifier) return next();

  const now = Date.now();
  const entry = map.get(identifier) || { last: now, count: 0 };
  entry.last = now;
  entry.count += 1;
  map.set(identifier, entry);

  if (entry.count > 1000) cleanup();

  const limit = Number(req.apiAccount ? req.apiAccount.rateLimitPerMin : 10);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil((entry.last + 60_000) / 1000)));

  if (entry.count > limit) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'rate_limited', retryAfter: 60 });
  }

  next();
}

module.exports = { apiRateLimit };
