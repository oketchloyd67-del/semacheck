require('dotenv').config();
const pool = require('../db/pool');
const { internationalLookupStatus } = require('../services/internationalScamDatabases');

async function run() {
  try {
    const status = await internationalLookupStatus();
    console.log(`International scam databases: ${status.total} cached lookups, ${status.matched} matched scams, last checked: ${status.last_checked || 'never'}`);
    return status;
  } catch (err) {
    console.error('International databases status check failed:', err.message);
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
