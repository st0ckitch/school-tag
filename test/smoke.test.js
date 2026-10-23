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
    assert.match(captured[0].message.subject, /შემოვლა დასრულდა/);
    assert.match(captured[0].message.text, /EmailGuard/);
    assert.match(captured[0].message.html, /<html lang="ka">/);
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
  await db.addCheckpoint('Tag cafe0001', '', 'cafe0001', { placeholder: true });
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
  await db.addCheckpoint('Tag d00d0002', '', 'd00d0002', { placeholder: true });
  await post('d00d0002, ჭადრაკის ეზო');
  assert.equal((await db.getCheckpoint('d00d0002')).name, 'ჭადრაკის ეზო');

  for (const c of await db.listCheckpoints()) {
    if (['ბისტის სასერვერო', 'ბჯა - კაფეტერია', '520 ოთახი', 'ჭადრაკის ეზო'].includes(c.name)) {
      await db.deleteCheckpoint(c.id);
    }
  }
});

test('re-linking swapped chips never deletes scan history', async () => {
  const lib = await db.addCheckpoint('Swap Library', '');
  const gym = await db.addCheckpoint('Swap Gym', '');
  await db.linkTag('aaaa0a01', lib.id);
  await db.linkTag('bbbb0b02', gym.id);
  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const w = await db.startWalkthrough(`SwapRound${i}`);
    await db.recordScan(w.id, 'aaaa0a01');
    await db.recordScan(w.id, 'bbbb0b02');
    for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
    await db.finishWalkthrough(w.id, 'completed');
    rounds.push(w.id);
  }
  const countRows = async () =>
    (await db.rawExecute(
      `SELECT COUNT(*) AS n FROM scans WHERE walkthrough_id IN (${rounds.map(() => '?').join(',')})`,
      rounds
    )).rows[0].n;
  const before = await countRows();

  // The chips were swapped: fix it by re-linking both, the way the link
  // form does (by each checkpoint's current id).
  const currentId = async (name) => (await db.listCheckpoints()).find((c) => c.name === name).id;
  await db.linkTag('aaaa0a01', await currentId('Swap Gym'));
  await db.linkTag('bbbb0b02', await currentId('Swap Library'));
  assert.equal(await countRows(), before, 'no scan rows lost');
  assert.equal((await db.getCheckpoint('aaaa0a01')).name, 'Swap Gym');
  assert.equal((await db.getCheckpoint('bbbb0b02')).name, 'Swap Library');
  // Each past round still shows both places scanned.
  for (const id of rounds) {
    const names = (await db.getScans(id)).map((x) => x.checkpoint_name);
    assert.ok(names.includes('Swap Gym') && names.includes('Swap Library'));
  }
  await db.deleteCheckpoint('aaaa0a01');
  await db.deleteCheckpoint('bbbb0b02');
});

test('bulk chip-swap paste links each name to the right chip', async () => {
  const cookie = await adminCookie();
  const a = await db.addCheckpoint('Bulk Gym', '');
  const b = await db.addCheckpoint('Bulk Library', '');
  await db.linkTag('aaaa0c01', a.id);
  await db.linkTag('bbbb0c02', b.id);
  await fetch(`${base}/admin/checkpoints/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'bulk=' + encodeURIComponent('bbbb0c02, Bulk Gym\naaaa0c01, Bulk Library'),
    redirect: 'manual',
  });
  assert.equal((await db.getCheckpoint('bbbb0c02')).name, 'Bulk Gym');
  assert.equal((await db.getCheckpoint('aaaa0c01')).name, 'Bulk Library');
  await db.deleteCheckpoint('aaaa0c01');
  await db.deleteCheckpoint('bbbb0c02');
});

test('bulk: log pastes create no free-text checkpoints; trailing commas are trimmed', async () => {
  const cookie = await adminCookie();
  const post = (text) =>
    fetch(`${base}/admin/checkpoints/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'bulk=' + encodeURIComponent(text),
      redirect: 'manual',
    });
  const before = (await db.listCheckpoints()).length;
  await post(['GET', '/t/e0e0e001', '200', '11ms', "2026-10-05 GET /manifest.webmanifest 304 '+alert(1)+'"].join('\n'));
  const afterLog = await db.listCheckpoints();
  assert.equal(afterLog.length, before + 1, 'only the tag code was added');
  assert.ok(afterLog.some((c) => c.id === 'e0e0e001' && c.placeholder === 1));

  await post('Trailing Comma Place,\nTrailing Comma Place');
  const names = (await db.listCheckpoints()).map((c) => c.name);
  assert.ok(names.includes('Trailing Comma Place'));
  assert.ok(!names.includes('Trailing Comma Place,'));
  assert.equal(names.filter((n) => n === 'Trailing Comma Place').length, 1);

  // "URL, Name" behaves like "code, Name".
  await post('https://school-tag-production.up.railway.app/t/e0e0e002, Url Named Place');
  assert.equal((await db.getCheckpoint('e0e0e002')).name, 'Url Named Place');

  for (const c of await db.listCheckpoints()) {
    if (['e0e0e001', 'e0e0e002'].includes(c.id) || c.name === 'Trailing Comma Place') await db.deleteCheckpoint(c.id);
  }
});

test('checkpoint names cannot inject into the delete confirmation script', async () => {
  const cookie = await adminCookie();
  const cp = await db.addCheckpoint("x'+alert(1)+'", '');
  const html = await (await fetch(`${base}/admin/checkpoints`, { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(html, /confirm\('Delete checkpoint/);
  assert.match(html, /onsubmit="return confirm\(this\.dataset\.confirm\)"/);
  await db.deleteCheckpoint(cp.id);
});

test('a malformed session cookie does not break chip taps', async () => {
  const cp = await db.addCheckpoint('Cookie test place', '');
  for (const bad of ['session=%E0%A4%A', 'session=admin.1.' + 'é'.repeat(32), 'session=garbage']) {
    const res = await fetch(`${base}/t/${cp.id}`, { headers: { Cookie: bad } });
    assert.equal(res.status, 200, `cookie ${bad} must not cause a 500`);
  }
  await db.deleteCheckpoint(cp.id);
});

test('a checkpoint displaced by a re-link reads as not linked, despite its old scans', async () => {
  const a = await db.addCheckpoint('Displaced A', '');
  const b = await db.addCheckpoint('Displaced B', '');
  await db.linkTag('ca110001', a.id);
  const w = await db.startWalkthrough('DisplaceRound');
  await db.recordScan(w.id, 'ca110001');
  for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
  await db.finishWalkthrough(w.id, 'completed');
  await db.linkTag('ca110001', (await db.listCheckpoints()).find((c) => c.name === 'Displaced B').id);
  const displaced = (await db.listCheckpoints()).find((c) => c.name === 'Displaced A');
  assert.equal(displaced.is_linked, 0, 'no chip carries its new code');
  await db.deleteCheckpoint(displaced.id);
  await db.deleteCheckpoint('ca110001');
});

async function bulkPost(text) {
  const cookie = await adminCookie();
  const res = await fetch(`${base}/admin/checkpoints/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'bulk=' + encodeURIComponent(text),
    redirect: 'manual',
  });
  return res;
}

test('bulk: re-pasting same-name chips is a no-op in any order', async () => {
  await bulkPost('ab120001, Stairs, Floor 1\nab120002, Stairs, Floor 2');
  const snapshot = async () =>
    (await db.listCheckpoints())
      .filter((c) => c.name === 'Stairs')
      .map((c) => `${c.id}:${c.location}:${c.linked}`)
      .sort()
      .join('|');
  const before = await snapshot();
  assert.equal(before, 'ab120001:Floor 1:1|ab120002:Floor 2:1');
  await bulkPost('ab120002, Stairs, Floor 2');
  assert.equal(await snapshot(), before);
  await bulkPost('ab120002, Stairs, Floor 2\nab120001, Stairs, Floor 1');
  assert.equal(await snapshot(), before);
  await db.deleteCheckpoint('ab120001');
  await db.deleteCheckpoint('ab120002');
});

test('bulk: code-bearing junk shapes are reported, never created as names', async () => {
  const count = async () => (await db.listCheckpoints()).length;
  const before = await count();
  for (const bad of ['Junk Place - fa110a01', 'Junk Place, fa110a01', 'fa11 0a01, Junk Place', 'fa110a0z, Junk Place']) {
    await bulkPost(bad);
    assert.equal(await count(), before, `"${bad}" must not create a checkpoint`);
  }
  // Colon/= separators and tab tables with a header row are understood.
  await bulkPost('fa110a02: Colon Place\nfa110a03=Equals Place');
  assert.equal((await db.getCheckpoint('fa110a02')).name, 'Colon Place');
  assert.equal((await db.getCheckpoint('fa110a03')).name, 'Equals Place');
  await bulkPost('Tag code\tName\nfa110a04\tTab Place');
  await bulkPost('| Code | Name |\n|---|---|\n| fa110a05 | Pipe Place |');
  assert.equal((await db.getCheckpoint('fa110a04')).name, 'Tab Place');
  assert.equal((await db.getCheckpoint('fa110a05')).name, 'Pipe Place');
  assert.equal(await count(), before + 4, 'header rows created nothing');
  for (const id of ['fa110a02', 'fa110a03', 'fa110a04', 'fa110a05']) await db.deleteCheckpoint(id);
});

test('bulk: a name-only line can be bound by a later code line', async () => {
  await bulkPost('Bound Later\nfb110001, Bound Later');
  const rows = (await db.listCheckpoints()).filter((c) => c.name === 'Bound Later');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'fb110001');
  assert.equal(rows[0].linked, 1);
  await db.deleteCheckpoint('fb110001');
});

test('bulk: numbered lists survive leading bullets/quotes; URL forms keep names', async () => {
  for (const prefix of [', ', '• ', '"', '- ']) {
    await bulkPost(`${prefix}1. Bullet A, 2. Bullet B`);
    const names = (await db.listCheckpoints()).map((c) => c.name);
    assert.ok(names.includes('Bullet A') && names.includes('Bullet B'), `prefix ${JSON.stringify(prefix)}`);
    for (const c of await db.listCheckpoints()) if (/^Bullet [AB]$/.test(c.name)) await db.deleteCheckpoint(c.id);
  }
  await bulkPost([
    '1. https://school-tag-production.up.railway.app/t/fc110001, Url One',
    'school-tag-production.up.railway.app/t/fc110002, Url Two',
    'https://school-tag-production.up.railway.app/t/fc110003 - Url Three',
    'https://school-tag-production.up.railway.app/t/fc110004?nfc=1, Url Four',
  ].join('\n'));
  assert.equal((await db.getCheckpoint('fc110001')).name, 'Url One');
  assert.equal((await db.getCheckpoint('fc110002')).name, 'Url Two');
  assert.equal((await db.getCheckpoint('fc110003')).name, 'Url Three');
  assert.equal((await db.getCheckpoint('fc110004')).name, 'Url Four');
  for (const id of ['fc110001', 'fc110002', 'fc110003', 'fc110004']) await db.deleteCheckpoint(id);
});

test('bulk: large log pastes work; emoji at the cut-off point does not crash', async () => {
  const line = '2026-10-21T10:00:00.000Z GET /t/fd110001 200 0ms school-tag-production.up.railway.app';
  const big = Array(2500).fill(line).join('\n'); // ~220 KB
  let res = await bulkPost(big);
  assert.equal(res.status, 302);
  assert.ok(await db.getCheckpoint('fd110001'));
  await db.deleteCheckpoint('fd110001');

  res = await bulkPost('x'.repeat(29) + '😀😀😀, more' + '\nfd110002' + 'z, x');
  assert.equal(res.status, 302, 'surrogate pairs at truncation must not cause a 500');
});

test('status messages in admin URLs must carry a valid signature', async () => {
  const cookie = await adminCookie();
  const html = await (
    await fetch(`${base}/admin/checkpoints?msg=${encodeURIComponent('Fake success text')}`, { headers: { Cookie: cookie } })
  ).text();
  assert.doesNotMatch(html, /Fake success text/);
  const res = await bulkPost('Signed Flash Place');
  const location = res.headers.get('location');
  assert.match(location, /sig=/);
  const page = await (await fetch(`${base}${location}`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /Created 1/);
  for (const c of await db.listCheckpoints()) if (c.name === 'Signed Flash Place') await db.deleteCheckpoint(c.id);
});

test('a malformed device cookie under enforcement gives the 403 page, not a 500', async () => {
  await db.setSetting('require_enrolled_device', '1');
  try {
    const res = await fetch(`${base}/walk`, { headers: { Cookie: 'device=%E0%A4%A' } });
    assert.equal(res.status, 403);
  } finally {
    await db.setSetting('require_enrolled_device', '0');
  }
});

// Run last: they rewrite the whole checkpoint list.
test('school setup keeps an existing checkpoint list untouched', async () => {
  const { applySchoolCheckpoints } = require('../src/school-checkpoints');
  await db.addCheckpoint('Existing real place', '', 'e11e0001');
  const w = await db.startWalkthrough('KeepRound');
  const before = (await db.listCheckpoints()).map((c) => `${c.id}:${c.name}`);

  const result = await applySchoolCheckpoints();
  assert.equal(result.applied, false);
  assert.ok(result.kept >= 1);
  assert.deepEqual((await db.listCheckpoints()).map((c) => `${c.id}:${c.name}`), before, 'nothing changed');
  assert.equal((await db.getWalkthrough(w.id)).status, 'in_progress', 'running round not cancelled');
  assert.ok(await db.getSetting('school_checkpoints_setup_v1'), 'flag set so it never runs again');
  assert.equal((await applySchoolCheckpoints()).applied, false);

  for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
  await db.finishWalkthrough(w.id, 'completed');
});

test('after an earlier release replaced the list, the backup restores the chip codes', async () => {
  const sc = require('../src/school-checkpoints');
  const { SCHOOL_CHECKPOINTS } = sc;
  const cookie = await adminCookie();

  // Rebuild the situation the earlier release created on a live database.
  await db.rawExecute('DELETE FROM checkpoints');
  await db.addCheckpoint('Old placeholder', '');
  const oldNamed = await db.addCheckpoint('Old real name', 'Old floor', 'abcabc01');
  await db.addCheckpoint('Second real name', '', 'abcabc02');
  const old = await db.startWalkthrough('BeforeReset');
  await db.recordScan(old.id, oldNamed.id);
  await db.finishWalkthrough(old.id, 'incomplete');
  await db.addAlert(old.id, 'missed_checkpoints', 'Walkthrough time expired. 1 checkpoint(s) NOT scanned:\n• Old placeholder');
  const w = await db.startWalkthrough('Interrupted');
  await db.rawExecute("DELETE FROM settings WHERE key = 'school_checkpoints_setup_v1'");
  await db.replaceAllCheckpoints(SCHOOL_CHECKPOINTS, {
    flagKey: 'school_checkpoints_setup_v1',
    backupKey: 'checkpoints_backup_pre_school_v1',
  });
  assert.deepEqual((await db.listCheckpoints()).map((c) => c.name), SCHOOL_CHECKPOINTS);
  assert.equal((await db.getWalkthrough(w.id)).status, 'cancelled');

  // While in that state, history and the link page use the backup.
  assert.equal(await sc.previousNameForCode('abcabc01'), 'Old real name — Old floor');
  const oldHist = await (await fetch(`${base}/admin/history/${old.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(oldHist, /Old real name/);
  assert.match(oldHist, /Old placeholder/);
  assert.doesNotMatch(oldHist, new RegExp(SCHOOL_CHECKPOINTS[5]));
  const hist = await (await fetch(`${base}/admin/history/${w.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(hist, /cancelled/i);
  assert.doesNotMatch(hist, /Missed \(/);

  // The next start puts the old checkpoints back with their chip codes.
  const r = await sc.restoreReplacedCheckpoints();
  assert.equal(r.restored, true);
  const restored = await db.listCheckpoints();
  assert.deepEqual(restored.map((c) => c.name), ['Old placeholder', 'Old real name', 'Second real name']);
  assert.equal((await db.getCheckpoint('abcabc01')).location, 'Old floor');
  assert.ok(restored.filter((c) => c.name !== 'Old placeholder').every((c) => c.linked === 1));
  assert.equal((await fetch(`${base}/t/abcabc01`)).status, 200, 'chip works again');
  assert.equal((await sc.restoreReplacedCheckpoints()).restored, false, 'runs once');
});

test('no restore once chips were linked to the replaced list', async () => {
  const sc = require('../src/school-checkpoints');
  const { SCHOOL_CHECKPOINTS } = sc;
  await db.rawExecute("DELETE FROM settings WHERE key IN ('school_checkpoints_setup_v1', 'school_checkpoints_restored_v1')");
  await db.replaceAllCheckpoints(SCHOOL_CHECKPOINTS, {
    flagKey: 'school_checkpoints_setup_v1',
    backupKey: 'checkpoints_backup_pre_school_v1',
  });
  const first = (await db.listCheckpoints())[0];
  await db.linkTag('abcabc01', first.id);
  assert.equal((await sc.restoreReplacedCheckpoints()).restored, false);
  assert.equal((await db.getCheckpoint('abcabc01')).name, SCHOOL_CHECKPOINTS[0], 'the admin\'s link is kept');
});

test('an empty checkpoint list is filled with the 21 school checkpoints, once', async () => {
  const { SCHOOL_CHECKPOINTS, applySchoolCheckpoints } = require('../src/school-checkpoints');
  assert.equal(SCHOOL_CHECKPOINTS.length, 21);
  await db.rawExecute('DELETE FROM checkpoints');
  await db.rawExecute("DELETE FROM settings WHERE key = 'school_checkpoints_setup_v1'");

  const first = await applySchoolCheckpoints();
  assert.equal(first.applied, true);
  assert.equal(first.created, 21);
  const list = await db.listCheckpoints();
  assert.deepEqual(list.map((c) => c.name), SCHOOL_CHECKPOINTS);
  assert.ok(list.every((c) => !c.is_linked), 'all start unlinked');

  await db.deleteCheckpoint(list[0].id);
  assert.equal((await applySchoolCheckpoints()).applied, false, 'never runs again');
  assert.equal((await db.listCheckpoints()).length, 20);

  // A run that loses the race rolls back entirely.
  await assert.rejects(
    db.replaceAllCheckpoints(SCHOOL_CHECKPOINTS, { flagKey: 'school_checkpoints_setup_v1' }),
    /UNIQUE constraint failed/
  );
  assert.equal((await db.listCheckpoints()).length, 20);
});

// Stubs the Brevo API; `fail` maps an address to the error message Brevo
// should answer with for it.
function stubBrevo(fail = {}) {
  const captured = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('api.brevo.com')) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    captured.push(body);
    const to = body.to.map((r) => r.email).join(',');
    if (fail[to]) return new Response(JSON.stringify({ message: fail[to] }), { status: 400 });
    return new Response(JSON.stringify({ messageId: `id-${to}` }), { status: 201 });
  };
  return { captured, restore: () => (global.fetch = realFetch) };
}

async function withBrevo(recipients, fn) {
  await db.setSetting('notify_email', recipients);
  await db.setSetting('brevo_api_key', 'xkeysib-test');
  await db.setSetting('brevo_from_email', 'security@example.com');
  try {
    await fn();
  } finally {
    for (const k of ['notify_email', 'brevo_api_key', 'brevo_from_email', 'email_log', 'email_last_result']) await db.setSetting(k, '');
  }
}

test('every listed address gets its own copy of a notification', async () => {
  const { sendEmail } = require('../src/notify');
  await withBrevo('Mamuka.tsiklauri@bga.ge, artyomananov@gmail.com', async () => {
    const brevo = stubBrevo();
    try {
      const result = await sendEmail('Subject', 'Body');
      assert.equal(result.ok, true);
      assert.deepEqual(result.sent, ['Mamuka.tsiklauri@bga.ge', 'artyomananov@gmail.com']);
      assert.deepEqual(
        brevo.captured.map((b) => b.to.map((r) => r.email)),
        [['Mamuka.tsiklauri@bga.ge'], ['artyomananov@gmail.com']]
      );
    } finally {
      brevo.restore();
    }
  });
});

test('one failing address does not stop the others, and the error names it', async () => {
  const { sendEmail } = require('../src/notify');
  await withBrevo('a@example.com; b@example.com', async () => {
    const brevo = stubBrevo({ 'b@example.com': 'Invalid recipient' });
    try {
      const result = await sendEmail('Subject', 'Body');
      assert.equal(result.ok, false);
      assert.deepEqual(result.sent, ['a@example.com']);
      assert.match(result.error, /sent to a@example\.com, but not sent to b@example\.com — Brevo: Invalid recipient/);
    } finally {
      brevo.restore();
    }
  });
  // The same failure for everyone is reported once, as before.
  await withBrevo('a@example.com, b@example.com', async () => {
    const brevo = stubBrevo({ 'a@example.com': 'Key not found', 'b@example.com': 'Key not found' });
    try {
      const result = await sendEmail('Subject', 'Body');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'Brevo: Key not found');
    } finally {
      brevo.restore();
    }
  });
});

test('a completed round emails every listed address', async () => {
  await withBrevo('a@example.com, b@example.com', async () => {
    const brevo = stubBrevo();
    try {
      const w = await db.startWalkthrough('MultiGuard');
      for (const cp of await db.listCheckpoints(true)) await db.recordScan(w.id, cp.id);
      const res = await fetch(`${base}/walkthrough/finish`, { method: 'POST', redirect: 'follow' });
      assert.equal(res.status, 200);
      assert.equal((await db.getWalkthrough(w.id)).status, 'completed');
      assert.deepEqual(brevo.captured.map((b) => b.to[0].email).sort(), ['a@example.com', 'b@example.com']);
      assert.ok(brevo.captured.every((b) => /შემოვლა დასრულდა/.test(b.subject) && /MultiGuard/.test(b.textContent) && /MultiGuard/.test(b.htmlContent)));
    } finally {
      brevo.restore();
    }
  });
});

test('settings take several notification emails and refuse a bad one', async () => {
  const cookie = await adminCookie();
  const post = (path, value) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ notify_email: value }).toString(),
      redirect: 'manual',
    });
  try {
    let res = await post('/admin/settings', ' Mamuka.tsiklauri@bga.ge;artyomananov@gmail.com\n mamuka.TSIKLAURI@bga.ge ');
    assert.equal(res.headers.get('location'), '/admin/settings');
    assert.equal(await db.getSetting('notify_email'), 'Mamuka.tsiklauri@bga.ge, artyomananov@gmail.com');
    let page = await (await fetch(`${base}/admin/settings`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /value="Mamuka\.tsiklauri@bga\.ge, artyomananov@gmail\.com"/);
    assert.match(page, /id="notify_email" name="notify_email" type="text" inputmode="email"/);

    res = await post('/admin/settings', 'ok@example.com, not-an-email');
    assert.equal(await db.getSetting('notify_email'), 'Mamuka.tsiklauri@bga.ge, artyomananov@gmail.com', 'kept as it was');
    page = await (await fetch(`${base}${res.headers.get('location')}`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /Email list not saved — not a valid email address: not-an-email/);

    // The test button reports who got the email.
    await db.setSetting('brevo_api_key', 'xkeysib-test');
    await db.setSetting('brevo_from_email', 'security@example.com');
    const brevo = stubBrevo();
    try {
      res = await post('/admin/settings/test-email', 'a@example.com, b@example.com');
      assert.equal(brevo.captured.length, 2);
    } finally {
      brevo.restore();
    }
    page = await (await fetch(`${base}${res.headers.get('location')}`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /Test email sent to a@example\.com, b@example\.com/);

    // A bad address stops the test before anything is sent.
    const none = stubBrevo();
    try {
      res = await post('/admin/settings/test-email', 'a@example.com, oops');
      assert.equal(none.captured.length, 0);
    } finally {
      none.restore();
    }
    page = await (await fetch(`${base}${res.headers.get('location')}`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /Test failed: Email list not saved — not a valid email address: oops/);
  } finally {
    await db.setSetting('notify_email', '');
    await db.setSetting('brevo_api_key', '');
    await db.setSetting('brevo_from_email', '');
  }
});

test('pasted address lists are understood, and typos are named', () => {
  const { parseRecipients } = require('../src/notify');
  const nbsp = ' ';
  const zw = '​';
  assert.deepEqual(
    parseRecipients(`Mamuka Tsiklauri <Mamuka.tsiklauri@BGA.ge>; mailto:artyomananov@gmail.com${nbsp}\n${zw}artyomananov@gmail.com,`),
    { valid: ['Mamuka.tsiklauri@bga.ge', 'artyomananov@gmail.com'], invalid: [] }
  );
  assert.deepEqual(parseRecipients('Mamuka.tsiklauri@bga.ge, artyomananov@gmailcom, someone'), {
    valid: ['Mamuka.tsiklauri@bga.ge'],
    invalid: ['artyomananov@gmailcom', 'someone'],
  });
  assert.deepEqual(parseRecipients(''), { valid: [], invalid: [] });
});

test('an address Mailchimp Transactional marks invalid is not reported as sent', async () => {
  const { sendEmail } = require('../src/notify');
  await db.setSetting('notify_email', 'a@example.com, b@example.com');
  await db.setSetting('mailchimp_api_key', 'md-test');
  await db.setSetting('mailchimp_from_email', 'security@example.com');
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('mandrillapp.com')) return realFetch(url, opts);
    const to = JSON.parse(opts.body).message.to[0].email;
    return new Response(JSON.stringify([{ email: to, status: to === 'b@example.com' ? 'invalid' : 'sent' }]), { status: 200 });
  };
  try {
    const result = await sendEmail('x', 'y');
    assert.equal(result.ok, false);
    assert.deepEqual(result.sent, ['a@example.com']);
    assert.match(result.error, /not sent to b@example\.com — invalid/);
  } finally {
    global.fetch = realFetch;
    await db.setSetting('notify_email', '');
    await db.setSetting('mailchimp_api_key', '');
    await db.setSetting('mailchimp_from_email', '');
  }
});

test('a hanging push service does not hold back the missed-checkpoints email', async () => {
  const { closeIncomplete } = require('../src/scheduler');
  const net = require('node:net');
  // Accepts connections and never answers, like a stuck push endpoint.
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)).listen(0);
  await new Promise((r) => silent.once('listening', r));
  const endpoint = `https://127.0.0.1:${silent.address().port}/push/stuck`;
  await db.addPushSubscription(endpoint, 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg', 'stuck');
  try {
    await withBrevo('a@example.com, b@example.com', async () => {
      const brevo = stubBrevo();
      try {
        const w = await db.startWalkthrough('PushGuard');
        const started = Date.now();
        let finished = false;
        const closing = closeIncomplete(w, 'finished early by guard').then(() => (finished = true));
        // The email goes out right away, while the push is still waiting.
        while (brevo.captured.length < 2 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
        assert.equal(brevo.captured.length, 2, 'both alert emails sent without waiting for push');
        assert.equal(finished, false, 'the push was indeed still hanging');
        await closing;
        assert.ok(Date.now() - started < 7000, `the push gives up after its timeout (took ${Date.now() - started} ms)`);
      } finally {
        brevo.restore();
      }
    });
  } finally {
    await db.deletePushSubscription(endpoint);
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

test('Settings shows what happened to the last notification email', async () => {
  const { sendEmail } = require('../src/notify');
  const cookie = await adminCookie();
  const settingsPage = async () => (await fetch(`${base}/admin/settings`, { headers: { Cookie: cookie } })).text();
  await withBrevo('a@example.com, b@example.com', async () => {
    let brevo = stubBrevo({ 'b@example.com': 'Invalid recipient' });
    try {
      await sendEmail('⚠️ School security: checkpoints missed', 'Body');
    } finally {
      brevo.restore();
    }
    let page = await settingsPage();
    assert.match(page, /Last notification email: .*checkpoints missed/);
    assert.match(page, /✕ sent to a@example\.com, but not sent to b@example\.com — Brevo: Invalid recipient/);

    brevo = stubBrevo();
    try {
      await sendEmail('✅ School security: walkthrough completed', 'Body');
    } finally {
      brevo.restore();
    }
    page = await settingsPage();
    assert.match(page, /walkthrough completed.*✓ accepted for a@example\.com, b@example\.com/);
    assert.doesNotMatch(page, /free-mail address/);

    await db.setSetting('brevo_from_email', 'someone@gmail.com');
    page = await settingsPage();
    assert.match(page, /The From address someone@gmail\.com is a free-mail address/);
  });
  await db.setSetting('email_last_result', '');
});

// A minimal SMTP server: greets, accepts AUTH PLAIN for one password, and
// takes the message. Records every command it receives.
function fakeSmtp(password) {
  const net = require('node:net');
  const commands = [];
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write('220 fake.test ESMTP\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); }
          continue;
        }
        commands.push(line.split(' ')[0].toUpperCase());
        if (/^EHLO/i.test(line)) socket.write('250-fake.test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) {
          const creds = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0');
          socket.write(creds[2] === password ? '235 ok\r\n' : '535 5.7.8 Username and Password not accepted\r\n');
        } else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, commands })));
}

async function withSmtp(port, pass, fn) {
  await db.setSetting('email_log', '');
  await db.setSetting('notify_email', 'a@example.com, b@example.com');
  await db.setSetting('smtp_host', '127.0.0.1');
  await db.setSetting('smtp_port', String(port));
  await db.setSetting('smtp_user', 'school@example.com');
  await db.setSetting('smtp_pass', pass);
  try {
    await fn();
  } finally {
    for (const k of ['notify_email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'email_log', 'email_last_result']) await db.setSetting(k, '');
  }
}

test('SMTP sends are logged step by step, without the password, and shown on Settings', async () => {
  const { sendEmail, emailLog } = require('../src/notify');
  const smtp = await fakeSmtp('app-password-123');
  const cookie = await adminCookie();
  try {
    await withSmtp(smtp.port, 'app-password-123', async () => {
      const result = await sendEmail('✅ School security: walkthrough completed', 'Body');
      assert.equal(result.ok, true);
      const [entry] = await emailLog();
      assert.equal(entry.channel, 'SMTP');
      assert.deepEqual(entry.recipients.map((r) => [r.to, r.ok]), [['a@example.com', true], ['b@example.com', true]]);
      const steps = entry.recipients[0].steps.join('\n');
      assert.match(steps, /Connecting to 127\.0\.0\.1:\d+/);
      assert.match(steps, /authenticated/i);
      assert.match(steps, /Accepted by the server/);
      assert.doesNotMatch(JSON.stringify(entry), /app-password-123/);

      // A wrong password: the step log and the hint say what to do.
      await db.setSetting('smtp_pass', 'wrong');
      const bad = await sendEmail('⚠️ School security: checkpoints missed', 'Body');
      assert.equal(bad.ok, false);
      assert.match(bad.error, /App Password/);
      const page = await (await fetch(`${base}/admin/settings`, { headers: { Cookie: cookie } })).text();
      assert.match(page, /Email log — last 2 attempts/);
      assert.match(page, /<details class="no-print" open/, 'a failed last attempt opens the log');
      assert.match(page, /via SMTP/);
      assert.match(page, /Failed at AUTH PLAIN: EAUTH/);
      assert.doesNotMatch(page, /wrong<|app-password-123/);
    });
  } finally {
    smtp.server.close();
  }
});

test('an unreachable SMTP server on Railway explains the Railway SMTP block', async () => {
  const { sendEmail } = require('../src/notify');
  const net = require('node:net');
  const closed = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => closed.once('listening', r));
  const port = closed.address().port;
  closed.close();
  process.env.RAILWAY_PROJECT_ID = 'test-project';
  try {
    await withSmtp(port, 'x', async () => {
      const result = await sendEmail('Subject', 'Body');
      assert.equal(result.ok, false);
      assert.match(result.error, /Railway blocks outgoing SMTP .* Free, Trial and Hobby plans/);
      assert.match(result.error, /Use Brevo/);
    });
  } finally {
    delete process.env.RAILWAY_PROJECT_ID;
  }
});

test('an SMTP attempt that never finishes gives up at the deadline instead of holding up Finish', async () => {
  const { sendEmail } = require('../src/notify');
  const net = require('node:net');
  // Accepts the connection and never greets, like a filtered SMTP port.
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s)).listen(0, '127.0.0.1');
  await new Promise((r) => silent.once('listening', r));
  process.env.SMTP_DEADLINE_MS = '400';
  try {
    await withSmtp(silent.address().port, 'x', async () => {
      const started = Date.now();
      const result = await sendEmail('Subject', 'Body');
      assert.ok(Date.now() - started < 2000, `gave up after ${Date.now() - started} ms`);
      assert.equal(result.ok, false);
      assert.match(result.error, /no answer from the server within 0\.4 s/);
    });
  } finally {
    delete process.env.SMTP_DEADLINE_MS;
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

test('guard pages keep chip taps in one tab', async () => {
  const html = await (await fetch(`${base}/walk`)).text();
  assert.match(html, /id="st-nfc"[^>]* hidden/, 'NFC button starts hidden and only shows where Web NFC exists');
  assert.match(html, /new NDEFReader\(\)/);
  assert.match(html, /new BroadcastChannel\('school-tag-guard'\)/);
  for (const m of ['manifest', 'manifest-admin']) {
    const manifest = await (await fetch(`${base}/${m}.webmanifest`)).json();
    assert.deepEqual(manifest.launch_handler, { client_mode: ['navigate-existing', 'auto'] }, m);
  }
});

test('the round email is Georgian HTML listing scanned and missed checkpoints', async () => {
  const { roundEmail } = require('../src/email-template');
  const walkthrough = { id: 'w1', guard_name: 'გიორგი', started_at: '2026-10-23T08:00:00.000Z' };
  const scans = [
    { checkpoint_id: 'aa000001', checkpoint_name: 'სპოტკაფე', checkpoint_location: 'სპოტკაფე', scanned_at: '2026-10-23T08:05:00.000Z' },
    { checkpoint_id: 'aa000002', checkpoint_name: 'Room <b>5</b>', checkpoint_location: '2nd floor', scanned_at: '2026-10-23T08:09:00.000Z' },
  ];
  const missing = [{ name: 'ჭადრაკის ეზო', location: '' }];
  const e = roundEmail({ walkthrough, scans, missing, reason: 'finished early by guard', endedAt: '2026-10-23T08:40:00.000Z', detailsUrl: 'https://x.example/admin/history/w1' });
  assert.match(e.subject, /არ დასკანირებულა 1 წერტილი \(2\/3\)/);
  for (const part of [e.text, e.html]) {
    assert.match(part, /უსაფრთხოების თანამშრომელმა დაასრულა შემოვლა\./);
    assert.match(part, /ჭადრაკის ეზო/);
    assert.match(part, /სპოტკაფე/);
    assert.match(part, /გიორგი/);
    assert.match(part, /40 წთ/);
  }
  assert.match(e.text, /დასკანირებულია: 2 წერტილი\nარ დასკანირებულა: 1 წერტილი/);
  assert.match(e.text, /✓ სპოტკაფე — 12:05/, 'scan time in local time; a location equal to the name is not repeated');
  assert.match(e.text, /✕ ჭადრაკის ეზო/);
  assert.match(e.html, /Room &lt;b&gt;5&lt;\/b&gt; — 2nd floor/, 'names are escaped in HTML');
  assert.doesNotMatch(e.html, /<b>5<\/b>/);
  assert.match(e.html, /href="https:\/\/x\.example\/admin\/history\/w1"/);
  const done = roundEmail({ walkthrough, scans, missing: [], reason: 'completed', endedAt: '2026-10-23T08:40:00.000Z' });
  assert.match(done.subject, /შემოვლა დასრულდა — დასკანირებულია 2\/2/);
  assert.doesNotMatch(done.html, /შემოვლის დეტალები/, 'no button without a public base URL');
  const expired = roundEmail({ walkthrough, scans, missing, reason: 'time expired', endedAt: '2026-10-23T08:40:00.000Z' });
  assert.match(expired.text, /^შემოვლის დრო ამოიწურა\./);
});

test('with a guard password, scanning needs it once per round on each phone', async () => {
  const admin = await adminCookie();
  const form = (body, cookie) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const setCookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
  // Clean slate: no round running, two checkpoints.
  const leftover = await db.getActiveWalkthrough();
  if (leftover) await db.finishWalkthrough(leftover.id, 'cancelled');
  const a = await db.addCheckpoint('Lock A', '');
  const b = await db.addCheckpoint('Lock B', '');
  await fetch(`${base}/admin/settings`, form({ guard_password: '123bga123' }, admin));
  try {
    const stored = await db.getSetting('guard_password_hash');
    assert.match(stored, /^scrypt\$/);
    assert.doesNotMatch(stored, /123bga123/, 'only a hash is stored');

    let html = await (await fetch(`${base}/walk`)).text();
    assert.match(html, /name="password" type="password"/, 'the start form asks for it');

    // Wrong or missing password: no round starts.
    let res = await fetch(`${base}/walkthrough/start`, form({ guard_name: 'Locked', password: 'nope' }));
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Wrong password/);
    assert.equal(await db.getActiveWalkthrough(), null);
    res = await fetch(`${base}/walkthrough/start`, form({ guard_name: 'Locked' }));
    assert.equal(res.status, 401);

    // Right password: the round starts and this phone gets the round cookie.
    res = await fetch(`${base}/walkthrough/start`, form({ guard_name: 'Locked', password: '123bga123', checkpoint_id: a.id }));
    assert.equal(res.status, 302);
    const phone1 = setCookieOf(res);
    assert.match(phone1, /^st_round=/);
    const w = await db.getActiveWalkthrough();
    assert.deepEqual((await db.getScans(w.id)).map((s) => s.checkpoint_id), [a.id]);

    // That phone's taps record without asking again.
    res = await fetch(`${base}/t/${b.id}`, { headers: { Cookie: phone1 } });
    assert.equal(res.status, 200);
    assert.equal((await db.getScans(w.id)).length, 2);

    // Another phone is asked once, and nothing is recorded before that.
    await db.rawExecute('DELETE FROM scans WHERE walkthrough_id = ? AND checkpoint_id = ?', [w.id, b.id]);
    res = await fetch(`${base}/t/${b.id}`);
    assert.equal(res.status, 401);
    assert.match(await res.text(), /action="\/t\/[^"]+\/unlock"/);
    assert.equal((await db.getScans(w.id)).length, 1);
    res = await fetch(`${base}/t/${b.id}/unlock`, form({ password: 'wrong' }));
    assert.equal(res.status, 401);
    res = await fetch(`${base}/t/${b.id}/unlock`, form({ password: '123bga123' }));
    assert.equal(res.status, 302);
    const phone2 = setCookieOf(res);
    res = await fetch(`${base}/t/${b.id}`, { headers: { Cookie: phone2 } });
    assert.equal(res.status, 200);
    assert.equal((await db.getScans(w.id)).length, 2);

    // A cookie from another round doesn't unlock this one; finishing needs it too.
    assert.equal((await fetch(`${base}/walk`, { headers: { Cookie: 'st_round=other.0123456789abcdef0123456789abcdef' } })).status, 401);
    res = await fetch(`${base}/walkthrough/finish`, form({}));
    assert.equal(res.status, 401);
    assert.equal((await db.getWalkthrough(w.id)).status, 'in_progress');

    // An admin session always passes.
    assert.equal((await fetch(`${base}/walk`, { headers: { Cookie: admin } })).status, 200);
    res = await fetch(`${base}/walkthrough/finish`, form({}, phone1));
    assert.equal(res.headers.get('location'), '/walk/done');
  } finally {
    await fetch(`${base}/admin/settings`, form({ guard_password_clear: '1' }, admin));
    const still = await db.getActiveWalkthrough();
    if (still) await db.finishWalkthrough(still.id, 'cancelled');
    await db.deleteCheckpoint(a.id);
    await db.deleteCheckpoint(b.id);
  }
  assert.equal(await db.getSetting('guard_password_hash'), '');
  assert.equal((await fetch(`${base}/walk`)).status, 200, 'no password: open again');
});
