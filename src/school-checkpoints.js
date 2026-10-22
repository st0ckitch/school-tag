'use strict';

// The school's checkpoint list. It is only ever used to fill an EMPTY
// database: once checkpoints exist (codes bound to real chips), they are
// never deleted or replaced by this module.

const {
  getSetting,
  setSetting,
  listCheckpoints,
  replaceAllCheckpoints,
  restoreCheckpointsFromBackup,
  isPlaceholderName,
} = require('./db');

const SCHOOL_CHECKPOINTS = [
  'კარტინგების წითელი მოედანი',
  'სპოტკაფე',
  'ლურჯი მოედანი',
  '520 ოთახი',
  'მიწისქვეშა პარკინგი',
  'ჭადრაკის ეზო',
  'რეკოპერატორი',
  'ფეხბურთის დიდი სტადიონი',
  'ბისტის სასერვერო',
  'ბისტის ინოვაციები',
  'ბისტის 215 ოთახთან',
  'ბისტის 4 სართილი 413 ოთახთან',
  'ბისტის სახურავზე გასასვლელი',
  'ბისტის 405 თან',
  'ბისტის 3 სართული 310 ოთახთან',
  'ბისტის კაფეტერია',
  'ბჯა - კაფეტერია',
  'ბჯას კამპუსის 3 სართ. სერვერთან',
  'ბჯას 2 სართული სერვერთან',
  'ბჯას ადმინისტრაცია',
  'ბჯას 1 სართული 107 ოთახი',
];

const SETUP_FLAG = 'school_checkpoints_setup_v1';
const BACKUP_KEY = 'checkpoints_backup_pre_school_v1';
const RESTORED_FLAG = 'school_checkpoints_restored_v1';

const isUniqueFlagError = (err) => /UNIQUE constraint failed: settings\.key/i.test(err.message);

// Runs once per database. An empty checkpoint list gets the school's 21;
// anything else is left exactly as it is. The flag is written in the same
// transaction as the fill, so a lost race or a failed run changes nothing.
async function applySchoolCheckpoints() {
  if (await getSetting(SETUP_FLAG)) return { applied: false };
  const existing = await listCheckpoints();
  if (existing.length > 0) {
    await setSetting(SETUP_FLAG, new Date().toISOString());
    return { applied: false, kept: existing.length };
  }
  try {
    const result = await replaceAllCheckpoints(SCHOOL_CHECKPOINTS, { flagKey: SETUP_FLAG });
    return { applied: true, ...result };
  } catch (err) {
    if (isUniqueFlagError(err)) return { applied: false };
    throw err;
  }
}

// An earlier release replaced every checkpoint with the 21 names (all
// without chips) and kept a backup of the old rows. If that happened and
// nothing has been linked or changed since, put the old checkpoints — with
// their real chip codes — back. Runs at most once.
async function restoreReplacedCheckpoints() {
  if (await getSetting(RESTORED_FLAG)) return { restored: false };
  if (!(await getSetting(SETUP_FLAG))) return { restored: false };
  let backup;
  try {
    backup = JSON.parse((await getSetting(BACKUP_KEY)) || 'null');
  } catch (err) {
    return { restored: false };
  }
  if (!Array.isArray(backup) || !backup.some((r) => r && r.id && r.name)) return { restored: false };

  const current = await listCheckpoints();
  const untouched =
    current.length === SCHOOL_CHECKPOINTS.length &&
    current.every((c, i) => c.name === SCHOOL_CHECKPOINTS[i] && !c.linked && !c.placeholder && !c.location);
  if (!untouched) return { restored: false };

  try {
    const count = await restoreCheckpointsFromBackup(
      backup.filter((r) => r && r.id && r.name),
      { flagKey: RESTORED_FLAG }
    );
    return { restored: true, count };
  } catch (err) {
    if (isUniqueFlagError(err)) return { restored: false };
    throw err;
  }
}

// What a chip code was called before the replace, if it had a real name —
// shown as a hint while linking chips.
async function previousNameForCode(code) {
  let rows;
  try {
    rows = JSON.parse((await getSetting(BACKUP_KEY)) || '[]');
  } catch (err) {
    return null;
  }
  const row = Array.isArray(rows) ? rows.find((r) => r && r.id === code) : null;
  if (!row || isPlaceholderName(row.name)) return null;
  return row.location ? `${row.name} — ${row.location}` : row.name;
}

// When the replace happened and what every old code was called, so history
// pages of earlier rounds can show the names guards saw at the time.
async function resetInfo() {
  const names = new Map();
  const backup = await getSetting(BACKUP_KEY);
  // Without a backup no replace ever happened (the list was filled from
  // empty, or left untouched), so no round predates a reset. After a
  // restore the old codes and names are current again.
  if (!backup || (await getSetting(RESTORED_FLAG))) return { at: null, names };
  try {
    for (const row of JSON.parse(backup)) {
      if (row && row.id) names.set(row.id, row.location ? `${row.name} — ${row.location}` : row.name);
    }
  } catch (err) {
    // an unreadable backup only costs the old names
  }
  return { at: await getSetting(SETUP_FLAG), names };
}

// Memoized so the serverless entry point can await it from a middleware.
let setupPromise = null;
function ensureSchoolCheckpoints() {
  setupPromise ??= (async () => {
    const restore = await restoreReplacedCheckpoints();
    const setup = await applySchoolCheckpoints();
    return { ...setup, ...restore };
  })().catch((err) => {
    setupPromise = null;
    throw err;
  });
  return setupPromise;
}

module.exports = {
  SCHOOL_CHECKPOINTS,
  applySchoolCheckpoints,
  restoreReplacedCheckpoints,
  ensureSchoolCheckpoints,
  previousNameForCode,
  resetInfo,
};
