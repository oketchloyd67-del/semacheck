










const rateLimit = require('express-rate-limit');


let redisClient = null;
let redisConnected = false;
let redisGaveUp = false;
let redisErrorLogged = false;

const REDIS_MAX_RETRIES = 3;

// REDIS_URL has been set to a whole `redis-cli -u redis://…` command line in
// the past, which made `new URL()` throw "Invalid URL" and silently disabled
// Redis. Accept a bare URL, or dig the URL out of a pasted command.
function normalizeRedisUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/^["']|["']$/g, '');
  if (/^rediss?:\/\//i.test(trimmed)) return trimmed;
  const match = trimmed.match(/rediss?:\/\/\S+/i);
  if (match) {
    console.warn('[redis] REDIS_URL contained a command instead of a bare URL — extracted the URL automatically.');
    return match[0];
  }
  console.warn('[redis] REDIS_URL is not a usable redis:// URL — falling back to in-memory rate limiting.');
  return null;
}

function getRedisClient() {
  if (redisClient) return redisClient;
  if (redisGaveUp) return null;

  const redisUrl = normalizeRedisUrl(process.env.REDIS_URL);
  if (redisUrl) {
    try {
      const { createClient } = require('redis');
      redisClient = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 5000,
          reconnectStrategy: (retries) =>
            retries >= REDIS_MAX_RETRIES ? false : Math.min(retries * 500, 3000),
        },
      });

      redisClient.on('error', (err) => {
        redisConnected = false;
        if (redisErrorLogged) return;
        redisErrorLogged = true;
        console.warn(
          'Redis unavailable, falling back to in-memory rate limiting:',
          err && err.message ? err.message : err
        );
      });

      redisClient.on('ready', () => {
        redisConnected = true;
        redisErrorLogged = false;
        console.log('Redis connected for rate limiting');
      });

      redisClient.connect().catch(() => {
        redisGaveUp = true;
        redisClient = null;
      });

      return redisClient;
    } catch (e) {
      redisGaveUp = true;
      redisClient = null;
      console.warn('Redis unavailable, using in-memory rate limiting:', e.message);
      return null;
    }
  }
  return null;
}


function createStore(prefix) {
  const client = getRedisClient();
  
  if (client && redisConnected !== false) {
    try {
      const RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
      
      return new RedisStore({
        sendCommand: (...args) => client.sendCommand(args),
        prefix: `semacheck:${prefix}:`, 
      });
    } catch (e) {
      console.warn(`⚠️ RedisStore unavailable for ${prefix}, falling back to memory:`, e.message);
      return undefined;
    }
  }
  return undefined; 
}


function makeLimiter(options, storePrefix) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    store: createStore(storePrefix),
    ...options,
  });
}


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


module.exports = { 
  generalLimiter, 
  authLimiter, 
  paymentLimiter, 
  searchLimiter 
};