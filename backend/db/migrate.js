// db/migrate.js — run with: node db/migrate.js
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

/
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
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    console.log('Found', statements.length, 'SQL statements to execute.');

    
    await client.query('BEGIN');

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i] + ';'; 
      try {
        await client.query(stmt);
        
        const preview = stmt.split('\n')[0].substring(0, 60) + '...';
        console.log('Executed:', preview);
      } catch (stmtErr) {
        
        if (stmtErr.code === '42P07' || stmtErr.code === '23505') {
          console.log('Skipped already-existing element:', stmtErr.message.substring(0, 80) + '...');
        } else {
         
          console.error('Error executing statement:');
          console.error(stmt.substring(0, 200) + '...');
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
  migrate().catch((err) => {
    console.error('Unhandled migration error:', err);
    process.exitCode = 1;
  });
}


module.exports = { migrate };