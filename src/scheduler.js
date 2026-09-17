'use strict';

const {
  getActiveWalkthrough,
  getMissingCheckpoints,
  finishWalkthrough,
  addAlert,
} = require('./db');
const { sendNotification } = require('./notify');

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
  return missing;
}

// Periodic check: any in-progress walkthrough past its deadline is closed as
// incomplete and the alert goes out.
async function tick() {
  const active = await getActiveWalkthrough();
  if (!active) return;
  if (new Date(active.deadline).getTime() > Date.now()) return;

  const missing = await getMissingCheckpoints(active.id);
  if (missing.length === 0) {
    // Everything was scanned but nobody pressed finish — count it as done.
    await finishWalkthrough(active.id, 'completed');
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

module.exports = { startScheduler, stopScheduler, tick, closeIncomplete };
