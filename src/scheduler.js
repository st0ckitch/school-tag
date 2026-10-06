'use strict';

const {
  getActiveWalkthrough,
  getMissingCheckpoints,
  getScans,
  finishWalkthrough,
  addAlert,
} = require('./db');
const { sendNotification, sendEmail } = require('./notify');

function fmtLocal(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: process.env.TZ || 'Asia/Tbilisi',
  });
}

// Marks a walkthrough completed and emails the configured address a summary.
// Email failures are logged but never break the guard's flow.
async function completeWalkthrough(walkthrough) {
  await finishWalkthrough(walkthrough.id, 'completed');
  const scanned = (await getScans(walkthrough.id)).length;
  const message =
    `Walkthrough completed — all checkpoints scanned (${scanned}/${walkthrough.total_checkpoints}).\n` +
    (walkthrough.guard_name ? `Guard: ${walkthrough.guard_name}\n` : '') +
    `Started: ${fmtLocal(walkthrough.started_at)}\n` +
    `Finished: ${fmtLocal(new Date().toISOString())}`;
  const emailResult = await sendEmail('✅ School security: walkthrough completed', message);
  console.log('[email] completion email:', emailResult.ok ? 'sent' : `FAILED — ${emailResult.error}`);
}

// Closes a walkthrough that still has unscanned checkpoints and raises the
// alert. Shared by the scheduler (deadline passed) and the "finish early"
// button on the guard page.
async function closeIncomplete(walkthrough, reason) {
  const missing = await getMissingCheckpoints(walkthrough.id);
  await finishWalkthrough(walkthrough.id, 'incomplete');

  const names = missing.map((c) => (c.location ? `${c.name} (${c.location})` : c.name));
  const message =
    `Walkthrough ${reason}. ${missing.length} checkpoint(s) NOT scanned:\n` +
    names.map((n) => `• ${n}`).join('\n') +
    (walkthrough.guard_name ? `\nGuard: ${walkthrough.guard_name}` : '');

  await addAlert(walkthrough.id, 'missed_checkpoints', message);
  await sendNotification('⚠️ School security: checkpoints missed', message);
  const alertEmailResult = await sendEmail('⚠️ School security: checkpoints missed', message);
  console.log('[email] alert email:', alertEmailResult.ok ? 'sent' : `FAILED — ${alertEmailResult.error}`);
  return missing;
}

// Periodic check: any in-progress walkthrough past its deadline is closed as
// incomplete and the alert goes out.
async function tick() {
  const active = await getActiveWalkthrough();
  if (!active) return;
  // An empty deadline means "no time limit" — the walkthrough stays open
  // until the guard presses Finish.
  if (!active.deadline) return;
  if (new Date(active.deadline).getTime() > Date.now()) return;

  const missing = await getMissingCheckpoints(active.id);
  if (missing.length === 0) {
    // Everything was scanned but nobody pressed finish — count it as done.
    await completeWalkthrough(active);
    return;
  }
  await closeIncomplete(active, 'time expired');
}

let timer = null;

function startScheduler(intervalMs = 30 * 1000) {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler]', err));
  }, intervalMs);
  timer.unref();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startScheduler, stopScheduler, tick, closeIncomplete, completeWalkthrough };
