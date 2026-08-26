// db/pool.js
const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Force IPv4 globally for all DNS resolutions
dns.setDefaultResultOrder('ipv4first');

console.log('DB configuration starting...');

let poolConfig = {
  max: parseInt(process.env.PG_POOL_MAX || '30', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
};

if (process.env.DATABASE_URL) {
  console.log('Using DATABASE_URL for connection');
  
  // Parse the DATABASE_URL to extract host and force IPv4
  let connectionString = process.env.DATABASE_URL;
  
  // If ?family=4 is not already in the URL, add it
  if (!connectionString.includes('family=4')) {
    if (connectionString.includes('?')) {
      connectionString += '&family=4';
    } else {
      connectionString += '?family=4';
    }
  }
  
  poolConfig.connectionString = connectionString;
  
  // SSL is required for Supabase
  if (process.env.NODE_ENV === 'production') {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }
  
  // Force IPv4 on the pool itself
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
async function testConnectionWithRetry(retries = 3) {
  let client;
  for (let i = 0; i < retries; i++) {
    try {
      client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      console.log('PostgreSQL is live at:', result.rows[0].now);
      client.release();
      return true;
    } catch (err) {
      console.error(`Connection attempt ${i + 1}/${retries} failed:`, err.message);
      if (client) client.release();
      if (i < retries - 1) {
        console.log('Waiting 2 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  console.error('All connection attempts failed.');
  return false;
}

// Run connection test
testConnectionWithRetry();

module.exports = pool;