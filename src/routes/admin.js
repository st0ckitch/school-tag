'use strict';

const express = require('express');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const {
  getSetting,
  setSetting,
  getCookieSecret,
  listCheckpoints,
  getCheckpoint,
  addCheckpoint,
  updateCheckpoint,
  deleteCheckpoint,
  getActiveWalkthrough,
  getScans,
  getMissingCheckpoints,
  listWalkthroughs,
  getWalkthrough,
  unacknowledgedAlerts,
  acknowledgeAlert,
  listDevices,
  createEnrollmentCode,
  deleteDevice,
} = require('../db');
const { tick } = require('../scheduler');
const { esc, page } = require('../html');

const router = express.Router();

// Express 4 does not catch async handler rejections — route them to next().
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Admin pages link the separate "School Tag Admin" manifest/icon, so the
// dashboard installs as its own app on the administrator's phone.
const adminPage = (title, body, opts = {}) => page(title, body, { ...opts, admin: true });

// --- tiny signed-cookie session ------------------------------------------

async function sign(value) {
  return crypto.createHmac('sha256', await getCookieSecret()).update(value).digest('hex');
}

async function hasSession(req) {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('session='));
  if (!raw) return false;
  const value = decodeURIComponent(raw.slice('session='.length));
  const idx = value.lastIndexOf('.');
  if (idx < 0) return false;
  const token = value.slice(0, idx);
  const mac = value.slice(idx + 1);
  const expected = await sign(token);
  return (
    mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  );
}

async function requireAdmin(req, res, next) {
  if (await hasSession(req)) return next();
  res.status(401).send(
    adminPage(
      'Admin login',
      `<div class="card" style="max-width:360px;margin:60px auto">
         <h1>Admin login</h1>
         <form method="post" action="/admin/login">
           <label for="pin">PIN</label>
           <input id="pin" name="pin" type="password" inputmode="numeric" autofocus>
           <button class="btn full" type="submit">Log in</button>
         </form>
       </div>`
    )
  );
}

router.post('/admin/login', wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  const expected = String(await getSetting('admin_pin'));
  const a = Buffer.from(pin.padEnd(64));
  const b = Buffer.from(expected.padEnd(64));
  if (pin.length === expected.length && crypto.timingSafeEqual(a, b)) {
    const token = `admin.${Date.now()}`;
    res.setHeader(
      'Set-Cookie',
      `session=${encodeURIComponent(`${token}.${await sign(token)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
    );
    res.redirect('/admin');
    return;
  }
  res.status(401).send(
    adminPage(
      'Admin login',
      `<div class="card" style="max-width:360px;margin:60px auto">
         <h1>Admin login</h1>
         <p class="bad">Wrong PIN.</p>
         <form method="post" action="/admin/login">
           <label for="pin">PIN</label>
           <input id="pin" name="pin" type="password" inputmode="numeric" autofocus>
           <button class="btn full" type="submit">Log in</button>
         </form>
       </div>`
    )
  );
}));

router.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.redirect('/admin');
});

// --- helpers ---------------------------------------------------------------

const NAV_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  print: '<path d="M6 9V3h12v6"/><path d="M6 17H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 13h12v8H6z"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  gear: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--card-bg)"/><circle cx="15" cy="12" r="2" fill="var(--card-bg)"/><circle cx="7" cy="17" r="2" fill="var(--card-bg)"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};

const navIcon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name]}</svg>`;

function nav(active) {
  const items = [
    ['/admin', 'Home', 'home'],
    ['/admin/checkpoints', 'Points', 'pin'],
    ['/admin/tags', 'Tags', 'print'],
    ['/admin/devices', 'Devices', 'phone'],
    ['/admin/history', 'History', 'clock'],
    ['/admin/settings', 'Settings', 'gear'],
  ];
  return `<nav class="topnav no-print">
    ${items
      .map(([href, label, icon]) =>
        href === active
          ? `<span class="navitem active">${navIcon(icon)}<span class="navlbl">${label}</span></span>`
          : `<a class="navitem" href="${href}">${navIcon(icon)}<span class="navlbl">${label}</span></a>`
      )
      .join('')}
    <form method="post" action="/admin/logout" class="navout"><button class="navitem" type="submit" aria-label="Log out">${navIcon('out')}<span class="navlbl">Log out</span></button></form>
  </nav>`;
}

async function baseUrl(req) {
  const configured = ((await getSetting('base_url')) || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers.host}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'Asia/Tbilisi' });
}

const STATUS_PILL = {
  in_progress: '<span class="pill warn">In progress</span>',
  completed: '<span class="pill ok">Completed</span>',
  incomplete: '<span class="pill bad">Incomplete</span>',
};

// --- dashboard --------------------------------------------------------------

router.get('/admin', wrap(requireAdmin), wrap(async (req, res) => {
  await tick();

  const active = await getActiveWalkthrough();
  const alerts = await unacknowledgedAlerts();
  const checkpoints = await listCheckpoints(true);

  let liveCard;
  if (active) {
    const scans = await getScans(active.id);
    const scannedIds = new Set(scans.map((s) => s.checkpoint_id));
    const total = checkpoints.length;
    const pct = total === 0 ? 100 : Math.round((scans.length / total) * 100);
    const minsLeft = Math.max(0, Math.round((new Date(active.deadline).getTime() - Date.now()) / 60000));
    liveCard = `
      <div class="card">
        <h2>Live walkthrough ${STATUS_PILL.in_progress}</h2>
        <div class="sub">Guard: ${esc(active.guard_name || '—')} · Started ${fmtTime(active.started_at)} · ${minsLeft} min left</div>
        <div class="big">${scans.length} / ${total}</div>
        <div class="progressbar"><div style="width:${pct}%"></div></div>
        <ul class="plain">
          ${checkpoints
            .map((c) => {
              const scan = scans.find((s) => s.checkpoint_id === c.id);
              return `<li>
                <span>${esc(c.name)}${c.location ? ` <span class="muted">— ${esc(c.location)}</span>` : ''}</span>
                ${
                  scannedIds.has(c.id)
                    ? `<span class="ok checkmark">✓ <span class="muted" style="font-size:.8rem">${fmtTime(scan.scanned_at)}</span></span>`
                    : '<span class="muted">pending</span>'
                }
              </li>`;
            })
            .join('')}
        </ul>
      </div>`;
  } else {
    liveCard = `
      <div class="card">
        <h2>Live walkthrough</h2>
        <p class="muted">No walkthrough is currently running. A walkthrough starts when a guard scans any tag, or from the <a href="/walk">guard page</a>.</p>
      </div>`;
  }

  const alertsCard = `
    <div class="card">
      <h2>Alerts ${alerts.length ? `<span class="pill bad">${alerts.length} new</span>` : '<span class="pill ok">none</span>'}</h2>
      <button class="btn secondary small no-print" data-label="Admin device" data-done="Notifications enabled" data-denied="Blocked in browser settings" onclick="stEnablePush(this)" style="margin-bottom:12px">🔔 Enable alert notifications on this device</button>
      ${
        alerts.length
          ? `<ul class="plain">${alerts
              .map(
                (a) => `<li>
                  <div>
                    <div style="white-space:pre-line">${esc(a.message)}</div>
                    <div class="muted" style="font-size:.8rem">${fmtTime(a.created_at)}</div>
                  </div>
                  <form method="post" action="/admin/alerts/${a.id}/ack"><button class="btn small secondary" type="submit">Acknowledge</button></form>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="muted">No unacknowledged alerts.</p>'
      }
    </div>`;

  res.send(
    adminPage(
      'Dashboard — School Tag',
      `${nav('/admin')}
       <h1>School security dashboard</h1>
       <div class="sub">${checkpoints.length} active checkpoints</div>
       ${alertsCard}
       ${liveCard}`,
      { refreshSeconds: 10 }
    )
  );
}));

router.post('/admin/alerts/:id/ack', wrap(requireAdmin), wrap(async (req, res) => {
  await acknowledgeAlert(req.params.id);
  res.redirect('/admin');
}));

// --- checkpoints ------------------------------------------------------------

router.get('/admin/checkpoints', wrap(requireAdmin), wrap(async (req, res) => {
  const checkpoints = await listCheckpoints();
  res.send(
    adminPage(
      'Checkpoints — School Tag',
      `${nav('/admin/checkpoints')}
       <h1>Checkpoints</h1>
       <div class="card">
         <h2>Add checkpoint</h2>
         <form method="post" action="/admin/checkpoints">
           <div class="row">
             <div><label for="name">Name</label><input id="name" name="name" required placeholder="e.g. Main entrance"></div>
             <div><label for="location">Location (optional)</label><input id="location" name="location" placeholder="e.g. Ground floor, west wing"></div>
           </div>
           <button class="btn" type="submit">Add</button>
         </form>
       </div>
       <div class="card">
         <table>
           <tr><th>Name</th><th>Location</th><th>Tag URL</th><th>Status</th><th></th></tr>
           ${checkpoints
             .map(
               (c) => `<tr>
                 <td>${esc(c.name)}</td>
                 <td class="muted">${esc(c.location)}</td>
                 <td><code>/t/${esc(c.id)}</code></td>
                 <td>${c.active ? '<span class="pill ok">active</span>' : '<span class="pill warn">disabled</span>'}</td>
                 <td style="white-space:nowrap">
                   <form method="post" action="/admin/checkpoints/${esc(c.id)}/toggle" style="display:inline"><button class="btn small secondary" type="submit">${c.active ? 'Disable' : 'Enable'}</button></form>
                   <form method="post" action="/admin/checkpoints/${esc(c.id)}/delete" style="display:inline" onsubmit="return confirm('Delete checkpoint ${esc(c.name)}? Its scan history stays, but the tag stops working.')"><button class="btn small danger" type="submit">Delete</button></form>
                 </td>
               </tr>`
             )
             .join('')}
         </table>
         ${checkpoints.length === 0 ? '<p class="muted">No checkpoints yet — add 30–35 above, one per tag location.</p>' : ''}
       </div>`
    )
  );
}));

router.post('/admin/checkpoints', wrap(requireAdmin), wrap(async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 120);
  const location = (req.body.location || '').trim().slice(0, 200);
  if (name) await addCheckpoint(name, location);
  res.redirect('/admin/checkpoints');
}));

router.post('/admin/checkpoints/:id/toggle', wrap(requireAdmin), wrap(async (req, res) => {
  const cp = await getCheckpoint(req.params.id);
  if (cp) await updateCheckpoint(cp.id, { active: !cp.active });
  res.redirect('/admin/checkpoints');
}));

router.post('/admin/checkpoints/:id/delete', wrap(requireAdmin), wrap(async (req, res) => {
  await deleteCheckpoint(req.params.id);
  res.redirect('/admin/checkpoints');
}));

// --- printable tag sheet ----------------------------------------------------

router.get('/admin/tags', wrap(requireAdmin), wrap(async (req, res) => {
  const checkpoints = await listCheckpoints(true);
  const base = await baseUrl(req);
  const cards = await Promise.all(
    checkpoints.map(async (c) => {
      const url = `${base}/t/${c.id}`;
      const qr = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      return `<div class="card" style="text-align:center">
        <h2 style="margin-bottom:2px">${esc(c.name)}</h2>
        <div class="muted">${esc(c.location || '')}</div>
        <img src="${qr}" alt="QR for ${esc(c.name)}" style="margin:8px 0">
        <div><code style="font-size:.8rem">${esc(url)}</code></div>
      </div>`;
    })
  );
  res.send(
    adminPage(
      'Tag sheet — School Tag',
      `${nav('/admin/tags')}
       <div class="no-print card">
         <h1>Tag sheet</h1>
         <p>Write each URL below to its NFC tag as an <b>NDEF URL record</b> (use a free app like
            <b>NFC Tools</b> on Android or iPhone: Write → Add a record → URL → paste → Write, then
            optionally lock the tag so it can't be rewritten). The QR code is a fallback — print this
            page and stick the QR next to the tag for phones without NFC.</p>
         <button class="btn" onclick="window.print()">Print</button>
       </div>
       ${cards.join('')}
       ${checkpoints.length === 0 ? '<p class="muted">No active checkpoints. Add them on the Checkpoints page first.</p>' : ''}`
    )
  );
}));

// --- devices (two-phone access limit) ---------------------------------------

async function devicesPage(req, enrollUrl) {
  const devices = await listDevices();
  const enforcing = (await getSetting('require_enrolled_device')) === '1';
  const max = await getSetting('max_devices');

  const enrollCard = enrollUrl
    ? `<div class="card" style="text-align:center">
         <h2>Enrollment link (valid 30 min, one use)</h2>
         <img src="${await QRCode.toDataURL(enrollUrl, { width: 220, margin: 1 })}" alt="Enrollment QR">
         <div><code style="font-size:.8rem">${esc(enrollUrl)}</code></div>
         <p class="muted">Scan this QR (or open the link) on the phone you want to allow, then press Enroll there.</p>
       </div>`
    : '';

  return adminPage(
    'Devices — School Tag',
    `${nav('/admin/devices')}
     <h1>Allowed devices</h1>
     <div class="sub">${devices.length} of ${esc(max)} enrolled · enforcement ${enforcing ? '<span class="pill ok">ON</span>' : '<span class="pill warn">OFF</span>'}</div>
     ${enrollCard}
     <div class="card">
       <table>
         <tr><th>Name</th><th>Enrolled</th><th>Last seen</th><th></th></tr>
         ${devices
           .map(
             (d) => `<tr>
               <td>${esc(d.name || d.id)}</td>
               <td class="muted">${fmtTime(d.enrolled_at)}</td>
               <td class="muted">${fmtTime(d.last_seen)}</td>
               <td><form method="post" action="/admin/devices/${esc(d.id)}/delete" onsubmit="return confirm('Remove device ${esc(d.name || d.id)}? It will lose access immediately.')"><button class="btn small danger" type="submit">Remove</button></form></td>
             </tr>`
           )
           .join('')}
       </table>
       ${devices.length === 0 ? '<p class="muted">No devices enrolled yet.</p>' : ''}
       <form method="post" action="/admin/devices/enroll-code" style="margin-top:12px">
         <button class="btn" type="submit">Generate enrollment link</button>
       </form>
     </div>
     <form method="post" action="/admin/devices/settings">
       <div class="card">
         <h2>Enforcement</h2>
         <label><input type="checkbox" name="require_enrolled_device" value="1" ${enforcing ? 'checked' : ''} style="width:auto;margin-right:8px"> Only enrolled devices can scan tags and run walkthroughs</label>
         ${enforcing && devices.length === 0 ? '<p class="bad">Warning: enforcement is ON but no devices are enrolled — no phone can scan right now.</p>' : ''}
         <label for="max_devices" style="margin-top:12px">Maximum devices</label>
         <input id="max_devices" name="max_devices" type="number" min="1" max="20" value="${esc(max)}">
         <button class="btn" type="submit">Save</button>
       </div>
     </form>`
  );
}

router.get('/admin/devices', wrap(requireAdmin), wrap(async (req, res) => {
  res.send(await devicesPage(req));
}));

router.post('/admin/devices/enroll-code', wrap(requireAdmin), wrap(async (req, res) => {
  const code = await createEnrollmentCode();
  const enrollUrl = `${await baseUrl(req)}/enroll/${code}`;
  res.send(await devicesPage(req, enrollUrl));
}));

router.post('/admin/devices/:id/delete', wrap(requireAdmin), wrap(async (req, res) => {
  await deleteDevice(req.params.id);
  res.redirect('/admin/devices');
}));

router.post('/admin/devices/settings', wrap(requireAdmin), wrap(async (req, res) => {
  await setSetting('require_enrolled_device', req.body.require_enrolled_device === '1' ? '1' : '0');
  const max = parseInt(req.body.max_devices, 10);
  if (Number.isInteger(max) && max >= 1 && max <= 20) await setSetting('max_devices', String(max));
  res.redirect('/admin/devices');
}));

// --- history ----------------------------------------------------------------

router.get('/admin/history', wrap(requireAdmin), wrap(async (req, res) => {
  const walks = await listWalkthroughs(50);
  res.send(
    adminPage(
      'History — School Tag',
      `${nav('/admin/history')}
       <h1>Walkthrough history</h1>
       <div class="card">
         <table>
           <tr><th>Started</th><th>Guard</th><th>Scanned</th><th>Status</th><th></th></tr>
           ${walks
             .map(
               (w) => `<tr>
                 <td>${fmtTime(w.started_at)}</td>
                 <td>${esc(w.guard_name || '—')}</td>
                 <td>${w.scanned_count} / ${w.total_checkpoints}</td>
                 <td>${STATUS_PILL[w.status] || esc(w.status)}</td>
                 <td><a href="/admin/history/${esc(w.id)}">details</a></td>
               </tr>`
             )
             .join('')}
         </table>
         ${walks.length === 0 ? '<p class="muted">No walkthroughs yet.</p>' : ''}
       </div>`
    )
  );
}));

router.get('/admin/history/:id', wrap(requireAdmin), wrap(async (req, res) => {
  const w = await getWalkthrough(req.params.id);
  if (!w) return res.redirect('/admin/history');
  const scans = await getScans(w.id);
  const missing = w.status === 'in_progress' ? await getMissingCheckpoints(w.id) : [];
  const allCheckpoints = await listCheckpoints();
  const scannedIds = new Set(scans.map((s) => s.checkpoint_id));
  const missed = allCheckpoints.filter((c) => c.active && !scannedIds.has(c.id));
  res.send(
    adminPage(
      'Walkthrough — School Tag',
      `${nav('/admin/history')}
       <h1>Walkthrough ${fmtTime(w.started_at)}</h1>
       <div class="sub">Guard: ${esc(w.guard_name || '—')} · ${STATUS_PILL[w.status] || esc(w.status)} · Finished: ${fmtTime(w.completed_at)}</div>
       <div class="card">
         <h2>Scanned (${scans.length})</h2>
         <ul class="plain">
           ${scans.map((s) => `<li><span>${esc(s.checkpoint_name || s.checkpoint_id)}</span><span class="muted">${fmtTime(s.scanned_at)}</span></li>`).join('')}
         </ul>
         ${scans.length === 0 ? '<p class="muted">Nothing scanned.</p>' : ''}
       </div>
       ${
         w.status !== 'completed' && (missed.length || missing.length)
           ? `<div class="card">
                <h2 class="bad">Missed (${missed.length})</h2>
                <ul class="plain">${missed.map((c) => `<li>${esc(c.name)}${c.location ? ` <span class="muted">— ${esc(c.location)}</span>` : ''}</li>`).join('')}</ul>
              </div>`
           : ''
       }`
    )
  );
}));

// --- settings ---------------------------------------------------------------

router.get('/admin/settings', wrap(requireAdmin), wrap(async (req, res) => {
  const walkDurationMinutes = await getSetting('walk_duration_minutes');
  const ntfyTopic = await getSetting('ntfy_topic');
  const webhookUrl = await getSetting('webhook_url');
  const baseUrlValue = await getSetting('base_url');
  const adminPin = await getSetting('admin_pin');
  const androidPackage = (await getSetting('android_package')) || '';
  const androidSha256 = (await getSetting('android_sha256')) || '';
  res.send(
    adminPage(
      'Settings — School Tag',
      `${nav('/admin/settings')}
       <h1>Settings</h1>
       <form method="post" action="/admin/settings">
         <div class="card">
           <h2>Walkthrough</h2>
           <label for="walk_duration_minutes">Time limit for one walkthrough (minutes). If the guard has not scanned every tag within this time, an alert is sent.</label>
           <input id="walk_duration_minutes" name="walk_duration_minutes" type="number" min="5" max="720" value="${esc(walkDurationMinutes)}">
         </div>
         <div class="card">
           <h2>Alert delivery</h2>
           <label for="ntfy_topic">ntfy topic — install the free <b>ntfy</b> app on the phones that should receive alerts and subscribe them to this topic (pick something hard to guess, e.g. <code>myschool-security-x7k2</code>)</label>
           <input id="ntfy_topic" name="ntfy_topic" value="${esc(ntfyTopic)}" placeholder="myschool-security-x7k2">
           <label for="webhook_url">Webhook URL (optional) — alerts are also POSTed here as JSON</label>
           <input id="webhook_url" name="webhook_url" value="${esc(webhookUrl)}" placeholder="https://...">
         </div>
         <div class="card">
           <h2>System</h2>
           <label for="base_url">Public base URL of this server (used in tag URLs and QR codes)</label>
           <input id="base_url" name="base_url" value="${esc(baseUrlValue)}" placeholder="https://security.myschool.ge">
           <label for="admin_pin">Admin PIN</label>
           <input id="admin_pin" name="admin_pin" value="${esc(adminPin)}">
         </div>
         <div class="card">
           <h2>Android APK</h2>
           <p class="muted">Fill these after building the APK (the build prints both values) to verify the app and hide the browser bar. Served at <code>/.well-known/assetlinks.json</code>.</p>
           <label for="android_package">Package id</label>
           <input id="android_package" name="android_package" value="${esc(androidPackage)}" placeholder="com.schooltag.app">
           <label for="android_sha256">Signing certificate SHA-256 fingerprint</label>
           <input id="android_sha256" name="android_sha256" value="${esc(androidSha256)}" placeholder="AA:BB:CC:...">
         </div>
         <button class="btn" type="submit">Save</button>
       </form>`
    )
  );
}));

router.post('/admin/settings', wrap(requireAdmin), wrap(async (req, res) => {
  for (const key of ['walk_duration_minutes', 'ntfy_topic', 'webhook_url', 'base_url', 'admin_pin', 'android_package', 'android_sha256']) {
    if (req.body[key] !== undefined) await setSetting(key, String(req.body[key]).trim());
  }
  res.redirect('/admin/settings');
}));

// --- JSON state (for integrations / monitoring) ----------------------------

router.get('/api/state', wrap(requireAdmin), wrap(async (req, res) => {
  const active = await getActiveWalkthrough();
  const activeCheckpoints = await listCheckpoints(true);
  let walkthrough = null;
  if (active) {
    const scans = await getScans(active.id);
    const missing = await getMissingCheckpoints(active.id);
    walkthrough = {
      id: active.id,
      guard: active.guard_name,
      started_at: active.started_at,
      deadline: active.deadline,
      scanned: scans.length,
      missing: missing.map((c) => c.name),
    };
  }
  const alerts = await unacknowledgedAlerts();
  res.json({
    checkpoints: activeCheckpoints.length,
    walkthrough,
    unacknowledged_alerts: alerts.length,
  });
}));

module.exports = router;
// Reused by server.js to authorize push subscriptions from an admin browser.
module.exports.hasSession = hasSession;
