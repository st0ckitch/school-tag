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

test('device limit: enrollment, enforcement, and the two-device cap', async () => {
  const cp = (await db.listCheckpoints(true))[0];

  // Enforcement off → open access (everything above this test relied on it).
  await db.setSetting('require_enrolled_device', '1');
  try {
    // Unenrolled phone is rejected and the scan is not recorded.
    let res = await fetch(`${base}/t/${cp.id}`);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not authorized/);

    // Enroll phone 1 with a one-time code.
    const code = await db.createEnrollmentCode();
    res = await fetch(`${base}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `code=${code}&device_name=Guard+phone+1`,
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^device=/);

    // Same code cannot be used twice.
    res = await fetch(`${base}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `code=${code}&device_name=Thief`,
    });
    assert.equal(res.status, 400);

    // Enrolled phone can scan.
    res = await fetch(`${base}/t/${cp.id}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);

    // Enroll phone 2, then a third phone is rejected by the cap of 2.
    const code2 = await db.createEnrollmentCode();
    res = await fetch(`${base}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `code=${code2}&device_name=Guard+phone+2`,
    });
    assert.equal(res.status, 200);
    const code3 = await db.createEnrollmentCode();
    res = await fetch(`${base}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `code=${code3}&device_name=Guard+phone+3`,
    });
    assert.equal(res.status, 403);
    assert.equal(await db.countDevices(), 2);

    // Removing a device revokes its access.
    const devices = await db.listDevices();
    const phone1 = devices.find((d) => d.name === 'Guard phone 1');
    await db.deleteDevice(phone1.id);
    res = await fetch(`${base}/t/${cp.id}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403);
  } finally {
    await db.setSetting('require_enrolled_device', '0');
  }
});

test('web push: VAPID key, subscribe validation, and device gating', async () => {
  const res = await fetch(`${base}/push/key`);
  assert.equal(res.status, 200);
  const { key } = await res.json();
  assert.ok(typeof key === 'string' && key.length > 60, 'VAPID public key served');

  const goodSub = {
    subscription: { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k1', auth: 'a1' } },
    label: 'Test phone',
  };

  // Invalid payload rejected
  let bad = await fetch(`${base}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: 'http://insecure' } }),
  });
  assert.equal(bad.status, 400);

  // Valid subscription accepted while enforcement is off
  let ok = await fetch(`${base}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(goodSub),
  });
  assert.equal(ok.status, 200);
  assert.equal((await db.listPushSubscriptions()).length, 1);

  // With device enforcement on, anonymous subscribe is rejected
  await db.setSetting('require_enrolled_device', '1');
  try {
    const denied = await fetch(`${base}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodSub),
    });
    assert.equal(denied.status, 403);
  } finally {
    await db.setSetting('require_enrolled_device', '0');
  }
  await db.deletePushSubscription('https://push.example.com/abc');
});

test('assetlinks.json served only when configured', async () => {
  let res = await fetch(`${base}/.well-known/assetlinks.json`);
  assert.equal(res.status, 404);
  await db.setSetting('android_package', 'com.schooltag.app');
  await db.setSetting('android_sha256', 'AA:BB');
  try {
    res = await fetch(`${base}/.well-known/assetlinks.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body[0].target.package_name, 'com.schooltag.app');
  } finally {
    await db.setSetting('android_package', '');
    await db.setSetting('android_sha256', '');
  }
});

test('duration 0 means no time limit', async () => {
  await db.setSetting('walk_duration_minutes', '0');
  try {
    const w = await db.startWalkthrough('NightShift');
    assert.equal(w.deadline, '', 'no deadline stored');
    await tick();
    assert.equal((await db.getWalkthrough(w.id)).status, 'in_progress', 'tick must not expire it');
    const page = await (await fetch(`${base}/walk`)).text();
    assert.match(page, /No time limit/);
    for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
    await fetch(`${base}/walkthrough/finish`, { method: 'POST', redirect: 'follow' });
    assert.equal((await db.getWalkthrough(w.id)).status, 'completed');
  } finally {
    await db.setSetting('walk_duration_minutes', '60');
  }
});

test('completion email is sent via Mailchimp Transactional', async () => {
  await db.setSetting('notify_email', 'director@example.com');
  await db.setSetting('mailchimp_api_key', 'md-test');
  await db.setSetting('mailchimp_from_email', 'security@example.com');
  const captured = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('mandrillapp.com')) {
      captured.push(JSON.parse(opts.body));
      return new Response(JSON.stringify([{ email: 'director@example.com', status: 'sent' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
  try {
    const w = await db.startWalkthrough('EmailGuard');
    for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
    const res = await realFetch(`${base}/walkthrough/finish`, { method: 'POST', redirect: 'follow' });
    assert.equal(res.status, 200);
    assert.equal((await db.getWalkthrough(w.id)).status, 'completed');
    assert.equal(captured.length, 1, 'exactly one email sent');
    assert.equal(captured[0].key, 'md-test');
    assert.equal(captured[0].message.to[0].email, 'director@example.com');
    assert.equal(captured[0].message.from_email, 'security@example.com');
    assert.match(captured[0].message.subject, /completed/);
    assert.match(captured[0].message.text, /EmailGuard/);
  } finally {
    global.fetch = realFetch;
    await db.setSetting('notify_email', '');
    await db.setSetting('mailchimp_api_key', '');
    await db.setSetting('mailchimp_from_email', '');
  }
});

test('checkpoints can be restored under a chosen tag code', async () => {
  const restored = await db.addCheckpoint('Restored entrance', 'Ground floor', 'abcd1234');
  assert.equal(restored.id, 'abcd1234');
  const res = await fetch(`${base}/t/abcd1234`);
  assert.equal(res.status, 200, 'chip URL with restored code works');
  const dup = await db.addCheckpoint('Duplicate', '', 'abcd1234');
  assert.equal(dup, null, 'duplicate tag code is rejected');
  await db.deleteCheckpoint('abcd1234');
});

test('bulk restore creates checkpoints from pasted lines', async () => {
  // admin login
  let res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pin=1234',
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const bulk = [
    'aaaa1111, Main entrance, Ground floor',
    'bbbb2222, Gym',
    'aaaa1111, Duplicate of first',
    'aaaa111z, Mistyped code',
  ].join('\n');
  res = await fetch(`${base}/admin/checkpoints/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'bulk=' + encodeURIComponent(bulk),
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok((await db.getCheckpoint('aaaa1111')), 'first restored');
  assert.equal((await db.getCheckpoint('aaaa1111')).name, 'Main entrance');
  assert.ok((await db.getCheckpoint('bbbb2222')), 'second restored');
  // chip URL immediately works
  assert.equal((await fetch(`${base}/t/aaaa1111`)).status, 200);
  // raw log / URL paste: codes auto-extracted from arbitrary text
  const rawDump = [
    'Oct 06 13:01:22 GET /t/cccc3333 200 12ms "Mozilla/5.0..."',
    'https://school-tag-production.up.railway.app/t/dddd4444',
    'GET /walk 200 — no code here',
    'GET /t/cccc3333 200 (duplicate request)',
  ].join('\n');
  res = await fetch(`${base}/admin/checkpoints/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'bulk=' + encodeURIComponent(rawDump),
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(await db.getCheckpoint('cccc3333'), 'code from raw log line restored');
  assert.equal((await db.getCheckpoint('cccc3333')).name, 'Tag cccc3333');
  assert.ok(await db.getCheckpoint('dddd4444'), 'code from pasted URL restored');
  await db.deleteCheckpoint('cccc3333');
  await db.deleteCheckpoint('dddd4444');

  // inline rename
  res = await fetch(`${base}/admin/checkpoints/bbbb2222/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'name=Sports+hall&location=Basement',
    redirect: 'manual',
  });
  assert.equal((await db.getCheckpoint('bbbb2222')).name, 'Sports hall');
  await db.deleteCheckpoint('aaaa1111');
  await db.deleteCheckpoint('bbbb2222');
});

test('Brevo channel sends over HTTPS', async () => {
  const { sendEmail } = require('../src/notify');
  await db.setSetting('notify_email', 'director@example.com');
  await db.setSetting('brevo_api_key', 'xkeysib-test');
  await db.setSetting('brevo_from_email', 'security@example.com');
  const captured = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.brevo.com')) {
      captured.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ messageId: 'test-123' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
  try {
    const result = await sendEmail('Subject here', 'Body here');
    assert.equal(result.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers['api-key'], 'xkeysib-test');
    assert.equal(captured[0].body.to[0].email, 'director@example.com');
    assert.equal(captured[0].body.sender.email, 'security@example.com');
  } finally {
    global.fetch = realFetch;
    await db.setSetting('notify_email', '');
    await db.setSetting('brevo_api_key', '');
    await db.setSetting('brevo_from_email', '');
  }
});

test('a Marketing-type Mailchimp key is rejected with guidance', async () => {
  const { sendEmail } = require('../src/notify');
  await db.setSetting('notify_email', 'director@example.com');
  await db.setSetting('mailchimp_api_key', 'fake-marketing-style-key-us1');
  try {
    const result = await sendEmail('x', 'y');
    assert.equal(result.ok, false);
    assert.match(result.error, /Marketing key/);
    assert.match(result.error, /md-/);
  } finally {
    await db.setSetting('notify_email', '');
    await db.setSetting('mailchimp_api_key', '');
  }
});

test('PWA assets are served', async () => {
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const parsed = JSON.parse(await manifest.text());
  assert.equal(parsed.display, 'standalone');
  for (const path of ['/sw.js', '/offline.html', '/icons/icon-192.png', '/icons/icon-512.png']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} should be served`);
  }
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

async function adminCookie() {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'pin=1234',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('mistyped tag codes in bulk are reported, not created', async () => {
  const all = await db.listCheckpoints();
  assert.ok(!all.some((c) => /Mistyped/.test(c.name)), 'no checkpoint from a mistyped code line');
});

test('linkTag re-keys a checkpoint, keeps chip scans, and handles holders', async () => {
  const named = await db.addCheckpoint('Link target', '');
  assert.equal(named.is_linked, 0);

  // Placeholder holding the chip code, with a scan recorded under it.
  await db.addCheckpoint('Tag cafe0001', '', 'cafe0001');
  const w = await db.startWalkthrough('LinkGuard');
  await db.recordScan(w.id, 'cafe0001');

  const linked = await db.linkTag('cafe0001', named.id);
  assert.equal(linked.id, 'cafe0001');
  assert.equal(linked.name, 'Link target');
  assert.equal(linked.linked, 1);
  assert.equal(await db.getCheckpoint(named.id), undefined, 'old random id is gone');
  const scans = await db.getScans(w.id);
  assert.ok(scans.some((s) => s.checkpoint_id === 'cafe0001'), 'chip scan kept');

  // Re-linking the chip to another real checkpoint moves the previous holder
  // to a fresh, unlinked code instead of deleting it.
  const other = await db.addCheckpoint('Other place', '');
  await db.linkTag('cafe0001', other.id);
  assert.equal((await db.getCheckpoint('cafe0001')).name, 'Other place');
  const moved = (await db.listCheckpoints()).find((c) => c.name === 'Link target');
  assert.ok(moved && moved.id !== 'cafe0001', 'previous holder kept under a new code');
  assert.equal(moved.linked, 0);

  // Invalid inputs are refused.
  assert.equal(await db.linkTag('not-hex!', other.id), null);
  assert.equal(await db.linkTag('cafe0002', 'missing-id'), null);

  for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
  await db.finishWalkthrough(w.id, 'completed');
  await db.deleteCheckpoint('cafe0001');
  await db.deleteCheckpoint(moved.id);
});

test('admin taps an unknown chip and links it from the phone', async () => {
  const cookie = await adminCookie();
  const target = await db.addCheckpoint('Chess yard', '');

  // Guards (no admin session) still just see "Unknown tag".
  let res = await fetch(`${base}/t/beef0001`);
  assert.equal(res.status, 404);
  let html = await res.text();
  assert.match(html, /Unknown tag/);
  assert.doesNotMatch(html, /name="checkpoint_id"/);

  // Admin gets the link form listing the unlinked checkpoint.
  res = await fetch(`${base}/t/beef0001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /Link this tag/);
  assert.match(html, /Chess yard/);

  // Non-admin POST is refused.
  res = await fetch(`${base}/t/beef0001/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `checkpoint_id=${target.id}`,
  });
  assert.equal(res.status, 403);
  assert.equal(await db.getCheckpoint('beef0001'), undefined);

  // Admin POST links it; the chip URL now resolves to the named checkpoint.
  res = await fetch(`${base}/t/beef0001/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `checkpoint_id=${target.id}`,
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Tag linked/);
  assert.equal((await db.getCheckpoint('beef0001')).name, 'Chess yard');
  res = await fetch(`${base}/t/beef0001`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Chess yard/);

  // Choosing nothing re-shows the form with an error.
  res = await fetch(`${base}/t/beef0002/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'checkpoint_id=',
  });
  assert.equal(res.status, 400);

  await db.deleteCheckpoint('beef0001');
});

test('linking during a live walkthrough also records the scan', async () => {
  const cookie = await adminCookie();
  const target = await db.addCheckpoint('Live link place', '');
  const w = await db.startWalkthrough('RoundGuard');
  const res = await fetch(`${base}/t/beef0003/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `checkpoint_id=${target.id}`,
  });
  assert.equal(res.status, 200);
  assert.ok((await db.getScans(w.id)).some((s) => s.checkpoint_id === 'beef0003'));
  for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
  await db.finishWalkthrough(w.id, 'completed');
  await db.deleteCheckpoint('beef0003');
});

test('admin session passes device enforcement', async () => {
  const cookie = await adminCookie();
  await db.setSetting('require_enrolled_device', '1');
  try {
    assert.equal((await fetch(`${base}/walk`)).status, 403);
    assert.equal((await fetch(`${base}/walk`, { headers: { Cookie: cookie } })).status, 200);
  } finally {
    await db.setSetting('require_enrolled_device', '0');
  }
});

test('bulk: names, numbered one-line lists, and code+name linking', async () => {
  const cookie = await adminCookie();
  const post = (text) =>
    fetch(`${base}/admin/checkpoints/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'bulk=' + encodeURIComponent(text),
      redirect: 'manual',
    });

  // A single pasted line of numbered items, with invisible word joiners.
  await post('1.⁠ ⁠ბისტის სასერვერო, 2. ბჯა - კაფეტერია, 3. 520 ოთახი');
  const names = (await db.listCheckpoints()).map((c) => c.name);
  assert.ok(names.includes('ბისტის სასერვერო'));
  assert.ok(names.includes('ბჯა - კაფეტერია'));
  assert.ok(names.includes('520 ოთახი'), 'leading room number is part of the name, not numbering');

  // Pasting the same names again creates nothing new.
  const before = (await db.listCheckpoints()).length;
  await post('ბისტის სასერვერო\nბჯა - კაფეტერია');
  assert.equal((await db.listCheckpoints()).length, before);

  // "code, Name" for an existing name binds the chip instead of duplicating.
  await post('d00d0001, ბისტის სასერვერო');
  const cp = await db.getCheckpoint('d00d0001');
  assert.equal(cp.name, 'ბისტის სასერვერო');
  assert.equal(cp.linked, 1);
  assert.equal((await db.listCheckpoints()).length, before);

  // "code, Name" for a placeholder holding the code names it in place.
  await db.addCheckpoint('Tag d00d0002', '', 'd00d0002');
  await post('d00d0002, ჭადრაკის ეზო');
  assert.equal((await db.getCheckpoint('d00d0002')).name, 'ჭადრაკის ეზო');

  for (const c of await db.listCheckpoints()) {
    if (['ბისტის სასერვერო', 'ბჯა - კაფეტერია', '520 ოთახი', 'ჭადრაკის ეზო'].includes(c.name)) {
      await db.deleteCheckpoint(c.id);
    }
  }
});

// Runs last: it replaces every checkpoint.
test('one-time school setup replaces all checkpoints with the 21, in order', async () => {
  const { SCHOOL_CHECKPOINTS, applySchoolCheckpoints } = require('../src/school-checkpoints');
  assert.equal(SCHOOL_CHECKPOINTS.length, 21);
  await db.addCheckpoint('Old placeholder', '');
  const w = await db.startWalkthrough('Interrupted');

  const first = await applySchoolCheckpoints();
  assert.equal(first.applied, true);
  assert.equal(first.created, 21);
  assert.ok(first.removed >= 1);

  const list = await db.listCheckpoints();
  assert.deepEqual(list.map((c) => c.name), SCHOOL_CHECKPOINTS);
  assert.ok(list.every((c) => !c.is_linked), 'all start unlinked');
  assert.equal((await db.getWalkthrough(w.id)).status, 'cancelled', 'no false alert from the old round');

  // Never runs again, so later admin edits survive restarts.
  await db.deleteCheckpoint(list[0].id);
  const second = await applySchoolCheckpoints();
  assert.equal(second.applied, false);
  assert.equal((await db.listCheckpoints()).length, 20);
});
