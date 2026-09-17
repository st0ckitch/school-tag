'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'school-tag.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS walkthroughs (
    id TEXT PRIMARY KEY,
    guard_name TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed | incomplete
    total_checkpoints INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walkthrough_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (walkthrough_id, checkpoint_id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walkthrough_id TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    acknowledged INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

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

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] !== undefined ? DEFAULT_SETTINGS[key] : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Secret used to sign the admin session cookie; generated once per database.
function getCookieSecret() {
  let secret = db.prepare('SELECT value FROM settings WHERE key = ?').get('cookie_secret');
  if (!secret) {
    const value = crypto.randomBytes(32).toString('hex');
    setSetting('cookie_secret', value);
    return value;
  }
  return secret.value;
}

// --- checkpoints ----------------------------------------------------------

function newCheckpointId() {
  // Short, unambiguous id that goes into the NFC tag URL.
  return crypto.randomBytes(4).toString('hex');
}

function listCheckpoints(activeOnly = false) {
  const where = activeOnly ? 'WHERE active = 1' : '';
  return db.prepare(`SELECT * FROM checkpoints ${where} ORDER BY sort_order, name`).all();
}

function getCheckpoint(id) {
  return db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id);
}

function addCheckpoint(name, location) {
  const id = newCheckpointId();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM checkpoints').get().m;
  db.prepare('INSERT INTO checkpoints (id, name, location, sort_order) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    location || '',
    max + 1
  );
  return getCheckpoint(id);
}

function updateCheckpoint(id, fields) {
  const cp = getCheckpoint(id);
  if (!cp) return null;
  db.prepare('UPDATE checkpoints SET name = ?, location = ?, active = ? WHERE id = ?').run(
    fields.name !== undefined ? fields.name : cp.name,
    fields.location !== undefined ? fields.location : cp.location,
    fields.active !== undefined ? (fields.active ? 1 : 0) : cp.active,
    id
  );
  return getCheckpoint(id);
}

function deleteCheckpoint(id) {
  db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
}

// --- walkthroughs ---------------------------------------------------------

function getActiveWalkthrough() {
  return db
    .prepare("SELECT * FROM walkthroughs WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 1")
    .get();
}

function startWalkthrough(guardName) {
  const active = getActiveWalkthrough();
  if (active) return active;
  const id = crypto.randomBytes(6).toString('hex');
  const started = new Date();
  const durationMin = parseInt(getSetting('walk_duration_minutes'), 10) || 60;
  const deadline = new Date(started.getTime() + durationMin * 60 * 1000);
  const total = listCheckpoints(true).length;
  db.prepare(
    'INSERT INTO walkthroughs (id, guard_name, started_at, deadline, total_checkpoints) VALUES (?, ?, ?, ?, ?)'
  ).run(id, guardName || '', started.toISOString(), deadline.toISOString(), total);
  return db.prepare('SELECT * FROM walkthroughs WHERE id = ?').get(id);
}

function recordScan(walkthroughId, checkpointId) {
  db.prepare(
    'INSERT INTO scans (walkthrough_id, checkpoint_id, scanned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
  ).run(walkthroughId, checkpointId, nowIso());
}

function getScans(walkthroughId) {
  return db
    .prepare(
      `SELECT s.*, c.name AS checkpoint_name, c.location AS checkpoint_location
       FROM scans s LEFT JOIN checkpoints c ON c.id = s.checkpoint_id
       WHERE s.walkthrough_id = ? ORDER BY s.scanned_at`
    )
    .all(walkthroughId);
}

function getMissingCheckpoints(walkthroughId) {
  return db
    .prepare(
      `SELECT c.* FROM checkpoints c
       WHERE c.active = 1
         AND c.id NOT IN (SELECT checkpoint_id FROM scans WHERE walkthrough_id = ?)
       ORDER BY c.sort_order, c.name`
    )
    .all(walkthroughId);
}

function finishWalkthrough(walkthroughId, status) {
  db.prepare('UPDATE walkthroughs SET status = ?, completed_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    walkthroughId
  );
}

function listWalkthroughs(limit = 30) {
  return db
    .prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM scans s WHERE s.walkthrough_id = w.id) AS scanned_count
       FROM walkthroughs w ORDER BY w.started_at DESC LIMIT ?`
    )
    .all(limit);
}

function getWalkthrough(id) {
  return db.prepare('SELECT * FROM walkthroughs WHERE id = ?').get(id);
}

// --- alerts ---------------------------------------------------------------

function addAlert(walkthroughId, type, message) {
  db.prepare('INSERT INTO alerts (walkthrough_id, type, message) VALUES (?, ?, ?)').run(
    walkthroughId,
    type,
    message
  );
}

function listAlerts(limit = 50) {
  return db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit);
}

function unacknowledgedAlerts() {
  return db.prepare('SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC').all();
}

function acknowledgeAlert(id) {
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

module.exports = {
  db,
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
};
