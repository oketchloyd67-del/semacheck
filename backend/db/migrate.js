
const fs = require('fs');
const path = require('path');
const pool = require('./pool');


async function migrate() {
  const sqlFilePath = path.join(__dirname, 'schema.sql');

  
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

    
    const statements = sql
      .split(';')
      .map(function(stmt) {
        return stmt.trim();
      })
      .filter(function(stmt) {
        return stmt.length > 0;
      });

    console.log('Found', statements.length, 'SQL statements to execute.');

    
    await client.query('BEGIN');

    for (var i = 0; i < statements.length; i++) {
      var stmt = statements[i] + ';';
      try {
        await client.query(stmt);
        
        var preview = stmt.split('\n')[0];
        if (preview.length > 60) {
          preview = preview.substring(0, 60) + '...';
        }
        console.log('Executed:', preview);
      } catch (stmtErr) {
        
        
        
        if (stmtErr.code === '42P07' || stmtErr.code === '23505') {
          var msg = stmtErr.message;
          if (msg.length > 80) {
            msg = msg.substring(0, 80) + '...';
          }
          console.log('Skipped already-existing element:', msg);
        } else {
          
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

    
    await client.query('COMMIT');
    console.log('Schema migration completed successfully.');

  } catch (err) {
    
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    if (err.detail) {
      console.error('Detail:', err.detail);
    }
    process.exitCode = 1;
  } finally {
    
    client.release();
    await pool.end();
    console.log('Database connection closed.');
  }
}


if (require.main === module) {
  migrate().catch(function(err) {
    console.error('Unhandled migration error:', err);
    process.exitCode = 1;
  });
}


module.exports = { migrate };