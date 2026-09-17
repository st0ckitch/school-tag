'use strict';

// End-to-end smoke test over HTTP against a temporary database.
// Run with: npm test

process.env.DATA_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'school-tag-test-')
);

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const app = require('../server');
const db = require('../src/db');
const { tick } = require('../src/scheduler');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('full walkthrough flow', async () => {
  const cp1 = await db.addCheckpoint('Main entrance', 'Ground floor');
  const cp2 = await db.addCheckpoint('Gym', 'Ground floor');
  const cp3 = await db.addCheckpoint('Library', '1st floor');

  // Unknown tag → 404
  const bad = await fetch(`${base}/t/doesnotexist`);
  assert.equal(bad.status, 404);

  // No walkthrough yet → tag page offers to start one
  let res = await fetch(`${base}/t/${cp1.id}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Start walkthrough/);

  // Start a walkthrough from that tag
  res = await fetch(`${base}/walkthrough/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `guard_name=TestGuard&checkpoint_id=${cp1.id}`,
    redirect: 'follow',
  });
  assert.equal(res.status, 200);
  const active = await db.getActiveWalkthrough();
  assert.ok(active, 'walkthrough should be active');
  assert.equal(active.guard_name, 'TestGuard');
  assert.equal((await db.getScans(active.id)).length, 1);

  // Scan the second tag; scanning it twice stays one scan
  await fetch(`${base}/t/${cp2.id}`);
  await fetch(`${base}/t/${cp2.id}`);
  assert.equal((await db.getScans(active.id)).length, 2);
  assert.equal((await db.getMissingCheckpoints(active.id)).length, 1);
  assert.equal((await db.getMissingCheckpoints(active.id))[0].id, cp3.id);

  // Finish early with one checkpoint missing → incomplete + alert raised
  res = await fetch(`${base}/walkthrough/finish`, { method: 'POST', redirect: 'follow' });
  assert.equal(res.status, 200);
  const finished = await db.getWalkthrough(active.id);
  assert.equal(finished.status, 'incomplete');
  const alerts = await db.unacknowledgedAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Library/);
});

test('deadline expiry raises alert via scheduler', async () => {
  // New walkthrough that expires immediately
  const w = await db.startWalkthrough('NightGuard');
  await db.rawExecute('UPDATE walkthroughs SET deadline = ? WHERE id = ?', [
    new Date(Date.now() - 1000).toISOString(),
    w.id,
  ]);
  await tick();
  const after = await db.getWalkthrough(w.id);
  assert.equal(after.status, 'incomplete');
  const alert = (await db.unacknowledgedAlerts()).find((a) => a.walkthrough_id === w.id);
  assert.ok(alert, 'expiry alert should exist');
  assert.match(alert.message, /time expired/);
});

test('lazy check closes expired walkthrough on page load', async () => {
  // New walkthrough whose deadline is forced into the past — no manual tick:
  // simply loading the guard page must close it and raise the alert.
  const w = await db.startWalkthrough('LateGuard');
  await db.rawExecute('UPDATE walkthroughs SET deadline = ? WHERE id = ?', [
    new Date(Date.now() - 1000).toISOString(),
    w.id,
  ]);

  const res = await fetch(`${base}/walk`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /No walkthrough running/);
  assert.equal((await db.getWalkthrough(w.id)).status, 'incomplete');
  const alert = (await db.unacknowledgedAlerts()).find((a) => a.walkthrough_id === w.id);
  assert.ok(alert, 'lazy expiry alert should exist');
  assert.match(alert.message, /time expired/);
});

test('completed walkthrough when all scanned', async () => {
  const w = await db.startWalkthrough('DayGuard');
  for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
  const res = await fetch(`${base}/walkthrough/finish`, { method: 'POST', redirect: 'follow' });
  assert.equal(res.status, 200);
  assert.equal((await db.getWalkthrough(w.id)).status, 'completed');
});

test('concurrent starts create only one walkthrough', async () => {
  const results = await Promise.all([
    db.startWalkthrough('GuardA'),
    db.startWalkthrough('GuardB'),
    db.startWalkthrough('GuardC'),
  ]);
  const rs = await db.rawExecute("SELECT COUNT(*) AS n FROM walkthroughs WHERE status = 'in_progress'");
  assert.equal(rs.rows[0].n, 1);
  const activeId = (await db.getActiveWalkthrough()).id;
  for (const r of results) assert.equal(r.id, activeId);
  // clean up for the following tests
  for (const cp of await db.listCheckpoints(true)) await db.recordScan(activeId, cp.id);
  await db.finishWalkthrough(activeId, 'completed');
});

test('admin requires PIN, then works', async () => {
  let res = await fetch(`${base}/admin`);
  assert.equal(res.status, 401);

  res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pin=1234',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  res = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /School security dashboard/);

  res = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
  const state = await res.json();
  assert.equal(typeof state.checkpoints, 'number');

  // Wrong PIN stays out
  res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pin=9999',
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
});
