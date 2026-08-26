// db/pool.js
const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Force IPv4 globally
dns.setDefaultResultOrder('ipv4first');

// Monkey-patch DNS lookup to force IPv4
const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (options && typeof options === 'object') {
    options.family = 4;
  } else {
    options = { family: 4 };
  }
  return originalLookup(hostname, options, callback);
};

console.log('DB configuration starting...');
console.log('IPv4 forced for all DNS resolutions');

let poolConfig = {
  max: parseInt(process.env.PG_POOL_MAX || '30', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
};

if (process.env.DATABASE_URL) {
  console.log('Using DATABASE_URL for connection');
  poolConfig.connectionString = process.env.DATABASE_URL;
  
  // SSL is required for Supabase
  if (process.env.NODE_ENV === 'production') {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }
  
  // Force IPv4
  poolConfig.family = 4;
  
} else {
  console.log('Using individual DB parameters for connection');
  poolConfig = {
    ...poolConfig,
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'semacheck',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    family: 4,
  };
}

console.log('Database config:', {
  hasConnectionString: !!poolConfig.connectionString,
  host: poolConfig.host || 'using connectionString',
  database: poolConfig.database || 'using connectionString',
  ssl: poolConfig.ssl ? 'enabled' : 'disabled',
  family: poolConfig.family || 'default',
  connectionTimeout: poolConfig.connectionTimeoutMillis
});

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('PostgreSQL connected successfully');
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

// Test connection with retry
async function testConnectionWithRetry(retries = 5) {
  let client;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Connection attempt ${i + 1}/${retries}...`);
      client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      console.log('PostgreSQL is live at:', result.rows[0].now);
      client.release();
      return true;
    } catch (err) {
      console.error(`Connection attempt ${i + 1}/${retries} failed:`, err.message);
      if (client) client.release();
      if (i < retries - 1) {
        console.log('Waiting 3 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  console.error('All connection attempts failed. Check your DATABASE_URL.');
  return false;
}

// Run connection test
testConnectionWithRetry();

module.exports = pool;