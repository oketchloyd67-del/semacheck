// db/add-otp-columns.js
const pool = require('./pool');

async function addOtpColumns() {
  const client = await pool.connect();
  try {
    console.log('Adding OTP columns to users table...');
    
    await client.query('BEGIN');

    const columns = [
      'otp_code_hash TEXT',
      'otp_expires_at TIMESTAMPTZ',
      'otp_attempts SMALLINT DEFAULT 0 NOT NULL',
      'email_verified BOOLEAN DEFAULT FALSE NOT NULL'
    ];

    for (const colDef of columns) {
      const colName = colDef.split(' ')[0];
      try {
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ' + colDef);
        console.log('Added column: ' + colName);
      } catch (err) {
        if (err.code === '42701') {
          console.log('Column already exists: ' + colName);
        } else {
          throw err;
        }
      }
    }

    await client.query('COMMIT');
    console.log('OTP columns added successfully');

    // Verify columns
    const result = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('otp_code_hash', 'otp_expires_at', 'otp_attempts', 'email_verified') ORDER BY column_name"
    );
    
    console.log('OTP columns in users table:');
    for (const row of result.rows) {
      console.log('  - ' + row.column_name);
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to add OTP columns:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  addOtpColumns().catch(function(err) {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
  });
}

module.exports = { addOtpColumns };