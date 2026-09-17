'use strict';

const { createClient } = require('@libsql/client');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Remote (Turso / libsql server) when configured, local file otherwise.
const remoteUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';

let client;
if (remoteUrl) {
  client = createClient({ url: remoteUrl, authToken: process.env.TURSO_AUTH_TOKEN });
} else {
  const DATA_DIR =
    process.env.DATA_DIR ||
    (process.env.VERCEL ? '/tmp/school-tag-data' : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (process.env.VERCEL) {
    console.error(
      '[db] WARNING: running on Vercel without TURSO_DATABASE_URL/LIBSQL_URL — using an ' +
        'ephemeral /tmp database. Data WILL NOT persist between invocations. Set the ' +
        'TURSO_DATABASE_URL and TURSO_AUTH_TOKEN environment variables.'
    );
  }
  client = createClient({ url: 'file:' + path.join(DATA_DIR, 'school-tag.db') });
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS walkthroughs (
    id TEXT PRIMARY KEY,
    guard_name TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed | incomplete
    total_checkpoints INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walkthrough_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (walkthrough_id, checkpoint_id)
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walkthrough_id TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    acknowledged INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

async function initSchema() {
  await client.batch(SCHEMA_STATEMENTS, 'write');
}

// Lazy init: schema creation runs once, before the first query.
let ready = null;
function ensureReady() {
  ready ??= initSchema();
  return ready;
}

function nowIso() {
  return new Date().toISOString();
}

// --- settings -------------------------------------------------------------

const DEFAULT_SETTINGS = {
  walk_duration_minutes: '60',
  admin_pin: '1234',
  ntfy_topic: '',
  webhook_url: '',
  base_url: '',
};

async function getSetting(key) {
  await ensureReady();
  const rs = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  const row = rs.rows[0];
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] !== undefined ? DEFAULT_SETTINGS[key] : null;
}

async function setSetting(key, value) {
  await ensureReady();
  await client.execute({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, String(value)],
  });
}

// Secret used to sign the admin session cookie; generated once per database
// and cached in memory after the first load.
let cookieSecret = null;

async function getCookieSecret() {
  if (cookieSecret) return cookieSecret;
  await ensureReady();
  const rs = await client.execute({
    sql: 'SELECT value FROM settings WHERE key = ?',
    args: ['cookie_secret'],
  });
  const row = rs.rows[0];
  if (row) {
    cookieSecret = row.value;
  } else {
    const value = crypto.randomBytes(32).toString('hex');
    await setSetting('cookie_secret', value);
    cookieSecret = value;
  }
  return cookieSecret;
}

// --- checkpoints ----------------------------------------------------------

function newCheckpointId() {
  // Short, unambiguous id that goes into the NFC tag URL.
  return crypto.randomBytes(4).toString('hex');
}

async function listCheckpoints(activeOnly = false) {
  await ensureReady();
  const where = activeOnly ? 'WHERE active = 1' : '';
  const rs = await client.execute(`SELECT * FROM checkpoints ${where} ORDER BY sort_order, name`);
  return rs.rows;
}

async function getCheckpoint(id) {
  await ensureReady();
  const rs = await client.execute({ sql: 'SELECT * FROM checkpoints WHERE id = ?', args: [id] });
  return rs.rows[0];
}

async function addCheckpoint(name, location) {
  await ensureReady();
  const id = newCheckpointId();
  const maxRs = await client.execute('SELECT COALESCE(MAX(sort_order), 0) AS m FROM checkpoints');
  const max = maxRs.rows[0].m;
  await client.execute({
    sql: 'INSERT INTO checkpoints (id, name, location, sort_order) VALUES (?, ?, ?, ?)',
    args: [id, name, location || '', max + 1],
  });
  return getCheckpoint(id);
}

async function updateCheckpoint(id, fields) {
  await ensureReady();
  const cp = await getCheckpoint(id);
  if (!cp) return null;
  await client.execute({
    sql: 'UPDATE checkpoints SET name = ?, location = ?, active = ? WHERE id = ?',
    args: [
      fields.name !== undefined ? fields.name : cp.name,
      fields.location !== undefined ? fields.location : cp.location,
      fields.active !== undefined ? (fields.active ? 1 : 0) : cp.active,
      id,
    ],
  });
  return getCheckpoint(id);
}

async function deleteCheckpoint(id) {
  await ensureReady();
  await client.execute({ sql: 'DELETE FROM checkpoints WHERE id = ?', args: [id] });
}

// --- walkthroughs ---------------------------------------------------------

async function getActiveWalkthrough() {
  await ensureReady();
  const rs = await client.execute(
    "SELECT * FROM walkthroughs WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 1"
  );
  return rs.rows[0];
}

async function startWalkthrough(guardName) {
  await ensureReady();
  const active = await getActiveWalkthrough();
  if (active) return active;
  const id = crypto.randomBytes(6).toString('hex');
  const started = new Date();
  const durationMin = parseInt(await getSetting('walk_duration_minutes'), 10) || 60;
  const deadline = new Date(started.getTime() + durationMin * 60 * 1000);
  const total = (await listCheckpoints(true)).length;
  await client.execute({
    sql: 'INSERT INTO walkthroughs (id, guard_name, started_at, deadline, total_checkpoints) VALUES (?, ?, ?, ?, ?)',
    args: [id, guardName || '', started.toISOString(), deadline.toISOString(), total],
  });
  return getWalkthrough(id);
}

async function recordScan(walkthroughId, checkpointId) {
  await ensureReady();
  await client.execute({
    sql: 'INSERT INTO scans (walkthrough_id, checkpoint_id, scanned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    args: [walkthroughId, checkpointId, nowIso()],
  });
}

async function getScans(walkthroughId) {
  await ensureReady();
  const rs = await client.execute({
    sql: `SELECT s.*, c.name AS checkpoint_name, c.location AS checkpoint_location
       FROM scans s LEFT JOIN checkpoints c ON c.id = s.checkpoint_id
       WHERE s.walkthrough_id = ? ORDER BY s.scanned_at`,
    args: [walkthroughId],
  });
  return rs.rows;
}

async function getMissingCheckpoints(walkthroughId) {
  await ensureReady();
  const rs = await client.execute({
    sql: `SELECT c.* FROM checkpoints c
       WHERE c.active = 1
         AND c.id NOT IN (SELECT checkpoint_id FROM scans WHERE walkthrough_id = ?)
       ORDER BY c.sort_order, c.name`,
    args: [walkthroughId],
  });
  return rs.rows;
}

async function finishWalkthrough(walkthroughId, status) {
  await ensureReady();
  await client.execute({
    sql: 'UPDATE walkthroughs SET status = ?, completed_at = ? WHERE id = ?',
    args: [status, nowIso(), walkthroughId],
  });
}

async function listWalkthroughs(limit = 30) {
  await ensureReady();
  const rs = await client.execute({
    sql: `SELECT w.*,
              (SELECT COUNT(*) FROM scans s WHERE s.walkthrough_id = w.id) AS scanned_count
       FROM walkthroughs w ORDER BY w.started_at DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows;
}

async function getWalkthrough(id) {
  await ensureReady();
  const rs = await client.execute({ sql: 'SELECT * FROM walkthroughs WHERE id = ?', args: [id] });
  return rs.rows[0];
}

// --- alerts ---------------------------------------------------------------

async function addAlert(walkthroughId, type, message) {
  await ensureReady();
  await client.execute({
    sql: 'INSERT INTO alerts (walkthrough_id, type, message) VALUES (?, ?, ?)',
    args: [walkthroughId, type, message],
  });
}

async function listAlerts(limit = 50) {
  await ensureReady();
  const rs = await client.execute({
    sql: 'SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?',
    args: [limit],
  });
  return rs.rows;
}

async function unacknowledgedAlerts() {
  await ensureReady();
  const rs = await client.execute('SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC');
  return rs.rows;
}

async function acknowledgeAlert(id) {
  await ensureReady();
  await client.execute({ sql: 'UPDATE alerts SET acknowledged = 1 WHERE id = ?', args: [id] });
}

// Escape hatch for tests/tooling.
async function rawExecute(sql, args = []) {
  await ensureReady();
  return client.execute({ sql, args });
}

module.exports = {
  client,
  nowIso,
  getSetting,
  setSetting,
  getCookieSecret,
  listCheckpoints,
  getCheckpoint,
  addCheckpoint,
  updateCheckpoint,
  deleteCheckpoint,
  getActiveWalkthrough,
  startWalkthrough,
  recordScan,
  getScans,
  getMissingCheckpoints,
  finishWalkthrough,
  listWalkthroughs,
  getWalkthrough,
  addAlert,
  listAlerts,
  unacknowledgedAlerts,
  acknowledgeAlert,
  rawExecute,
};
