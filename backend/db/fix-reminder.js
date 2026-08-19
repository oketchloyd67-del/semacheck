
const pool = require('./pool');

async function fixReminderColumns() {
  const client = await pool.connect();
  try {
    console.log('Checking and fixing reminder columns in subscriptions table...');
    
    await client.query('BEGIN');

    
    const reminderColumns = [
      'reminder_30_sent_at TIMESTAMPTZ',
      'reminder_25_sent_at TIMESTAMPTZ',
      'reminder_20_sent_at TIMESTAMPTZ',
      'reminder_15_sent_at TIMESTAMPTZ',
      'reminder_10_sent_at TIMESTAMPTZ',
      'reminder_5_sent_at TIMESTAMPTZ',
      'reminder_3_sent_at TIMESTAMPTZ',
      'reminder_1_sent_at TIMESTAMPTZ'
    ];

    for (var i = 0; i < reminderColumns.length; i++) {
      var colDef = reminderColumns[i];
      var colName = colDef.split(' ')[0];
      try {
        await client.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ' + colDef);
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
    console.log('Reminder columns fix completed successfully');

    // Show final columns
    var result = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name LIKE 'reminder_%' ORDER BY column_name"
    );
    
    console.log('Reminder columns in subscriptions table:');
    for (var j = 0; j < result.rows.length; j++) {
      console.log('  - ' + result.rows[j].column_name);
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to fix reminder columns:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  fixReminderColumns().catch(function(err) {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
  });
}

module.exports = { fixReminderColumns };