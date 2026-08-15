// test-redis.js
require('dotenv').config();
const { createClient } = require('redis');

async function testRedis() {
  console.log('🔍 Testing Redis connection...');
  console.log('📡 REDIS_URL:', process.env.REDIS_URL ? '✅ Set' : '❌ Missing');

  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL not set in .env');
    return;
  }

  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 10000,
    },
  });

  client.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
  });

  try {
    await client.connect();
    console.log('✅ Redis connected successfully!');
    
    // Test set/get
    await client.set('test_key', 'Hello SemaCheck!');
    const value = await client.get('test_key');
    console.log('📝 Test value:', value);
    
    await client.quit();
    console.log('✅ Redis test completed!');
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
  }
}

testRedis();