'use strict';

// The school's checkpoint list. On the first server start after this was
// added, every existing checkpoint is replaced by these, in this order. The
// physical chips are then bound to them by tapping each one with an
// admin-logged-in phone (see the link flow in routes/guard.js).

const { getSetting, setSetting, replaceAllCheckpoints } = require('./db');

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

// Runs once per database: the flag stops it from wiping checkpoints the
// admin edits or adds later.
async function applySchoolCheckpoints() {
  if (await getSetting(SETUP_FLAG)) return { applied: false };
  const result = await replaceAllCheckpoints(SCHOOL_CHECKPOINTS);
  await setSetting(SETUP_FLAG, new Date().toISOString());
  return { applied: true, ...result };
}

module.exports = { SCHOOL_CHECKPOINTS, applySchoolCheckpoints };
