'use strict';

const {
  getActiveWalkthrough,
  getMissingCheckpoints,
  getScans,
  finishWalkthrough,
  addAlert,
  getSetting,
} = require('./db');
const { sendNotification, sendEmail } = require('./notify');
const { roundEmail } = require('./email-template');

// The Georgian summary email for a finished round: what was scanned (with
// times) and what was not, linking to the round's page when the public base
// URL is set.
async function roundSummaryEmail(walkthrough, missing, reason) {
  const scans = await getScans(walkthrough.id);
  // Railway tells the service its public domain when Settings has no base URL.
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const base = ((await getSetting('base_url')) || '').trim().replace(/\/+$/, '') || (domain ? `https://${domain}` : '');
  return roundEmail({
    walkthrough,
    scans,
    missing,
    reason,
    endedAt: new Date().toISOString(),
    detailsUrl: base ? `${base}/admin/history/${encodeURIComponent(walkthrough.id)}` : '',
  });
}

// Marks a walkthrough completed and emails the configured address a summary.
// Email failures are logged but never break the guard's flow.
async function completeWalkthrough(walkthrough) {
  await finishWalkthrough(walkthrough.id, 'completed');
  const email = await roundSummaryEmail(walkthrough, [], 'completed');
  const emailResult = await sendEmail(email.subject, email.text, email.html);
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
  const summary = await roundSummaryEmail(walkthrough, missing, reason);
  // Push and email go out side by side, so a slow or failing push service
  // can't hold back the email.
  const [push, email] = await Promise.allSettled([
    sendNotification('⚠️ School security: checkpoints missed', message),
    sendEmail(summary.subject, summary.text, summary.html),
  ]);
  if (push.status === 'rejected') console.error('[notify] alert push failed:', push.reason);
  const alertEmailResult = email.status === 'fulfilled' ? email.value : { ok: false, error: String(email.reason) };
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
