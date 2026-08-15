// db/pool.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'postgresql://semacheck_db_user:0jDp7ErVFWZ88B1rbecuEiRb4u0v5zIF@dpg-da082uvlk1mc73fcanh0-a.singapore-postgres.render.com/semacheck_db',
  database: process.env.DB_NAME || 'semacheck',
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  max: parseInt(process.env.PG_POOL_MAX || '30', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

module.exports = pool;