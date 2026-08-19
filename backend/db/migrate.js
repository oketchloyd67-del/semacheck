// db/migrate.js — run with: node db/migrate.js
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

/**
 * Runs the full schema migration.
 * Reads schema.sql and executes it within a transaction.
 * If a table already exists, it skips that statement gracefully.
 */
async function migrate() {
  const sqlFilePath = path.join(__dirname, 'schema.sql');

  // Check if the schema.sql file exists before proceeding
  if (!fs.existsSync(sqlFilePath)) {
    console.error('Schema file not found:', sqlFilePath);
    console.error('Please ensure a schema.sql file exists in the db/ directory.');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  const client = await pool.connect();

  try {
    console.log('Running SemaCheck schema migration...');
    console.log('Using schema file:', sqlFilePath);

    // Split the SQL file into individual statements, filtering out empty lines
    const statements = sql
      .split(';')
      .map(function(stmt) {
        return stmt.trim();
      })
      .filter(function(stmt) {
        return stmt.length > 0;
      });

    console.log('Found', statements.length, 'SQL statements to execute.');

    // Begin a transaction to ensure all-or-nothing execution
    await client.query('BEGIN');

    for (var i = 0; i < statements.length; i++) {
      var stmt = statements[i] + ';';
      try {
        await client.query(stmt);
        // Log a success message
        var preview = stmt.split('\n')[0];
        if (preview.length > 60) {
          preview = preview.substring(0, 60) + '...';
        }
        console.log('Executed:', preview);
      } catch (stmtErr) {
        // If the error is 'relation already exists' (code 42P07) or
        // 'duplicate key value violates unique constraint' (23505), we can safely ignore it.
        // This allows the migration to be run multiple times without failure.
        if (stmtErr.code === '42P07' || stmtErr.code === '23505') {
          var msg = stmtErr.message;
          if (msg.length > 80) {
            msg = msg.substring(0, 80) + '...';
          }
          console.log('Skipped already-existing element:', msg);
        } else {
          // For any other error, abort the transaction and throw
          console.error('Error executing statement:');
          var stmtPreview = stmt;
          if (stmtPreview.length > 200) {
            stmtPreview = stmtPreview.substring(0, 200) + '...';
          }
          console.error(stmtPreview);
          throw stmtErr;
        }
      }
    }

    // Commit the transaction if all statements succeeded
    await client.query('COMMIT');
    console.log('Schema migration completed successfully.');

  } catch (err) {
    // Rollback the transaction on any error
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    if (err.detail) {
      console.error('Detail:', err.detail);
    }
    process.exitCode = 1;
  } finally {
    // Release the database client back to the pool
    client.release();
    await pool.end();
    console.log('Database connection closed.');
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  migrate().catch(function(err) {
    console.error('Unhandled migration error:', err);
    process.exitCode = 1;
  });
}


module.exports = { migrate };