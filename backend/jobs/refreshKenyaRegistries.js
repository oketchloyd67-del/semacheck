// jobs/refreshKenyaRegistries.js
//
// Refreshes the locally-cached CBK licensed digital lenders registry
// (see services/cbkRegistryService.js). Run weekly — CBK doesn't
// re-license lenders daily, and this is a real network fetch + PDF
// parse, no need to hit it more often than that.
//
// Run directly: `node jobs/refreshKenyaRegistries.js`
// Or via: `npm run refresh-kenya-registry`

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
