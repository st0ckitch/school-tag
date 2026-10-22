'use strict';

// The school's checkpoint list. On the first server start after this was
// added, every existing checkpoint is replaced by these, in this order. The
// physical chips are then bound to them by tapping each one with an
// admin-logged-in phone (see the link flow in routes/guard.js).

const { getSetting, replaceAllCheckpoints, isPlaceholderName } = require('./db');

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

// Runs once per database: the flag stops it from wiping checkpoints the
// admin edits or adds later. The flag is written inside the same transaction
// as the replace, so a lost race or a failed run leaves nothing half-done.
async function applySchoolCheckpoints() {
  if (await getSetting(SETUP_FLAG)) return { applied: false };
  try {
    const result = await replaceAllCheckpoints(SCHOOL_CHECKPOINTS, {
      flagKey: SETUP_FLAG,
      backupKey: BACKUP_KEY,
    });
    return { applied: true, ...result };
  } catch (err) {
    // Another process committed the replace first.
    if (/UNIQUE constraint failed: settings\.key/i.test(err.message)) return { applied: false };
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

// Memoized so the serverless entry point can await it from a middleware.
let setupPromise = null;
function ensureSchoolCheckpoints() {
  setupPromise ??= applySchoolCheckpoints().catch((err) => {
    setupPromise = null;
    throw err;
  });
  return setupPromise;
}

module.exports = {
  SCHOOL_CHECKPOINTS,
  applySchoolCheckpoints,
  ensureSchoolCheckpoints,
  previousNameForCode,
};
