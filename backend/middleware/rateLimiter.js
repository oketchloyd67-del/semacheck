// middleware/rateLimiter.js
//
// Scaling note: express-rate-limit here counts requests per-process.
// To genuinely hold 1000+ req/min smoothly under real traffic, run
// this app under PM2/Node cluster (one worker per CPU core) or as
// several containers behind a load balancer, and point RATE_LIMIT_STORE
// at Redis (see .env.example) so all instances share one counter —
// otherwise each instance enforces the limit independently, which
// under-protects the app as instances scale up. Full explanation in
// README "Scaling to 1000+ requests/minute".

const rateLimit = require('express-rate-limit');

// ── Redis connection (shared client, but stores are separate) ──
let redisClient = null;
let redisConnected = false;

function getRedisClient() {
  if (redisClient) return redisClient;
  
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      redisClient = createClient({ 
        url: process.env.REDIS_URL,
        socket: {
          connectTimeout: 5000,
        },
      });
      
      redisClient.on('error', (err) => {
        console.error('Redis error:', err.message);
        redisConnected = false;
      });
      
      redisClient.on('connect', () => {
        console.log('✅ Redis connected for rate limiting');
        redisConnected = true;
      });
      
      // Don't await - let it connect in background
      redisClient.connect().catch((e) => {
        console.warn('⚠️ Redis connect failed, falling back to memory store:', e.message);
        redisClient = null;
      });
      
      return redisClient;
    } catch (e) {
      console.warn('⚠️ Redis unavailable, falling back to in-memory:', e.message);
      redisClient = null;
      return null;
    }
  }
  return null;
}

// ── Create a NEW store instance for EACH limiter ──
function createStore(prefix) {
  const client = getRedisClient();
  
  if (client && redisConnected !== false) {
    try {
      const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
      // ✅ Each limiter gets its own store with a unique prefix
      return new RedisStore({
        sendCommand: (...args) => client.sendCommand(args),
        prefix: `semacheck:${prefix}:`, // ✅ Unique prefix per limiter
      });
    } catch (e) {
      console.warn(`⚠️ RedisStore unavailable for ${prefix}, falling back to memory:`, e.message);
      return undefined;
    }
  }
  return undefined; // Use default MemoryStore
}

// ── Helper to create rate limiter with options ──
function makeLimiter(options, storePrefix) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    store: createStore(storePrefix),
    ...options,
  });
}

// ── Rate limiters (each with its own store) ──
const generalLimiter = makeLimiter(
  { 
    windowMs: 60 * 1000, 
    max: 120, 
    message: { error: 'Too many requests — please slow down.' } 
  },
  'general'
);

const authLimiter = makeLimiter(
  { 
    windowMs: 60 * 1000, 
    max: 10, 
    message: { error: 'Too many attempts. Try again in a minute.' } 
  },
  'auth'
);

const paymentLimiter = makeLimiter(
  { 
    windowMs: 60 * 1000, 
    max: 6, 
    message: { error: 'Too many payment attempts. Please wait a moment.' } 
  },
  'payment'
);

const searchLimiter = makeLimiter(
  { 
    windowMs: 60 * 1000, 
    max: 40, 
    message: { error: 'Too many searches. Please wait a moment.' } 
  },
  'search'
);

// ── Export all limiters ──
module.exports = { 
  generalLimiter, 
  authLimiter, 
  paymentLimiter, 
  searchLimiter 
};