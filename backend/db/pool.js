// db/pool.js
const { Pool } = require('pg');
require('dotenv').config();

// ── Build connection config ──
let poolConfig = {
  max: parseInt(process.env.PG_POOL_MAX || '30', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// ── PRIORITY 1: Use DATABASE_URL (Render provides this) ──
if (process.env.DATABASE_URL) {
  console.log('📡 Using DATABASE_URL for connection');
  poolConfig.connectionString = process.env.DATABASE_URL;
  
  // Render PostgreSQL requires SSL
  if (process.env.NODE_ENV === 'production') {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }
} 
// ── PRIORITY 2: Use individual parameters (local development) ──
else if (process.env.DB_USER && process.env.DB_PASSWORD) {
  console.log('📡 Using individual DB parameters for connection');
  poolConfig = {
    ...poolConfig,
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'semacheck',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
  };
} 
// ── PRIORITY 3: Hardcoded fallback (for Render testing) ──
else {
  console.log('📡 Using hardcoded Render database connection');
  poolConfig = {
    ...poolConfig,
    connectionString: 'postgresql://semacheck_db_user:0jDp7ErVFWZ88B1rbecuEiRb4u0v5zIF@dpg-da082uvlk1mc73fcanh0-a.singapore-postgres.render.com/semacheck_db',
    ssl: {
      rejectUnauthorized: false,
    },
  };
}

// ── Log connection info (without exposing password) ──
console.log('📡 Database config:', {
  hasConnectionString: !!poolConfig.connectionString,
  host: poolConfig.host || 'using connectionString',
  database: poolConfig.database || 'using connectionString',
  ssl: poolConfig.ssl ? 'enabled' : 'disabled'
});

const pool = new Pool(poolConfig);

// ── Connection test on startup ──
pool.on('connect', () => {
  console.log('PostgreSQL connected successfully');
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

// ── Test connection immediately ──
(async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('PostgreSQL is live at:', result.rows[0].now);
    client.release();
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error('   Exiting due to connection failure.');
      process.exit(1);
    }
    if (client) client.release();
  }
})();

module.exports = pool;