
require('dotenv').config();
const { Pool } = require('pg');

async function testConnection() {
  console.log('🔍 Testing database connection...');
  console.log('📡 DB_USER:', process.env.DB_USER);
  console.log('📡 DB_HOST:', process.env.DB_HOST);
  console.log('📡 DB_NAME:', process.env.DB_NAME);
  console.log('📡 DB_PASSWORD:', process.env.DB_PASSWORD ? '✅ Set' : '❌ Missing');
  console.log('📡 DB_PORT:', process.env.DB_PORT);

  const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'semacheck',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
  });

  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('✅ Database connected successfully!');
    console.log('📅 Time:', result.rows[0].now);
    client.release();
    await pool.end();
    return true;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.error('📋 Full error:', error);
    return false;
  }
}

testConnection();