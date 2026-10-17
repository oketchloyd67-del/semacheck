



const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./pool');
const { assertSafeToSeed, randomPassword } = require('./seedGuard');

// Never seed demo accounts into production, and never use a fixed password:
// a known admin password in a public README is a full-admin compromise (CHK-01).
assertSafeToSeed();

function hashValue(v) {
  return crypto.createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
}

async function seed() {
  const client = await pool.connect();
  try {
    const adminPassword = randomPassword();
    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
    const { rowCount: adminInserted } = await client.query(
      `INSERT INTO admins (full_name, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      ['SemaCheck Admin', 'admin@semacheck.co.ke', adminPasswordHash]
    );

    const samplePaybill = '400200';
    await client.query(
      `INSERT INTO searches (query_type, query_value, query_value_hash, region, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (query_type, query_value_hash, region) DO NOTHING`,
      [
        'paybill',
        samplePaybill,
        hashValue(samplePaybill),
        'kenya',
        'registered',
        92,
        'Paybill is registered to a licensed Nairobi retailer with no scam reports in the last 12 months.',
        JSON.stringify({ db_matches: 1, external_sources: ['Business registry lookup', 'Community scam-report archive'] }),
        50,
        50.0,
      ]
    );

    const sampleJobText = 'data entry job whatsapp only pay 500 registration fee';
    await client.query(
      `INSERT INTO searches (query_type, query_value, query_value_hash, region, verdict, confidence_score, summary, sources_json, tier_paid, amount_paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (query_type, query_value_hash, region) DO NOTHING`,
      [
        'job_offer',
        sampleJobText,
        hashValue(sampleJobText),
        'kenya',
        'reported',
        88,
        'Matches a widely reported pattern: upfront "registration fee" requested over WhatsApp before any interview. Flagged by multiple community reports.',
        JSON.stringify({ db_matches: 14, external_sources: ['Community scam-report archive', 'Web search: registration-fee job scam pattern'] }),
        50,
        50.0,
      ]
    );

    console.log('✔ Seed complete.');
    if (adminInserted === 1) {
      // Printed once, never written to a file or the README. Change it after first login.
      console.log('Admin login: admin@semacheck.co.ke');
      console.log('Admin password (shown once):', adminPassword);
    } else {
      console.log('Admin account already existed; its password was left unchanged.');
    }
  } catch (err) {
    console.error('✘ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
