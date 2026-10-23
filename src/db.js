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
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,
    enrolled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS enrollment_codes (
    code TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  // At most one walkthrough may be in progress; concurrent starts race on the
  // check-then-insert in startWalkthrough(), so the database enforces it.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_walkthroughs_single_active
    ON walkthroughs (status) WHERE status = 'in_progress'`,
];

async function initSchema() {
  // A local file can briefly be shared by two processes (e.g. old and new
  // container during a deploy): wait for the other's write instead of
  // failing with SQLITE_BUSY. The client keeps this one connection open.
  if (!remoteUrl) await client.execute('PRAGMA busy_timeout = 5000');
  await client.batch(SCHEMA_STATEMENTS, 'write');
  // Columns added after the first release:
  //  - linked: a physical chip has been bound to the checkpoint's code
  //  - placeholder: created by a restore tool without a real name; the
  //    tap-to-link flow may delete it when its chip gets a real checkpoint
  // Each column is added together with its backfill in one transaction, so an
  // interrupted start can't leave a column without its values. When another
  // process adds them first, the transaction rolls back and we look again.
  for (let attempt = 0; ; attempt++) {
    const info = await client.execute('PRAGMA table_info(checkpoints)');
    const has = (col) => info.rows.some((r) => r.name === col);
    const steps = [];
    if (!has('placeholder')) {
      steps.push('ALTER TABLE checkpoints ADD COLUMN placeholder INTEGER NOT NULL DEFAULT 0');
      // Rows from the earlier restore tools carried their placeholder status
      // only in the name.
      steps.push(`UPDATE checkpoints SET placeholder = 1 WHERE ${PLACEHOLDER_NAME_SQL}`);
    }
    if (!has('linked')) {
      steps.push('ALTER TABLE checkpoints ADD COLUMN linked INTEGER NOT NULL DEFAULT 0');
      // Checkpoints from before this column existed were written to chips from
      // the tag sheet, so their codes are already bound to physical chips.
      steps.push('UPDATE checkpoints SET linked = 1 WHERE placeholder = 0');
    }
    if (!steps.length) return;
    try {
      await client.batch(steps, 'write');
      return;
    } catch (err) {
      if (attempt < 2 && /duplicate column/i.test(err.message)) continue;
      throw err;
    }
  }
}

// The same names isPlaceholderName() accepts: "Checkpoint <digits>" or
// "Tag <6-16 hex>", whole name, any case.
const PLACEHOLDER_NAME_SQL = `(
  (lower(trim(name)) GLOB 'checkpoint [0-9]*' AND substr(trim(name), 12) NOT GLOB '*[^0-9]*')
  OR (lower(trim(name)) GLOB 'tag [0-9a-f]*' AND length(trim(name)) BETWEEN 10 AND 20
      AND lower(substr(trim(name), 5)) NOT GLOB '*[^0-9a-f]*')
)`;

// Lazy init: schema creation runs once, before the first query. A failed
// attempt must not stay cached, or one startup blip poisons the process.
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = initSchema();
    ready.catch(() => {
      ready = null;
    });
  }
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
  // Device limiting: when '1', guard pages only work on enrolled devices.
  require_enrolled_device: '0',
  max_devices: '2',
  // Email notifications via Mailchimp Transactional (Mandrill) or SMTP.
  notify_email: '',
  mailchimp_api_key: '',
  mailchimp_from_email: '',
  smtp_host: '',
  smtp_port: '',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  brevo_api_key: '',
  brevo_from_email: '',
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
    // Two cold-starting instances can race here; DO NOTHING + re-read makes
    // both cache whichever secret actually won, so cookies verify everywhere.
    const value = crypto.randomBytes(32).toString('hex');
    await client.execute({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      args: ['cookie_secret', value],
    });
    const winner = await client.execute({
      sql: 'SELECT value FROM settings WHERE key = ?',
      args: ['cookie_secret'],
    });
    cookieSecret = winner.rows[0].value;
  }
  return cookieSecret;
}

// --- checkpoints ----------------------------------------------------------

function newCheckpointId() {
  // Short, unambiguous id that goes into the NFC tag URL.
  return crypto.randomBytes(4).toString('hex');
}

// is_linked: a chip has been bound to the checkpoint (through the link flow,
// a restore line naming its code, or a tap of its URL). Scans alone do not
// count: a re-linked checkpoint keeps its old scans but has no chip.
async function listCheckpoints(activeOnly = false) {
  await ensureReady();
  const where = activeOnly ? 'WHERE c.active = 1' : '';
  const rs = await client.execute(
    `SELECT c.*, c.linked AS is_linked FROM checkpoints c ${where} ORDER BY c.sort_order, c.name`
  );
  return rs.rows;
}

async function getCheckpoint(id) {
  await ensureReady();
  const rs = await client.execute({
    sql: 'SELECT c.*, c.linked AS is_linked FROM checkpoints c WHERE c.id = ?',
    args: [id],
  });
  return rs.rows[0];
}

// customId lets a checkpoint be restored under the exact code already
// written inside a physical NFC chip; returns null if that code is taken.
async function addCheckpoint(name, location, customId, { placeholder = false } = {}) {
  await ensureReady();
  const id = customId ? String(customId).toLowerCase() : newCheckpointId();
  const maxRs = await client.execute('SELECT COALESCE(MAX(sort_order), 0) AS m FROM checkpoints');
  const max = maxRs.rows[0].m;
  const rs = await client.execute({
    sql: 'INSERT INTO checkpoints (id, name, location, sort_order, placeholder) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    args: [id, name, location || '', max + 1, placeholder ? 1 : 0],
  });
  if (rs.rowsAffected === 0) return null;
  return getCheckpoint(id);
}

async function updateCheckpoint(id, fields) {
  await ensureReady();
  const cp = await getCheckpoint(id);
  if (!cp) return null;
  const pick = (key, fallback) => (fields[key] !== undefined ? fields[key] : fallback);
  await client.execute({
    sql: 'UPDATE checkpoints SET name = ?, location = ?, active = ?, placeholder = ? WHERE id = ?',
    args: [
      pick('name', cp.name),
      pick('location', cp.location),
      fields.active !== undefined ? (fields.active ? 1 : 0) : cp.active,
      fields.placeholder !== undefined ? (fields.placeholder ? 1 : 0) : cp.placeholder,
      id,
    ],
  });
  return getCheckpoint(id);
}

async function markLinked(id) {
  await ensureReady();
  await client.execute({ sql: 'UPDATE checkpoints SET linked = 1 WHERE id = ? AND linked = 0', args: [id] });
}

async function deleteCheckpoint(id) {
  await ensureReady();
  await client.execute({ sql: 'DELETE FROM checkpoints WHERE id = ?', args: [id] });
}

// Names the earlier restore tools gave checkpoints whose real name was not
// known. Only used to read legacy rows; new rows carry the placeholder column.
function isPlaceholderName(name) {
  return /^(checkpoint \d+|tag [0-9a-f]{6,16})$/i.test(String(name || '').trim());
}

function isTagCode(code) {
  return /^[0-9a-f]{6,16}$/.test(String(code || ''));
}

// Binds a physical chip's code to an existing checkpoint by re-keying the
// checkpoint to that code. Recorded rounds never lose rows:
//  - a placeholder that held the code is removed and its scans (taps of
//    this very chip under a stand-in name) now belong to the target;
//  - a real checkpoint that held the code moves, with its scans, to a fresh
//    unlinked code, so past rounds keep showing what was reported then;
//  - the target's own scans follow it to the code. If the target and a
//    placeholder were both scanned in the same round, the target's older
//    row stays under its old id rather than being deleted.
async function linkTag(code, checkpointId) {
  await ensureReady();
  code = String(code || '').toLowerCase();
  if (!isTagCode(code)) return null;
  const target = await getCheckpoint(checkpointId);
  if (!target) return null;

  const statements = [];
  if (target.id !== code) {
    const holder = await getCheckpoint(code);
    if (holder) {
      if (holder.placeholder) {
        statements.push({ sql: 'DELETE FROM checkpoints WHERE id = ?', args: [code] });
      } else {
        const fresh = newCheckpointId();
        statements.push({ sql: 'UPDATE checkpoints SET id = ?, linked = 0 WHERE id = ?', args: [fresh, code] });
        statements.push({ sql: 'UPDATE scans SET checkpoint_id = ? WHERE checkpoint_id = ?', args: [fresh, code] });
      }
    }
    statements.push({
      sql: 'UPDATE OR IGNORE scans SET checkpoint_id = ? WHERE checkpoint_id = ?',
      args: [code, target.id],
    });
    statements.push({
      sql: 'UPDATE checkpoints SET id = ?, linked = 1, placeholder = 0 WHERE id = ?',
      args: [code, target.id],
    });
  } else {
    statements.push({ sql: 'UPDATE checkpoints SET linked = 1 WHERE id = ?', args: [code] });
  }
  await client.batch(statements, 'write');
  return getCheckpoint(code);
}

// Checkpoints offered when linking a chip: real (non-placeholder) active
// ones, flagged by whether a chip is already bound to them.
async function listLinkCandidates() {
  return (await listCheckpoints(true)).filter((c) => !c.placeholder);
}

// Puts checkpoints back exactly as a replaceAllCheckpoints backup recorded
// them (same codes, names, locations, order), all bound to their chips.
// flagKey is inserted first with a plain INSERT so this runs at most once.
async function restoreCheckpointsFromBackup(rows, { flagKey } = {}) {
  await ensureReady();
  const statements = [];
  if (flagKey) {
    statements.push({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', args: [flagKey, nowIso()] });
  }
  statements.push('DELETE FROM checkpoints');
  rows.forEach((row, i) => {
    statements.push({
      sql: 'INSERT INTO checkpoints (id, name, location, sort_order, linked, placeholder) VALUES (?, ?, ?, ?, 1, ?)',
      args: [String(row.id), String(row.name), String(row.location || ''), i + 1, isPlaceholderName(row.name) ? 1 : 0],
    });
  });
  await client.batch(statements, 'write');
  return rows.length;
}

// Replaces every checkpoint with the given names, in order, all unlinked,
// in one transaction:
//  - flagKey is inserted first with a plain INSERT, so a second (or
//    concurrent) run fails on the primary key and rolls back entirely —
//    the replace and its "done" marker commit together or not at all;
//  - backupKey keeps a JSON snapshot of the old rows (which code was which
//    place), the only record of that mapping once they are deleted;
//  - an in-progress walkthrough is cancelled so it cannot expire against
//    the new list and raise a false missed-checkpoints alert.
async function replaceAllCheckpoints(names, { flagKey, backupKey } = {}) {
  await ensureReady();
  const before = (await client.execute('SELECT COUNT(*) AS n FROM checkpoints')).rows[0].n;
  const now = nowIso();
  const statements = [];
  if (flagKey) {
    statements.push({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', args: [flagKey, now] });
  }
  if (backupKey) {
    statements.push({
      sql: `INSERT OR REPLACE INTO settings (key, value)
            SELECT ?, COALESCE(json_group_array(json_object('id', id, 'name', name, 'location', location)), '[]')
            FROM checkpoints`,
      args: [backupKey],
    });
  }
  statements.push({
    sql: "UPDATE walkthroughs SET status = 'cancelled', completed_at = ? WHERE status = 'in_progress'",
    args: [now],
  });
  statements.push('DELETE FROM checkpoints');
  names.forEach((name, i) => {
    statements.push({
      sql: 'INSERT INTO checkpoints (id, name, location, sort_order, linked, placeholder) VALUES (?, ?, ?, ?, 0, 0)',
      args: [newCheckpointId(), name, '', i + 1],
    });
  });
  await client.batch(statements, 'write');
  return { removed: before, created: names.length };
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
  const parsedDuration = parseInt(await getSetting('walk_duration_minutes'), 10);
  const durationMin = Number.isNaN(parsedDuration) ? 60 : parsedDuration;
  // 0 (or negative) means no time limit: an empty deadline is never enforced.
  const deadline =
    durationMin > 0 ? new Date(started.getTime() + durationMin * 60 * 1000).toISOString() : '';
  const total = (await listCheckpoints(true)).length;
  // The single-active unique index rejects a second in_progress row; DO
  // NOTHING makes a concurrent start lose quietly, then we return the winner.
  await client.execute({
    sql: 'INSERT INTO walkthroughs (id, guard_name, started_at, deadline, total_checkpoints) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    args: [id, guardName || '', started.toISOString(), deadline, total],
  });
  return (await getWalkthrough(id)) || getActiveWalkthrough();
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

// --- dashboard statistics ---------------------------------------------------

// Rounds started since a moment, with how many checkpoints each recorded
// and when its last scan was.
async function walkthroughsSince(sinceIso) {
  await ensureReady();
  const rs = await client.execute({
    sql: `SELECT w.*,
              (SELECT COUNT(*) FROM scans s WHERE s.walkthrough_id = w.id) AS scanned_count,
              (SELECT MAX(s.scanned_at) FROM scans s WHERE s.walkthrough_id = w.id) AS last_scan_at
       FROM walkthroughs w WHERE w.started_at >= ? ORDER BY w.started_at DESC`,
    args: [sinceIso],
  });
  return rs.rows;
}

async function scanTimesSince(sinceIso) {
  await ensureReady();
  const rs = await client.execute({ sql: 'SELECT scanned_at FROM scans WHERE scanned_at >= ?', args: [sinceIso] });
  return rs.rows.map((r) => r.scanned_at);
}

// Active checkpoints most often left unscanned by rounds that ended
// incomplete — counting only rounds that began after the checkpoint existed.
async function mostMissedCheckpoints(sinceIso, limit = 5) {
  await ensureReady();
  const rs = await client.execute({
    sql: `SELECT c.id, c.name, c.location, COUNT(*) AS missed
       FROM walkthroughs w JOIN checkpoints c ON c.active = 1 AND c.created_at <= w.started_at
       WHERE w.status = 'incomplete' AND w.started_at >= ?
         AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.walkthrough_id = w.id AND s.checkpoint_id = c.id)
       GROUP BY c.id ORDER BY missed DESC, c.sort_order, c.name LIMIT ?`,
    args: [sinceIso, limit],
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

async function alertsForWalkthrough(walkthroughId) {
  await ensureReady();
  const rs = await client.execute({
    sql: 'SELECT * FROM alerts WHERE walkthrough_id = ? ORDER BY created_at',
    args: [walkthroughId],
  });
  return rs.rows;
}

async function acknowledgeAlert(id) {
  await ensureReady();
  await client.execute({ sql: 'UPDATE alerts SET acknowledged = 1 WHERE id = ?', args: [id] });
}

// --- devices (two-phone access limit) --------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function listDevices() {
  await ensureReady();
  const rs = await client.execute('SELECT id, name, enrolled_at, last_seen FROM devices ORDER BY enrolled_at');
  return rs.rows;
}

async function countDevices() {
  await ensureReady();
  const rs = await client.execute('SELECT COUNT(*) AS n FROM devices');
  return rs.rows[0].n;
}

// Creates a one-time enrollment code valid for 30 minutes.
async function createEnrollmentCode() {
  await ensureReady();
  const code = crypto.randomBytes(8).toString('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await client.execute({
    sql: 'INSERT INTO enrollment_codes (code, expires_at) VALUES (?, ?)',
    args: [code, expires],
  });
  return code;
}

// Marks the code used; returns false when unknown, already used, or expired.
// The single UPDATE ... WHERE used = 0 makes two phones racing on the same
// code resolve to exactly one winner.
async function consumeEnrollmentCode(code) {
  await ensureReady();
  const rs = await client.execute({
    sql: 'UPDATE enrollment_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at > ?',
    args: [code, nowIso()],
  });
  return rs.rowsAffected === 1;
}

// Registers a device and returns {id, token}; only the token's hash is stored,
// the raw token lives solely in the phone's cookie.
async function addDevice(name) {
  await ensureReady();
  const id = crypto.randomBytes(4).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  await client.execute({
    sql: 'INSERT INTO devices (id, name, token_hash) VALUES (?, ?, ?)',
    args: [id, name || '', sha256(token)],
  });
  return { id, token };
}

async function validateDevice(id, token) {
  await ensureReady();
  const rs = await client.execute({ sql: 'SELECT * FROM devices WHERE id = ?', args: [id] });
  const device = rs.rows[0];
  if (!device || typeof token !== 'string') return null;
  const expected = Buffer.from(device.token_hash);
  const actual = Buffer.from(sha256(token));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return device;
}

async function touchDevice(id) {
  await ensureReady();
  await client.execute({ sql: 'UPDATE devices SET last_seen = ? WHERE id = ?', args: [nowIso(), id] });
}

async function deleteDevice(id) {
  await ensureReady();
  await client.execute({ sql: 'DELETE FROM devices WHERE id = ?', args: [id] });
}

// --- web push subscriptions -------------------------------------------------

async function addPushSubscription(endpoint, p256dh, auth, label) {
  await ensureReady();
  await client.execute({
    sql: `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label) VALUES (?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
    args: [endpoint, p256dh, auth, label || ''],
  });
}

async function listPushSubscriptions() {
  await ensureReady();
  const rs = await client.execute('SELECT * FROM push_subscriptions');
  return rs.rows;
}

async function deletePushSubscription(endpoint) {
  await ensureReady();
  await client.execute({ sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [endpoint] });
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
  isPlaceholderName,
  isTagCode,
  markLinked,
  linkTag,
  listLinkCandidates,
  replaceAllCheckpoints,
  restoreCheckpointsFromBackup,
  getActiveWalkthrough,
  startWalkthrough,
  recordScan,
  getScans,
  getMissingCheckpoints,
  finishWalkthrough,
  listWalkthroughs,
  walkthroughsSince,
  scanTimesSince,
  mostMissedCheckpoints,
  getWalkthrough,
  addAlert,
  listAlerts,
  unacknowledgedAlerts,
  alertsForWalkthrough,
  acknowledgeAlert,
  listDevices,
  countDevices,
  createEnrollmentCode,
  consumeEnrollmentCode,
  addDevice,
  validateDevice,
  touchDevice,
  deleteDevice,
  addPushSubscription,
  listPushSubscriptions,
  deletePushSubscription,
  rawExecute,
};
