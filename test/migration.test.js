'use strict';

// Upgrading a database written by a release from before the `linked` and
// `placeholder` columns. Run with: npm test

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@libsql/client');

const ROOT = path.join(__dirname, '..');

// The checkpoints table as the older releases created it.
const LEGACY_SCHEMA = `CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

const NAMES = [
  // Real names, including ones that only start like a generated name.
  ['9ca11c86', 'კარტინგების წითელი მოედანი'],
  ['73c93251', 'რეკოპერატორი 11'],
  ['a0000001', 'Tag a-block door'],
  ['a0000002', 'Checkpoint 1st floor'],
  ['a0000003', 'Tag 5 Gym'],
  ['a0000004', 'Tag cafe'],
  ['a0000005', 'Tag 0123456789abcdef0'],
  ['a0000006', 'Checkpoint'],
  // Names the earlier restore tools generated.
  ['63f91d85', 'Tag 63f91d85'],
  ['a0000007', 'Checkpoint 7'],
  ['a0000008', 'TAG ABCDEF'],
  ['a0000009', '  Checkpoint 12  '],
  ['a000000a', 'Tag 0123456789abcdef'],
];

async function legacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-tag-migrate-'));
  const client = createClient({ url: 'file:' + path.join(dir, 'school-tag.db') });
  await client.execute(LEGACY_SCHEMA);
  for (const [i, [id, name]] of NAMES.entries()) {
    await client.execute({ sql: 'INSERT INTO checkpoints (id, name, sort_order) VALUES (?, ?, ?)', args: [id, name, i] });
  }
  client.close();
  return dir;
}

// Opens the database in a fresh process, as a deploy does.
function boot(dir) {
  const script = `require('./src/db').listCheckpoints()
    .then((rows) => process.stdout.write(JSON.stringify(rows)))
    .catch((err) => { console.error(err); process.exit(1); });`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout))
    );
  });
}

test('upgrade keeps every row and flags placeholders by the same rule as isPlaceholderName', async () => {
  const { isPlaceholderName } = require('../src/db');
  const dir = await legacyDb();
  const rows = await boot(dir);

  assert.deepEqual(rows.map((r) => [r.id, r.name]), NAMES);
  for (const r of rows) {
    const expected = isPlaceholderName(r.name) ? 1 : 0;
    assert.equal(r.placeholder, expected, `placeholder for ${JSON.stringify(r.name)}`);
    assert.equal(r.linked, 1 - expected, `linked for ${JSON.stringify(r.name)}`);
  }
  assert.equal(rows.filter((r) => r.placeholder).length, 5);

  // A second start changes nothing.
  assert.deepEqual(await boot(dir), rows);
});

test('processes starting at the same time on a legacy database all succeed with one result', async () => {
  const dir = await legacyDb();
  const results = await Promise.all([boot(dir), boot(dir), boot(dir)]);
  for (const rows of results.slice(1)) assert.deepEqual(rows, results[0]);
  assert.equal(results[0].filter((r) => r.linked).length, NAMES.length - 5);
});
