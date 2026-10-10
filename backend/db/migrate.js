
const fs = require('fs');
const path = require('path');
const pool = require('./pool');


async function readStatements(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const sql = fs.readFileSync(filePath, 'utf8');
  // Semicolons inside `--` comments must not split a statement in two.
  // (One such comment in schema-trust-api.sql silently aborted every migration.)
  const sanitized = sql
    .split('\n')
    .map(function (line) { return /^\s*--/.test(line) ? line.replace(/;/g, '') : line; })
    .join('\n');
  return sanitized
    .split(';')
    .map(function(stmt) { return stmt.trim(); })
    .filter(function(stmt) { return stmt.length > 0; });
}

async function runStatements(client, statements, label) {
  for (var i = 0; i < statements.length; i++) {
    var stmt = statements[i] + ';';
    try {
      await client.query(stmt);
      var preview = stmt.split('\n')[0];
      if (preview.length > 60) preview = preview.substring(0, 60) + '...';
      console.log(label ? label + ' ' : '', 'Executed:', preview);
    } catch (stmtErr) {
      if (stmtErr.code === '42P07' || stmtErr.code === '23505') {
        var msg = stmtErr.message;
        if (msg.length > 80) msg = msg.substring(0, 80) + '...';
        console.log(label ? label + ' ' : '', 'Skipped already-existing element:', msg);
      } else {
        console.error(label ? label + ' ' : '', 'Error executing statement:');
        var stmtPreview = stmt;
        if (stmtPreview.length > 200) stmtPreview = stmtPreview.substring(0, 200) + '...';
        console.error(stmtPreview);
        throw stmtErr;
      }
    }
  }
}

async function migrate(options) {
  // closePool: set false when the caller (server.js) shares this pool and must
  // keep it alive after migrating.
  const closePool = !options || options.closePool !== false;
  const schemaSqlPath = path.join(__dirname, 'schema.sql');

  if (!fs.existsSync(schemaSqlPath)) {
    console.error('Schema file not found:', schemaSqlPath);
    console.error('Please ensure a schema.sql file exists in the db/ directory.');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const schemaStatements = await readStatements(schemaSqlPath);
  const trustApiSqlPath = path.join(__dirname, 'schema-trust-api.sql');
  const trustApiStatements = await readStatements(trustApiSqlPath);

  const client = await pool.connect();

  try {
    console.log('Running SemaCheck schema migration...');
    console.log('Using schema file:', schemaSqlPath);
    console.log('Found', schemaStatements.length, 'SQL statements in schema.sql.');
    console.log('Found', trustApiStatements.length, 'SQL statements in schema-trust-api.sql.');

    await client.query('BEGIN');
    await runStatements(client, schemaStatements, 'schema');
    await runStatements(client, trustApiStatements, 'trust-api');
    await client.query('COMMIT');
    console.log('Schema migration completed successfully.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    process.exitCode = 1;
  } finally {
    client.release();
    if (closePool) {
      await pool.end();
      console.log('Database connection closed.');
    }
  }
}


module.exports = { migrate };

// `node db/migrate.js` / `npm run migrate` must actually migrate — this file
// previously only exported the function, so every deploy-time migration was a
// silent no-op and the production schema drifted behind the code.
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration crashed:', err);
    process.exit(1);
  });
}