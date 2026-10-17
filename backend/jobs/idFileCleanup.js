'use strict';
// backend/jobs/idFileCleanup.js — run daily
// Deletes uploaded ID documents once review is finished and the retention
// period has passed. The Privacy Policy states the same period, so keep
// ID_DOC_RETENTION_DAYS (default 30) and the policy text in step.
//
// The job is safe to run repeatedly: it records id_document_deleted_at, and a
// row whose file is already gone (ENOENT) is still marked as cleaned.
const fs = require('fs');
const path = require('path');
const RETENTION_DAYS = parseInt(process.env.ID_DOC_RETENTION_DAYS, 10) || 30;
const UPLOAD_DIR = process.env.ID_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'id-documents');

async function idFileCleanup(pool, { dir = UPLOAD_DIR, days = RETENTION_DAYS, dryRun = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, id_document_filename
     FROM users
     WHERE id_document_filename IS NOT NULL
       AND id_document_deleted_at IS NULL
       AND id_verification_status IN ('approved', 'rejected')
       AND id_verification_reviewed_at < NOW() - ($1::int * INTERVAL '1 day')
     LIMIT 200`, [days]);

  let deleted = 0;
  for (const row of rows) {
    const name = path.basename(row.id_document_filename);          // never trust a stored path
    const full = path.join(dir, name);
    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) continue;   // must stay inside the upload folder
    if (!dryRun) {
      try {
        await fs.promises.unlink(full);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('[idCleanup]', e.message);
          continue;
        }
      }
      await pool.query('UPDATE users SET id_document_deleted_at = NOW() WHERE id = $1', [row.id]);
    }
    deleted += 1;
  }
  return deleted;
}

async function run(options = {}) {
  const pool = require('../db/pool');
  return idFileCleanup(pool, options);
}

if (require.main === module) {
  require('dotenv').config();
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((n) => {
      console.log(`[idCleanup] ${dryRun ? 'would delete' : 'deleted'} ${n} ID document(s) (retention ${RETENTION_DAYS} days).`);
      if (dryRun) console.log('[idCleanup] dry run only — nothing was removed or marked.');
    })
    .catch((err) => {
      console.error('[idCleanup] failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => require('../db/pool').end().catch(() => {}));
}

module.exports = { idFileCleanup, RETENTION_DAYS, UPLOAD_DIR };
