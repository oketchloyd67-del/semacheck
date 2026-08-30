









require('dotenv').config();
const pool = require('../db/pool');
const { refreshCbkRegistry } = require('../services/cbkRegistryService');

async function run() {
  try {
    const result = await refreshCbkRegistry();
    console.log(`CBK registry refreshed: ${result.count} entities cached from ${result.sourceUrl}`);
    return result;
  } catch (err) {
    console.error('CBK registry refresh failed:', err.message);
    throw err;
  }
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch(() => {
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { run };
