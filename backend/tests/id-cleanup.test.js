const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { idFileCleanup } = require('../jobs/idFileCleanup');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semacheck-id-'));
}

function fakePool(rows) {
  const updates = [];
  return {
    updates,
    async query(sql, params) {
      if (/SELECT id, id_document_filename/.test(sql)) return { rows };
      if (/UPDATE users SET id_document_deleted_at/.test(sql)) {
        updates.push(params[0]);
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('deletes the file and records the deletion date', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'abc123.png'), 'x');
  const pool = fakePool([{ id: 1, id_document_filename: 'abc123.png' }]);

  const deleted = await idFileCleanup(pool, { dir, days: 30 });
  assert.equal(deleted, 1);
  assert.equal(fs.existsSync(path.join(dir, 'abc123.png')), false);
  assert.deepEqual(pool.updates, [1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dry run reports the count without deleting or marking anything', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'keep.png'), 'x');
  const pool = fakePool([{ id: 2, id_document_filename: 'keep.png' }]);

  const deleted = await idFileCleanup(pool, { dir, days: 30, dryRun: true });
  assert.equal(deleted, 1);
  assert.equal(fs.existsSync(path.join(dir, 'keep.png')), true);
  assert.deepEqual(pool.updates, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stored path cannot escape the upload directory', async () => {
  const dir = tempDir();
  const outside = path.join(dir, '..', 'escaped.png');
  fs.writeFileSync(outside, 'x');
  const pool = fakePool([{ id: 3, id_document_filename: '../../escaped.png' }]);

  const deleted = await idFileCleanup(pool, { dir, days: 30 });
  // Only the basename is ever used, so nothing outside the upload directory
  // can be removed. The row itself is still marked as cleaned.
  assert.equal(deleted, 1);
  assert.equal(fs.existsSync(outside), true, 'a stored path must never delete outside the upload folder');
  assert.deepEqual(pool.updates, [3]);
  fs.rmSync(outside, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that is already gone is still marked as cleaned', async () => {
  const dir = tempDir();
  const pool = fakePool([{ id: 4, id_document_filename: 'missing.png' }]);

  const deleted = await idFileCleanup(pool, { dir, days: 30 });
  assert.equal(deleted, 1);
  assert.deepEqual(pool.updates, [4]);
  fs.rmSync(dir, { recursive: true, force: true });
});
