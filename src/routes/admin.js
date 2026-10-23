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
  walkthroughsSince,
  scanTimesSince,
  mostMissedCheckpoints,
  getWalkthrough,
  unacknowledgedAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  listDevices,
  createEnrollmentCode,
  deleteDevice,
  markLinked,
  linkTag,
  alertsForWalkthrough,
} = require('../db');
const { tick } = require('../scheduler');
const { sendEmail, lastEmailResult, emailLog, parseRecipients } = require('../notify');
const { resetInfo } = require('../school-checkpoints');
const { esc, page, icon, ring, place, ka } = require('../html');
const { areaChart, sparkline } = require('../charts');
const { testEmail } = require('../email-template');

const router = express.Router();

// Express 4 does not catch async handler rejections — route them to next().
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Admin pages link the separate "School Tag Admin" manifest/icon, so the
// dashboard installs as its own app on the administrator's phone. A page
// that names its `active` section gets the app shell (sidebar on desktop,
// tab bar on phones, top bar with the alert bell); the rest are centred.
async function adminPage(title, body, opts = {}) {
  const shell = opts.active
    ? { active: opts.active, alerts: (await unacknowledgedAlerts()).length, query: opts.query || '' }
    : null;
  return page(title, body, { ...opts, admin: true, shell, center: !shell });
}

// --- tiny signed-cookie session ------------------------------------------

async function sign(value) {
  return crypto.createHmac('sha256', await getCookieSecret()).update(value).digest('hex');
}

// Runs on every chip tap, so a malformed cookie must read as "not logged in"
// rather than throw (bad percent-encoding, multi-byte MAC characters).
async function hasSession(req) {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('session='));
  if (!raw) return false;
  let value;
  try {
    value = decodeURIComponent(raw.slice('session='.length));
  } catch (err) {
    return false;
  }
  const idx = value.lastIndexOf('.');
  if (idx < 0) return false;
  const token = value.slice(0, idx);
  const mac = Buffer.from(value.slice(idx + 1));
  const expected = Buffer.from(await sign(token));
  return mac.length === expected.length && crypto.timingSafeEqual(mac, expected);
}

// Status messages travel in the redirect URL; the signature stops anyone from
// sending the admin a link that shows invented text inside the admin UI.
async function flashUrl(path, key, text) {
  const value = String(text).toWellFormed();
  const sig = (await sign(`flash:${key}:${value}`)).slice(0, 32);
  return `${path}?${key}=${encodeURIComponent(value)}&sig=${sig}`;
}

async function readFlash(req, key) {
  const value = req.query[key];
  const sig = req.query.sig;
  if (typeof value !== 'string' || !value || typeof sig !== 'string') return '';
  const expected = Buffer.from((await sign(`flash:${key}:${value}`)).slice(0, 32));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? value : '';
}

function loginCard(error) {
  return `<div class="card">
    <h1>Admin login</h1>
    <p class="sub">Enter the admin PIN to manage checkpoints, rounds and alerts.</p>
    ${error ? `<p><span class="pill bad">${icon('alert')}${esc(error)}</span></p>` : ''}
    <form method="post" action="/admin/login">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus>
      <button class="btn full" type="submit">Log in</button>
    </form>
  </div>`;
}

async function requireAdmin(req, res, next) {
  if (await hasSession(req)) return next();
  res.status(401).send(
    await adminPage('Admin login', loginCard())
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
    await adminPage('Admin login', loginCard('Wrong PIN.'))
  );
}));

router.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.redirect('/admin');
});

// --- helpers ---------------------------------------------------------------

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
  in_progress: `<span class="pill info">${icon('dot')}In progress</span>`,
  completed: `<span class="pill ok">${icon('check')}Completed</span>`,
  incomplete: `<span class="pill bad">${icon('alert')}Incomplete</span>`,
  cancelled: `<span class="pill">${icon('x')}Cancelled</span>`,
};

// --- dashboard --------------------------------------------------------------

const TZ = process.env.TZ || 'Asia/Tbilisi';
const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (t) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
// A day key ("2026-10-23") at local noon, for labels.
const dayLabel = (key, opts) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: TZ, ...opts });

const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

// "23 Oct, 11:53" — compact, for tables.
const fmtShort = (iso) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function fmtDuration(ms) {
  if (!(ms >= 0)) return '—';
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function timeAgo(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

// Change against the previous period: arrow + size, green when it moved the
// good way, red when the bad way, gray when either way is fine.
function delta(cur, prev, { goodUp = true, unit = '', digits = 0, note = 'vs last week' } = {}) {
  if (cur === null || prev === null) return `<span class="delta-note" style="margin:0">${prev === null ? 'No earlier data yet' : ''}</span>`;
  const d = cur - prev;
  const shown = Math.abs(d).toFixed(digits);
  if (Number(shown) === 0) return `<span class="delta flat">No change</span><span class="delta-note">${note}</span>`;
  const up = d > 0;
  const tone = goodUp === null ? 'flat' : up === goodUp ? 'good' : 'bad';
  const spoken = `${up ? 'up' : 'down'}${tone === 'good' ? ', better' : tone === 'bad' ? ', worse' : ''}`;
  return `<span class="delta ${tone}">${icon(up ? 'arrowUp' : 'arrowDown')}${up ? '+' : '−'}${shown}${unit}<span class="sr-only"> (${spoken})</span></span><span class="delta-note">${note}</span>`;
}

const statTile = ({ label, value, deltaHtml, tile, ic }) => `
  <div class="card stat">
    <div style="min-width:0"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${deltaHtml}</div>
    <span class="tile ${tile}">${icon(ic)}</span>
  </div>`;

const miniCard = ({ label, value, deltaHtml, spark }) => `
  <div class="card mini">
    <div style="min-width:0"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${deltaHtml}</div>
    ${spark}
  </div>`;

// Rounds as table rows: the start time links to the round's page.
function roundsTable(walks) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Round</th><th class="hide-sm">Guard</th><th>Scanned</th><th class="num hide-sm">Time</th><th>Status</th></tr></thead>
    <tbody>${walks
      .map((w) => {
        const pct = w.total_checkpoints ? Math.round((100 * Math.min(w.scanned_count, w.total_checkpoints)) / w.total_checkpoints) : 0;
        const took = w.completed_at ? fmtDuration(Date.parse(w.completed_at) - Date.parse(w.started_at)) : '—';
        return `<tr>
          <td style="white-space:nowrap"><a href="/admin/history/${encodeURIComponent(w.id)}">${fmtShort(w.started_at)}</a></td>
          <td class="hide-sm">${ka(w.guard_name || '—')}</td>
          <td><div style="display:flex;align-items:center;gap:8px"><span class="num">${w.scanned_count}/${w.total_checkpoints}</span><div class="bar-track hide-sm" style="flex:1;max-width:90px"><div style="width:${pct}%"></div></div></div></td>
          <td class="num hide-sm">${took}</td>
          <td>${STATUS_PILL[w.status] || esc(w.status)}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

router.get('/admin', wrap(requireAdmin), wrap(async (req, res) => {
  await tick();
  const now = Date.now();
  const active = await getActiveWalkthrough();
  const alerts = await unacknowledgedAlerts();
  const checkpoints = await listCheckpoints(true);
  const walks = await walkthroughsSince(new Date(now - 15 * DAY_MS).toISOString());
  const scanTimes = await scanTimesSince(new Date(now - 15 * DAY_MS).toISOString());
  const missedTop = await mostMissedCheckpoints(new Date(now - 30 * DAY_MS).toISOString(), 5);
  const recent = await listWalkthroughs(8);

  // The last 14 local days; the latest 7 are "this week", the 7 before "last week".
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(now - i * DAY_MS));
  const group = (items, keyOf) => {
    const map = new Map(days.map((d) => [d, []]));
    for (const it of items) map.get(keyOf(it))?.push(it);
    return map;
  };
  const walksByDay = group(walks, (w) => dayKey(w.started_at));
  const scansByDay = group(scanTimes, (t) => dayKey(t));
  const inDays = (keys) => keys.flatMap((d) => walksByDay.get(d));
  const thisWeek = inDays(days.slice(7));
  const lastWeek = inDays(days.slice(0, 7));

  const finished = (ws) => ws.filter((w) => w.status === 'completed' || w.status === 'incomplete');
  const rate = (ws) => {
    const f = finished(ws);
    return f.length ? Math.round((100 * f.filter((w) => w.status === 'completed').length) / f.length) : null;
  };
  const missed = (ws) =>
    ws.filter((w) => w.status === 'incomplete').reduce((s, w) => s + Math.max(0, w.total_checkpoints - w.scanned_count), 0);
  const avgMinutes = (ws) => {
    const done = ws.filter((w) => w.status === 'completed' && w.completed_at);
    return done.length ? done.reduce((s, w) => s + Date.parse(w.completed_at) - Date.parse(w.started_at), 0) / done.length / 60000 : null;
  };
  const coverage = (ws) => {
    const f = finished(ws).filter((w) => w.total_checkpoints > 0);
    return f.length ? (100 * f.reduce((s, w) => s + Math.min(1, w.scanned_count / w.total_checkpoints), 0)) / f.length : null;
  };
  const perDay = (ws) => ws.length / 7;

  const today = days[13];
  const linked = checkpoints.filter((c) => c.is_linked).length;
  const unlinked = checkpoints.length - linked;
  const kpis = [
    statTile({
      label: 'Rounds today',
      value: walksByDay.get(today).length,
      deltaHtml: delta(walksByDay.get(today).length, walksByDay.get(days[12]).length, { note: 'vs yesterday' }),
      tile: 'violet',
      ic: 'route',
    }),
    statTile({
      label: 'Completion rate',
      value: rate(thisWeek) === null ? '—' : `${rate(thisWeek)}%`,
      deltaHtml: delta(rate(thisWeek), rate(lastWeek), { unit: ' pts' }),
      tile: 'green',
      ic: 'checkCircle',
    }),
    statTile({
      label: 'Missed this week',
      value: missed(thisWeek),
      deltaHtml: delta(missed(thisWeek), lastWeek.length ? missed(lastWeek) : null, { goodUp: false }),
      tile: 'pink',
      ic: 'alert',
    }),
    statTile({
      label: 'Chips linked',
      value: `${linked}<small> / ${checkpoints.length}</small>`,
      deltaHtml: unlinked
        ? `<a class="delta bad" href="/admin/checkpoints">${unlinked} not linked yet</a>`
        : `<span class="delta good">${icon('check')}All linked</span>`,
      tile: 'blue',
      ic: 'nfc',
    }),
  ];

  const roundsNote = (ws) => {
    if (!ws.length) return 'no rounds';
    const bad = ws.filter((w) => w.status === 'incomplete').length;
    return `${ws.length} round${ws.length === 1 ? '' : 's'}${bad ? `, ${bad} incomplete` : ''}`;
  };
  const scansThisWeek = days.slice(7).reduce((s, d) => s + scansByDay.get(d).length, 0);
  const scansLastWeek = days.slice(0, 7).reduce((s, d) => s + scansByDay.get(d).length, 0);
  const chart = areaChart({
    id: 'scans-chart',
    unit: 'scans',
    caption: 'Checkpoint scans per day, last 14 days',
    points: days.map((d) => ({
      label: dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' }),
      short: dayLabel(d, { day: 'numeric', month: 'short' }),
      value: scansByDay.get(d).length,
      note: roundsNote(walksByDay.get(d)),
    })),
  });

  const avgNow = avgMinutes(thisWeek);
  const covNow = coverage(thisWeek);
  const minis = [
    miniCard({
      label: 'Average round time',
      value: avgNow === null ? '—' : `${Math.round(avgNow)}<small> min</small>`,
      deltaHtml: delta(avgNow, avgMinutes(lastWeek), { goodUp: null, unit: ' min' }),
      spark: sparkline(days.map((d) => avgMinutes(walksByDay.get(d)))),
    }),
    miniCard({
      label: 'Rounds per day',
      value: perDay(thisWeek).toFixed(1).replace(/\.0$/, ''),
      deltaHtml: delta(perDay(thisWeek), lastWeek.length ? perDay(lastWeek) : null, { digits: 1 }),
      spark: sparkline(days.map((d) => walksByDay.get(d).length)),
    }),
    miniCard({
      label: 'Checkpoints covered',
      value: covNow === null ? '—' : `${Math.round(covNow)}%`,
      deltaHtml: delta(covNow === null ? null : Math.round(covNow), coverage(lastWeek) === null ? null : Math.round(coverage(lastWeek)), { unit: ' pts' }),
      spark: sparkline(days.map((d) => coverage(walksByDay.get(d))), 7, [0, 100]),
    }),
  ];

  let liveCard = '';
  if (active) {
    const scans = await getScans(active.id);
    const missing = await getMissingCheckpoints(active.id);
    const total = scans.length + missing.length;
    const timeInfo = active.deadline
      ? `${Math.max(0, Math.round((new Date(active.deadline).getTime() - now) / 60000))} min left`
      : 'No time limit';
    liveCard = `
      <div class="card">
        <div class="card-head"><h2>Live round ${STATUS_PILL.in_progress}</h2><a class="btn secondary small" href="/admin/history/${encodeURIComponent(active.id)}">Details</a></div>
        <div class="ring-card">
          ${ring(scans.length, total, 'scanned')}
          <div style="min-width:0">
            <div class="stat-label">Guard</div><div style="font-weight:700;margin-bottom:8px">${ka(active.guard_name || '—')}</div>
            <div class="muted" style="font-size:.88rem">Started ${timeAgo(active.started_at)} · ${timeInfo}</div>
            ${scans.length ? `<div class="muted" style="font-size:.88rem">Last scan ${timeAgo(scans[scans.length - 1].scanned_at)}</div>` : ''}
          </div>
        </div>
        ${
          missing.length
            ? `<h3 style="margin-top:18px">Still to scan (${missing.length})</h3>
               <div class="row" style="gap:6px">${missing.map((c) => `<span class="pill" style="flex:none">${ka(c.name)}</span>`).join('')}</div>`
            : '<p class="ok" style="margin-top:14px;font-weight:700">All checkpoints scanned — waiting for the guard to finish.</p>'
        }
      </div>`;
  }

  // Newest three alerts, one line each; the missed list opens on demand.
  const alertsCard = alerts.length
    ? `<div class="card" id="alerts">
        <div class="card-head">
          <h2>Alerts <span class="pill bad">${icon('alert')}${alerts.length} new</span></h2>
          <form method="post" action="/admin/alerts/ack-all" class="no-print"><button class="btn ghost small" type="submit">Acknowledge all</button></form>
        </div>
        <ul class="plain">${alerts
          .slice(0, 3)
          .map((a) => {
            const [first, ...rest] = String(a.message).split('\n');
            return `<li class="wrap" style="align-items:flex-start">
              <span class="tile pink sm">${icon('alert')}</span>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600">${ka(first)}</div>
                <div class="muted" style="font-size:.8rem">${fmtTime(a.created_at)}</div>
                ${rest.length ? `<details class="cp-edit"><summary>Show checkpoints</summary><div style="white-space:pre-line;margin-top:6px">${ka(rest.join('\n'))}</div></details>` : ''}
              </div>
              <form method="post" action="/admin/alerts/${a.id}/ack"><button class="btn small secondary" type="submit">Acknowledge</button></form>
            </li>`;
          })
          .join('')}</ul>
        ${alerts.length > 3 ? `<p class="muted" style="margin:10px 0 0;font-size:.85rem">+${alerts.length - 3} older alert${alerts.length - 3 === 1 ? '' : 's'} — see History, or acknowledge all.</p>` : ''}
      </div>`
    : '';

  const recentCard = `
    <div class="card">
      <div class="card-head"><h2>Recent rounds</h2><a href="/admin/history" class="btn ghost small">View all</a></div>
      ${recent.length ? roundsTable(recent) : '<p class="muted">No rounds yet. A round starts when a guard scans any tag.</p>'}
    </div>`;

  const topMissed = Math.max(1, ...missedTop.map((c) => c.missed));
  const missedCard = `
    <div class="card">
      <div class="card-head"><h2>Most missed checkpoints</h2><span class="muted" style="font-size:.82rem">last 30 days</span></div>
      ${
        missedTop.length
          ? `<ul class="plain">${missedTop
              .map(
                (c) => `<li class="bars">
                  <span style="min-width:0;flex:1">${ka(c.name)}</span>
                  <div class="bar-track" style="width:22%;flex:none"><div style="width:${Math.round((100 * c.missed) / topMissed)}%"></div></div>
                  <span class="num" style="width:5.5em;text-align:right;font-weight:700">${c.missed} round${c.missed === 1 ? '' : 's'}</span>
                </li>`
              )
              .join('')}</ul>`
          : `<p class="ok" style="display:flex;gap:8px;align-items:center">${icon('checkCircle')}No checkpoint was missed in the last 30 days.</p>`
      }
    </div>`;

  res.send(
    await adminPage(
      'Dashboard — School Tag',
      `<div class="page-head">
         <div><h1>School security dashboard</h1>
           <div class="sub">${new Date(now).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })} · ${checkpoints.length} active checkpoints · ${active ? 'round in progress' : 'no round running'} · updates automatically</div></div>
         <div class="row no-print" style="flex:none">
           <button class="btn secondary small" data-label="Admin device" data-done="Alerts enabled on this device" data-denied="Blocked in browser settings" onclick="stEnablePush(this)">${icon('bell')}Enable alerts here</button>
           <a class="btn small" href="/walk">${icon('route')}Guard app</a>
         </div>
       </div>
       <div class="grid kpis">${kpis.join('')}</div>
       ${liveCard && alertsCard ? `<div class="grid split start">${liveCard}${alertsCard}</div>` : liveCard || alertsCard}
       <div class="grid split">
         <div class="card">
           <div class="card-head">
             <div><h2 style="margin-bottom:4px">Checkpoint scans</h2>
               <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span class="stat-value" style="margin:0">${scansThisWeek}</span><span class="muted">this week</span>${delta(scansThisWeek, scansLastWeek)}</div></div>
             <span class="pill">Last 14 days</span>
           </div>
           ${chart}
         </div>
         <div class="stack">${minis.join('')}</div>
       </div>
       <div class="grid split start">${recentCard}${missedCard}</div>`,
      { active: '/admin', refreshSeconds: active ? 10 : 60 }
    )
  );
}));

router.post('/admin/alerts/ack-all', wrap(requireAdmin), wrap(async (req, res) => {
  await acknowledgeAllAlerts();
  res.redirect('/admin');
}));

router.post('/admin/alerts/:id/ack', wrap(requireAdmin), wrap(async (req, res) => {
  await acknowledgeAlert(req.params.id);
  res.redirect('/admin');
}));

// --- checkpoints ------------------------------------------------------------

router.get('/admin/checkpoints', wrap(requireAdmin), wrap(async (req, res) => {
  const checkpoints = await listCheckpoints();
  const flashMsg = await readFlash(req, 'msg');
  const flashErr = await readFlash(req, 'err');
  const activeReal = checkpoints.filter((c) => c.active && !c.placeholder);
  const unlinkedCount = activeReal.filter((c) => !c.is_linked).length;
  const query = String(req.query.q || '').trim().slice(0, 80);
  const needle = query.toLowerCase();
  const shown = needle
    ? checkpoints.filter((c) => [c.name, c.location, c.id].some((v) => String(v || '').toLowerCase().includes(needle)))
    : checkpoints;
  const rows = shown
    .map(
      (c, i) => `<li class="cp-row">
        <span class="cp-num">${i + 1}</span>
        <div class="cp-main">
          <div class="cp-title">${place(c.name, c.location)}</div>
          <div class="cp-meta">
            <code>/t/${esc(c.id)}</code>
            ${c.active ? `<span class="pill ok">${icon('check')}Active</span>` : `<span class="pill">${icon('x')}Disabled</span>`}
            ${c.is_linked ? `<span class="pill info" title="A chip is bound to this checkpoint">${icon('nfc')}Linked</span>` : `<span class="pill warn" title="No chip bound yet — tap the chip with an admin-logged-in phone">${icon('alert')}Not linked</span>`}
          </div>
          <details class="cp-edit">
            <summary>Edit</summary>
            <form method="post" action="/admin/checkpoints/${esc(c.id)}/update" class="row" style="align-items:flex-end;margin-top:10px">
              <div><label>Name<input name="name" value="${esc(c.name)}" style="margin:6px 0 0"></label></div>
              <div><label>Location<input name="location" value="${esc(c.location)}" placeholder="Location" style="margin:6px 0 0"></label></div>
              <button class="btn small" type="submit" style="flex:none">Save</button>
            </form>
          </details>
        </div>
        <div class="cp-actions">
          <form method="post" action="/admin/checkpoints/${esc(c.id)}/toggle"><button class="btn small secondary" type="submit">${c.active ? 'Disable' : 'Enable'}</button></form>
          <form method="post" action="/admin/checkpoints/${esc(c.id)}/delete" data-confirm="${esc(`Delete checkpoint ${c.name}? Its scan history stays, but the tag stops working.`)}" onsubmit="return confirm(this.dataset.confirm)"><button class="btn small ghost" type="submit" aria-label="Delete ${esc(c.name)}" style="color:var(--bad)">Delete</button></form>
        </div>
      </li>`
    )
    .join('');
  res.send(
    await adminPage(
      'Checkpoints — School Tag',
      `<div class="page-head">
         <div><h1>Checkpoints</h1>
           <div class="sub">${activeReal.length - unlinkedCount} of ${activeReal.length} linked to a chip${
             unlinkedCount
               ? ` · <b>${unlinkedCount} not linked yet</b>: log in here on your phone, then tap each chip — the phone asks which checkpoint it is.`
               : ''
           }</div></div>
         <div class="row no-print" style="flex:none">
           <a class="btn secondary small" href="/admin/tags">${icon('tag')}Tag sheet</a>
           <a class="btn small" href="#add">${icon('plus')}Add checkpoint</a>
         </div>
       </div>
       ${flashMsg ? `<div class="card" style="padding:14px 18px"><span class="ok" style="font-weight:700">✓ ${esc(flashMsg)}</span></div>` : ''}
       ${flashErr ? `<div class="card" style="padding:14px 18px"><span class="bad" style="font-weight:700">✕ ${esc(flashErr)}</span></div>` : ''}
       <div class="card">
         <div class="card-head">
           <h2>${needle ? `Matching “${esc(query)}” <span class="pill">${shown.length} of ${checkpoints.length}</span>` : `All checkpoints <span class="pill">${checkpoints.length}</span>`}</h2>
           <form method="get" action="/admin/checkpoints" class="m-only" role="search" style="flex:1;max-width:320px">
             <input type="search" name="q" value="${esc(query)}" placeholder="Search checkpoints…" aria-label="Search checkpoints" style="margin:0">
           </form>
           ${needle ? '<a class="btn ghost small" href="/admin/checkpoints">Clear search</a>' : ''}
         </div>
         ${
           shown.length
             ? `<ul class="plain cp-table">${rows}</ul>`
             : `<p class="muted">${checkpoints.length ? 'No checkpoint matches that search.' : 'No checkpoints yet — add 30–35 below, one per tag location.'}</p>`
         }
       </div>
       <div class="grid halves">
         <div class="card" id="add">
           <h2>Add checkpoint</h2>
           <form method="post" action="/admin/checkpoints">
             <label for="name">Name</label><input id="name" name="name" required placeholder="e.g. Main entrance">
             <label for="location">Location (optional)</label><input id="location" name="location" placeholder="e.g. Ground floor, west wing">
             <label for="tag_code">Tag code — only when restoring an already-written chip (the 8-character code from its URL, e.g. <code>63f91d85</code>)</label>
             <input id="tag_code" name="tag_code" pattern="[0-9a-fA-F]{6,16}" placeholder="leave empty for a new tag">
             <button class="btn" type="submit">${icon('plus')}Add</button>
           </form>
         </div>
         <div class="card">
           <h2>Bulk restore</h2>
           <p class="muted">One item per line (numbered lists like <code>1. Name, 2. Name</code> work too):</p>
           <ul class="muted" style="font-size:.88rem;margin-top:0;padding-left:18px">
             <li><code>Name</code> — creates a checkpoint; tap its chip later with an admin-logged-in phone to link it.</li>
             <li><code>tagcode, Name, Location</code> — binds that chip to the checkpoint with that name (or creates it).</li>
             <li>Anything containing tag links (Railway logs, browser history, URL lists) — every <code>/t/code</code> found is added as "Tag code". In such a paste only lines with codes are used; other text is ignored.</li>
           </ul>
           <form method="post" action="/admin/checkpoints/bulk">
             <textarea name="bulk" rows="7" placeholder="63f91d85, Main entrance, Ground floor&#10;ece2c3ac, Gym&#10;dfbedd8d, Library, 1st floor"></textarea>
             <button class="btn secondary" type="submit">Restore all</button>
           </form>
         </div>
       </div>`,
      { active: '/admin/checkpoints', query }
    )
  );
}));

router.post('/admin/checkpoints', wrap(requireAdmin), wrap(async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 120);
  const location = (req.body.location || '').trim().slice(0, 200);
  const tagCodeRaw = (req.body.tag_code || '').trim().toLowerCase();
  if (tagCodeRaw && !/^[0-9a-f]{6,16}$/.test(tagCodeRaw)) {
    return res.redirect(await flashUrl('/admin/checkpoints', 'err', 'Tag code must be 6-16 characters of 0-9 and a-f.'));
  }
  if (name) {
    const created = await addCheckpoint(name, location, tagCodeRaw || undefined);
    if (!created) {
      return res.redirect(await flashUrl('/admin/checkpoints', 'err', `A checkpoint with tag code ${tagCodeRaw} already exists.`));
    }
  }
  res.redirect('/admin/checkpoints');
}));

// Zero-width characters, LRM/RLM marks, word joiners and BOMs that phones
// insert when copying.
const INVISIBLE_CHARS = /[​-‏⁠﻿]/g;
// Bullets, quotes, table pipes and separators in front of an item.
const LEAD_JUNK = /^[\s,;|•·*"'«»“”„\-–—]+/;
const NUMBER_MARK = /^\d+\s*[.)]\s*/;
// "code, Name" — also with a tab (spreadsheets), semicolon, pipe, colon or =.
const CODE_LINE = /^([0-9a-fA-F]{6,16})(?:\s*[,\t;|:=]\s*(.*))?$/;
// A tag link at the start of an item stands for its code, with or without
// scheme/host and with any trailing path or query.
const LEADING_URL = /^(?:https?:\/\/)?(?:[^\s\/,;|]+)?\/t\/([0-9a-fA-F]{6,16})(?:[\/?#][^\s,;|]*)?/;
const URL_NAME_SEP = /^\s*(?:[,\t;|]|\s[-–—:]\s)\s*/;
// A standalone 6-16 character hex token containing a digit, anywhere.
const CODE_TOKEN = /(^|[^0-9a-z])(?=[0-9a-f]*\d)[0-9a-f]{6,16}(?=[^0-9a-z]|$)/i;

function truncate(text, max) {
  return Array.from(String(text)).slice(0, max).join('');
}

function trimSeparators(text) {
  return String(text).replace(/^[\s,;|]+|[\s,;|]+$/g, '');
}

function normalizeName(name) {
  return trimSeparators(String(name || '')).replace(/\s+/g, ' ').toLowerCase();
}

function quote(text) {
  const t = String(text).trim();
  return `"${Array.from(t).length > 30 ? `${truncate(t, 30)}…` : t}"`;
}

// A code with a typo (one or two non-hex characters) or with spaces inside.
function looksLikeMistypedCode(field) {
  const compact = field.replace(/\s+/g, '');
  if (!/^[0-9a-z]{6,16}$/i.test(compact) || !/\d/.test(compact)) return false;
  const nonHex = compact.replace(/[0-9a-f]/gi, '').length;
  return nonHex <= 2 && (nonHex > 0 || compact !== field.trim());
}

// Splits a paste into items: { code?, name, location, placeholder }.
// Pastes that contain tag links (logs, browser history, URL lists) never
// turn their free-text lines into checkpoints — only codes are taken.
function parseBulk(rawInput) {
  const raw = String(rawInput || '').replace(INVISIBLE_CHARS, '');
  const linkMode = /\/t\/[0-9a-fA-F]{6,16}\b/.test(raw);
  const items = [];
  const seenCodes = new Set();
  const problems = [];
  let ignored = 0;

  const addCode = (code, name, location) => {
    code = code.toLowerCase();
    if (seenCodes.has(code)) return; // first occurrence wins
    seenCodes.add(code);
    const cleanName = truncate(trimSeparators(name || ''), 120);
    items.push({
      code,
      name: cleanName || `Tag ${code}`,
      location: truncate(trimSeparators(location || ''), 200),
      placeholder: !cleanName,
    });
  };
  const reject = (piece) => {
    if (linkMode) ignored++;
    else problems.push(quote(piece));
  };
  const fieldsAfter = (text) => {
    const fields = text.split(/\s*[,\t;|]\s*/).map(trimSeparators);
    const at = fields.findIndex(Boolean); // first non-empty field is the name
    return at < 0 ? ['', ''] : [fields[at], fields.slice(at + 1).filter(Boolean).join(', ')];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(LEAD_JUNK, '').trim();
    if (!line) continue;
    // Header row of a copied table ("Tag code<TAB>Name", "| Code | Name |").
    if (/^(tag\s*)?code\b/i.test(line) && /\bname\b/i.test(line)) {
      ignored++;
      continue;
    }

    // "1. A, 2. B, 3. C" on one line.
    const numberedList = NUMBER_MARK.test(line) && /[,;]\s*\d+\s*[.)]/.test(line);
    const pieces = numberedList ? line.split(/[,;]\s*(?=\d+\s*[.)])/) : [line];
    for (const rawPiece of pieces) {
      const piece = trimSeparators(rawPiece.replace(LEAD_JUNK, '').replace(NUMBER_MARK, ''));
      if (!piece) continue;

      const url = piece.match(LEADING_URL);
      if (url) {
        const rest = piece.slice(url[0].length);
        const sep = rest.match(URL_NAME_SEP);
        const [name, location] = sep ? fieldsAfter(rest.slice(sep[0].length)) : ['', ''];
        addCode(url[1], name, location);
        continue;
      }
      if (/\/t\//.test(piece)) continue; // log line; its codes are extracted below

      const codeLine = piece.match(CODE_LINE);
      if (codeLine) {
        const [name, location] = fieldsAfter(codeLine[2] || '');
        if (!name && (linkMode || !/\d/.test(codeLine[1]))) {
          // A bare hex word: noise in a log paste, a plain name otherwise.
          if (linkMode) ignored++;
          else items.push({ name: truncate(piece, 120), location: '', placeholder: false });
          continue;
        }
        addCode(codeLine[1], name, location);
        continue;
      }

      const firstField = (piece.match(/^([^,\t;|:=]+)[,\t;|:=]/) || [null, piece])[1];
      if (looksLikeMistypedCode(firstField) || CODE_TOKEN.test(piece)) {
        reject(piece);
        continue;
      }
      if (linkMode) {
        ignored++;
        continue;
      }
      items.push({ name: truncate(piece, 120), location: '', placeholder: false });
    }
  }

  for (const m of raw.matchAll(/\/t\/([0-9a-fA-F]{6,16})\b/g)) addCode(m[1]);
  return { items, problems, ignored };
}

// Normalized name -> checkpoints with that name, in list order.
async function nameIndex() {
  const index = new Map();
  for (const c of await listCheckpoints()) {
    const key = normalizeName(c.name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(c);
  }
  return index;
}

router.post('/admin/checkpoints/bulk', wrap(requireAdmin), wrap(async (req, res) => {
  const { items, problems, ignored } = parseBulk(req.body.bulk);

  let index = await nameIndex();
  // Names bound to a chip by an earlier line of this paste: a later line with
  // the same name is a different chip. Names created without a code can still
  // be bound once by a later "code, Name" line.
  const boundInPaste = new Set();
  const namedInPaste = new Set();
  const counts = { added: 0, linked: 0, renamed: 0, skipped: 0, duplicates: 0 };
  const displacedNames = new Set();
  const conflicts = [];

  for (const item of items) {
    const key = item.placeholder ? null : normalizeName(item.name);

    if (!item.code) {
      if (boundInPaste.has(key) || namedInPaste.has(key)) counts.duplicates++;
      else if (index.has(key)) counts.skipped++;
      else {
        await addCheckpoint(item.name, item.location);
        counts.added++;
        namedInPaste.add(key);
        index = await nameIndex();
      }
      continue;
    }

    const holder = await getCheckpoint(item.code);

    // The chip already belongs to a checkpoint of that name: nothing to bind.
    if (holder && key && normalizeName(holder.name) === key) {
      await markLinked(item.code);
      if (item.location && item.location !== holder.location) {
        await updateCheckpoint(item.code, { location: item.location });
      }
      counts.skipped++;
      boundInPaste.add(key);
      index = await nameIndex();
      continue;
    }

    const sameNames = key && !boundInPaste.has(key) ? (index.get(key) || []) : [];
    const unlinked = sameNames.filter((c) => !c.linked);
    let target = unlinked[0] || null;
    if (!target && sameNames.length === 1) target = sameNames[0]; // a swap/correction
    if (!target && sameNames.length > 1) {
      conflicts.push(`${quote(item.name)} matches ${sameNames.length} linked checkpoints — line for ${item.code} not applied`);
      continue;
    }

    if (target) {
      await linkTag(item.code, target.id);
      if (item.location) await updateCheckpoint(item.code, { location: item.location });
      if (holder && !holder.placeholder) displacedNames.add(normalizeName(holder.name));
      counts.linked++;
      boundInPaste.add(key);
      index = await nameIndex();
      continue;
    }

    if (!holder) {
      await addCheckpoint(item.name, item.location, item.code, { placeholder: item.placeholder });
      if (!item.placeholder) await markLinked(item.code);
      counts.added++;
    } else if (!item.placeholder && holder.placeholder) {
      await updateCheckpoint(item.code, {
        name: item.name,
        location: item.location || holder.location,
        placeholder: false,
      });
      await markLinked(item.code);
      counts.renamed++;
    } else if (item.placeholder) {
      counts.skipped++;
      continue;
    } else {
      conflicts.push(`${item.code} is already ${quote(holder.name)} — not changed`);
      continue;
    }
    if (key) boundInPaste.add(key);
    index = await nameIndex();
  }

  // Only report displaced checkpoints that no later line re-linked.
  const stillUnlinked = (await listCheckpoints())
    .filter((c) => !c.linked && !c.placeholder && displacedNames.has(normalizeName(c.name)))
    .map((c) => c.name);

  const parts = [`Created ${counts.added}`];
  if (counts.linked) parts.push(`linked ${counts.linked} chip(s) to existing checkpoints`);
  if (counts.renamed) parts.push(`named ${counts.renamed} placeholder(s)`);
  if (counts.skipped) parts.push(`skipped ${counts.skipped} already up to date`);
  if (counts.duplicates) parts.push(`ignored ${counts.duplicates} repeated in this paste`);
  if (ignored) parts.push(`ignored ${ignored} line(s) without a tag code`);
  let summary = parts.join(', ') + '.';
  if (stillUnlinked.length) {
    summary += ` Now without a chip: ${stillUnlinked.slice(0, 5).join(', ')}${stillUnlinked.length > 5 ? '…' : ''}.`;
  }
  if (conflicts.length) {
    summary += ` ${conflicts.slice(0, 3).join('; ')}${conflicts.length > 3 ? ` (and ${conflicts.length - 3} more)` : ''}.`;
  }
  if (problems.length) {
    summary += ` Not understood: ${problems.slice(0, 3).join(', ')}${problems.length > 3 ? ` and ${problems.length - 3} more` : ''} — write "code, Name"; tag codes are 6-16 characters of 0-9 and a-f.`;
  }
  const changed = counts.added + counts.linked + counts.renamed;
  const failed = problems.length || conflicts.length;
  res.redirect(await flashUrl('/admin/checkpoints', changed || !failed ? 'msg' : 'err', summary));
}));

router.post('/admin/checkpoints/:id/update', wrap(requireAdmin), wrap(async (req, res) => {
  await updateCheckpoint(req.params.id, {
    name: truncate((req.body.name || '').trim(), 120) || undefined,
    location: truncate((req.body.location || '').trim(), 200),
  });
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
    checkpoints.map(async (c, i) => {
      const url = `${base}/t/${c.id}`;
      const qr = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      return `<div class="card tag-card">
        <div class="tag-head"><span class="cp-num">${i + 1}</span><h2>${place(c.name, c.location)}</h2></div>
        ${c.is_linked ? '' : '<p class="warn no-print" style="font-size:.84rem">Not linked yet. If you link an already-written chip to this checkpoint (tap it as admin), this code changes. Write or print it only for a brand-new chip.</p>'}
        <img src="${qr}" alt="QR for ${esc(c.name)}" width="176" height="176">
        <code>${esc(url)}</code>
      </div>`;
    })
  );
  res.send(
    await adminPage(
      'Tag sheet — School Tag',
      `<div class="page-head no-print">
         <div><h1>Tag sheet</h1><div class="sub">${checkpoints.length} active checkpoints · one URL and QR code per chip</div></div>
         <button class="btn" onclick="window.print()">${icon('tag')}Print</button>
       </div>
       <div class="card no-print">
         <p style="margin:0">Write each URL below to its NFC tag as an <b>NDEF URL record</b> (use a free app like
            <b>NFC Tools</b> on Android or iPhone: Write → Add a record → URL → paste → Write, then
            optionally lock the tag so it can't be rewritten). The QR code is a fallback — print this
            page and stick the QR next to the tag for phones without NFC.</p>
       </div>
       <div class="tag-grid">${cards.join('')}</div>
       ${checkpoints.length === 0 ? '<p class="muted">No active checkpoints. Add them on the Checkpoints page first.</p>' : ''}`,
      { active: '/admin/tags' }
    )
  );
}));

// --- devices (two-phone access limit) ---------------------------------------

async function devicesPage(req, enrollUrl) {
  const devices = await listDevices();
  const enforcing = (await getSetting('require_enrolled_device')) === '1';
  const max = await getSetting('max_devices');

  const enrollCard = enrollUrl
    ? `<div class="card tag-card">
         <h2>Enrollment link — valid 30 min, one use</h2>
         <img src="${await QRCode.toDataURL(enrollUrl, { width: 220, margin: 1 })}" alt="Enrollment QR code" width="176" height="176">
         <code>${esc(enrollUrl)}</code>
         <p class="muted" style="margin:0">Scan this QR (or open the link) on the phone you want to allow, then press Enroll there.</p>
       </div>`
    : '';

  return await adminPage(
    'Devices — School Tag',
    `<div class="page-head">
       <div><h1>Allowed devices</h1>
         <div class="sub">${devices.length} of ${esc(max)} enrolled · enforcement ${enforcing ? `<span class="pill ok">${icon('check')}On</span>` : `<span class="pill warn">${icon('alert')}Off</span>`}</div></div>
       <form method="post" action="/admin/devices/enroll-code" class="no-print"><button class="btn small" type="submit">${icon('plus')}Generate enrollment link</button></form>
     </div>
     ${enrollCard}
     <div class="grid split start">
       <div class="card">
         <h2>Phones <span class="pill">${devices.length}</span></h2>
         ${
           devices.length
             ? `<ul class="plain">${devices
                 .map(
                   (d) => `<li>
                     <span class="tile blue sm">${icon('phone')}</span>
                     <div style="flex:1;min-width:0">
                       <div style="font-weight:650">${ka(d.name || d.id)}</div>
                       <div class="muted" style="font-size:.82rem">Enrolled ${fmtTime(d.enrolled_at)} · last seen ${d.last_seen ? fmtTime(d.last_seen) : 'never'}</div>
                     </div>
                     <form method="post" action="/admin/devices/${esc(d.id)}/delete" data-confirm="${esc(`Remove device ${d.name || d.id}? It will lose access immediately.`)}" onsubmit="return confirm(this.dataset.confirm)"><button class="btn small ghost" type="submit" style="color:var(--bad)" aria-label="Remove ${esc(d.name || d.id)}">Remove</button></form>
                   </li>`
                 )
                 .join('')}</ul>`
             : '<p class="muted">No devices enrolled yet. Generate an enrollment link and open it on the guard phone.</p>'
         }
       </div>
       <form method="post" action="/admin/devices/settings" class="card">
         <h2>Enforcement</h2>
         <label style="display:flex;gap:10px;align-items:flex-start;font-weight:600;color:var(--text)"><input type="checkbox" name="require_enrolled_device" value="1" ${enforcing ? 'checked' : ''} style="margin-top:3px"> Only enrolled devices can scan tags and run walkthroughs</label>
         ${enforcing && devices.length === 0 ? `<p><span class="pill bad wrap">${icon('alert')}Enforcement is on but no devices are enrolled — no phone can scan right now.</span></p>` : ''}
         <label for="max_devices" style="margin-top:14px">Maximum devices</label>
         <input id="max_devices" name="max_devices" type="number" min="1" max="20" value="${esc(max)}" class="input-sm">
         <button class="btn" type="submit">Save</button>
       </form>
     </div>`,
    { active: '/admin/devices' }
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
  const count = (st) => walks.filter((w) => w.status === st).length;
  res.send(
    await adminPage(
      'History — School Tag',
      `<div class="page-head">
         <div><h1>Walkthrough history</h1>
           <div class="sub">Last ${walks.length} rounds · ${count('completed')} completed · ${count('incomplete')} incomplete</div></div>
       </div>
       <div class="card">
         ${walks.length ? roundsTable(walks) : '<p class="muted">No walkthroughs yet.</p>'}
       </div>`,
      { active: '/admin/history' }
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
  // Rounds from before the checkpoint list was replaced are shown with the
  // names of that time, and their missed list comes from the alert actually
  // sent — today's checkpoints did not exist then.
  const reset = await resetInfo();
  const preReset = Boolean(reset.at) && w.started_at < reset.at;
  const scanName = (s) => (preReset && reset.names.get(s.checkpoint_id)) || s.checkpoint_name || s.checkpoint_id;
  const preResetAlerts = preReset ? await alertsForWalkthrough(w.id) : [];
  const took = w.completed_at ? fmtDuration(Date.parse(w.completed_at) - Date.parse(w.started_at)) : '';
  const listRow = (name, right, cls) => `<li><span class="cp-name">${name}</span><span class="cp-state ${cls}">${right}</span></li>`;

  let otherCard = '';
  if (w.status === 'cancelled') {
    otherCard = '<div class="card"><p class="muted">This round was cancelled (for example when the checkpoint list was replaced), so no missed checkpoints are listed.</p></div>';
  } else if (preReset) {
    otherCard = w.status === 'completed'
      ? ''
      : `<div class="card">
           <h2 class="bad">Missed</h2>
           <p class="muted">This round ran before the checkpoint list was replaced; this is the alert that was sent at the time.</p>
           ${preResetAlerts.length
             ? preResetAlerts.map((a) => `<div style="white-space:pre-line">${ka(a.message)}</div>`).join('')
             : '<p class="muted">No alert was recorded for this round.</p>'}
         </div>`;
  } else if (w.status === 'in_progress' && missing.length) {
    otherCard = `<div class="card">
        <h2>Still to scan <span class="pill info">${missing.length}</span></h2>
        <ul class="plain cp-list">${missing.map((c) => listRow(place(c.name, c.location), icon('pin'), '')).join('')}</ul>
      </div>`;
  } else if (w.status !== 'completed' && missed.length) {
    otherCard = `<div class="card">
        <h2 class="bad">Missed (${missed.length})</h2>
        <ul class="plain cp-list">${missed.map((c) => listRow(place(c.name, c.location), `${icon('x')}missed`, 'bad')).join('')}</ul>
      </div>`;
  }

  res.send(
    await adminPage(
      'Walkthrough — School Tag',
      `<div class="page-head">
         <div><h1>Walkthrough ${fmtTime(w.started_at)}</h1>
           <div class="sub" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">Guard: ${ka(w.guard_name || '—')} · ${STATUS_PILL[w.status] || esc(w.status)} · Finished: ${fmtTime(w.completed_at)}${took ? ` · ${took}` : ''}</div></div>
         <a class="btn secondary small no-print" href="/admin/history">All rounds</a>
       </div>
       <div class="grid halves start">
         <div class="card">
           <h2>Scanned (${scans.length})</h2>
           ${
             scans.length
               ? `<ul class="plain cp-list">${scans.map((s) => listRow(ka(scanName(s)), `${icon('check')}${fmtClock(s.scanned_at)}`, 'done')).join('')}</ul>`
               : '<p class="muted">Nothing scanned.</p>'
           }
         </div>
         ${otherCard}
       </div>`,
      { active: '/admin/history' }
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
  const notifyEmail = (await getSetting('notify_email')) || '';
  const mailchimpApiKey = (await getSetting('mailchimp_api_key')) || '';
  const mailchimpFromEmail = (await getSetting('mailchimp_from_email')) || '';
  const smtpHost = (await getSetting('smtp_host')) || '';
  const smtpPort = (await getSetting('smtp_port')) || '';
  const smtpUser = (await getSetting('smtp_user')) || '';
  const smtpPass = (await getSetting('smtp_pass')) || '';
  const smtpFrom = (await getSetting('smtp_from')) || '';
  const brevoApiKey = (await getSetting('brevo_api_key')) || '';
  const brevoFromEmail = (await getSetting('brevo_from_email')) || '';
  const emailTest = await readFlash(req, 'email_test');
  const settingsErr = await readFlash(req, 'settings_err');
  const lastEmail = await lastEmailResult();
  const log = await emailLog();
  const logView = log.length
    ? `<details class="no-print"${log[0].ok ? '' : ' open'} style="margin:0 0 14px">
         <summary style="cursor:pointer;font-weight:650">Email log — last ${log.length} attempt${log.length === 1 ? '' : 's'}</summary>
         <ul class="plain" style="margin-top:6px">${log
           .map(
             (e) => `<li style="display:block">
               <div style="font-size:.85rem"><b>${fmtTime(e.at)}</b> · “${esc(e.subject)}”${e.channel ? ` · via ${esc(e.channel)}` : ''}</div>
               ${(e.recipients || [])
                 .map(
                   (r) => `<div style="font-size:.85rem;margin-top:4px">${r.ok ? `<span class="ok">✓ ${esc(r.to)}</span>` : `<span class="bad">✕ ${esc(r.to)}</span> — ${esc(r.error)}`}</div>
                     ${r.steps && r.steps.length ? `<pre style="white-space:pre-wrap;word-break:break-word;font-size:.76rem;line-height:1.5;margin:6px 0 0;padding:8px 10px;border-radius:10px;background:var(--track)">${esc(r.steps.join('\n'))}</pre>` : ''}`
                 )
                 .join('') || (e.error ? `<div class="bad" style="font-size:.85rem;margin-top:4px">✕ ${esc(e.error)}</div>` : '')}
             </li>`
           )
           .join('')}</ul>
       </details>`
    : '';
  // Mail claiming a free-mail From address but sent by another service is
  // often rejected or filed as spam by Gmail and others (DMARC).
  const freeMailFrom = [brevoFromEmail, mailchimpFromEmail].find((a) =>
    /@(gmail\.com|googlemail\.com|yahoo\.[a-z.]+|ymail\.com|outlook\.com|hotmail\.[a-z.]+|live\.com|icloud\.com|me\.com|aol\.com|mail\.(com|ru))$/i.test(a.trim())
  );
  res.send(
    await adminPage(
      'Settings — School Tag',
      `<h1>Settings</h1>
       <form method="post" action="/admin/settings">
         <div class="card">
           <h2>Walkthrough</h2>
           <label for="walk_duration_minutes">Time limit for one walkthrough (minutes). If the guard has not scanned every tag within this time, an alert is sent. <b>Set 0 for no time limit</b> — the walkthrough then stays open until the guard presses Finish.</label>
           <input id="walk_duration_minutes" name="walk_duration_minutes" type="number" min="0" max="720" value="${esc(walkDurationMinutes)}">
         </div>
         <div class="card">
           <h2>Alert delivery</h2>
           <label for="ntfy_topic">ntfy topic — install the free <b>ntfy</b> app on the phones that should receive alerts and subscribe them to this topic (pick something hard to guess, e.g. <code>myschool-security-x7k2</code>)</label>
           <input id="ntfy_topic" name="ntfy_topic" value="${esc(ntfyTopic)}" placeholder="myschool-security-x7k2">
           <label for="webhook_url">Webhook URL (optional) — alerts are also POSTed here as JSON</label>
           <input id="webhook_url" name="webhook_url" value="${esc(webhookUrl)}" placeholder="https://...">
         </div>
         <div class="card" id="email-settings">
           <h2>Email notifications</h2>
           <p class="muted">A summary email is sent when a walkthrough is <b>completed</b>, and an alert email when checkpoints are <b>missed</b>. Fill in one way of sending below: Mailchimp Transactional, Brevo or SMTP.</p>
           ${emailTest ? (emailTest === 'ok' || emailTest.startsWith('ok:') ? `<p class="ok">✓ Test email sent${emailTest.length > 3 ? ` to ${esc(emailTest.slice(3))}` : ''} — check the inbox (and the spam folder).</p>` : `<p class="bad">✕ Test failed: ${esc(emailTest)}</p>`) : ''}
           ${settingsErr ? `<p class="bad">✕ ${esc(settingsErr)}</p>` : ''}
           ${lastEmail ? `<p class="muted" style="font-size:.85rem">Last notification email: ${fmtTime(lastEmail.at)} · “${esc(lastEmail.subject)}” — ${lastEmail.ok ? `<span class="ok">✓ accepted for ${esc(lastEmail.sent.join(', '))}</span>` : `<span class="bad">✕ ${esc(lastEmail.error)}</span>`}<br>“Accepted” means the email service took it. If it still doesn't arrive, check the Spam folder and the service's sending logs (Brevo: Transactional → Logs).</p>` : ''}
           ${logView}
           ${freeMailFrom ? `<p class="warn" style="font-size:.85rem">⚠ The From address ${esc(freeMailFrom.trim())} is a free-mail address. Gmail and others often reject or spam mail that claims such an address but is sent by Brevo or Mailchimp. Verify your own domain with the email service and use an address on it (e.g. security@your-school.ge).</p>` : ''}
           <label for="notify_email">Send notifications to these emails — separate several with commas</label>
           <input id="notify_email" name="notify_email" type="text" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(notifyEmail)}" placeholder="director@myschool.ge, deputy@myschool.ge">
           <label for="mailchimp_api_key">Mailchimp Transactional API key</label>
           <input id="mailchimp_api_key" name="mailchimp_api_key" type="password" value="${esc(mailchimpApiKey)}" placeholder="md-...">
           <label for="mailchimp_from_email">From address (must be on a domain verified in Mailchimp Transactional)</label>
           <input id="mailchimp_from_email" name="mailchimp_from_email" type="email" value="${esc(mailchimpFromEmail)}" placeholder="security@myschool.ge">
           <h2 style="margin-top:16px">…or Brevo — recommended on Railway (free, 300 emails/day)</h2>
           <p class="muted">Railway blocks SMTP ports, so Gmail SMTP times out there — Brevo sends over HTTPS instead. Create a free account at <b>brevo.com</b>, then: profile menu → <b>SMTP &amp; API → API Keys → Generate a new API key</b>. The From address below must be a verified sender in Brevo (your signup email works out of the box; others can be added under Senders).</p>
           <label for="brevo_api_key">Brevo API key</label>
           <input id="brevo_api_key" name="brevo_api_key" type="password" value="${esc(brevoApiKey)}" placeholder="xkeysib-...">
           <label for="brevo_from_email">From address (a verified sender in Brevo)</label>
           <input id="brevo_from_email" name="brevo_from_email" type="email" value="${esc(brevoFromEmail)}">
           <h2 style="margin-top:16px">…or plain SMTP (e.g. Gmail — does not work on Railway)</h2>
           <p class="muted">Leave the Mailchimp key empty and fill these instead. For Gmail: enable 2-step verification, create an <b>App password</b> (Google Account → Security → App passwords), and use it here — not your normal password.</p>
           <div class="row">
             <div><label for="smtp_host">SMTP host</label><input id="smtp_host" name="smtp_host" value="${esc(smtpHost)}" placeholder="smtp.gmail.com"></div>
             <div><label for="smtp_port">Port</label><input id="smtp_port" name="smtp_port" type="number" value="${esc(smtpPort)}" placeholder="465"></div>
           </div>
           <label for="smtp_user">SMTP user (your email address)</label>
           <input id="smtp_user" name="smtp_user" type="email" value="${esc(smtpUser)}" placeholder="school.security@gmail.com">
           <label for="smtp_pass">SMTP password / app password</label>
           <input id="smtp_pass" name="smtp_pass" type="password" value="${esc(smtpPass)}">
           <label for="smtp_from">From address (optional, defaults to the SMTP user)</label>
           <input id="smtp_from" name="smtp_from" type="email" value="${esc(smtpFrom)}">
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
         <div class="row">
           <button class="btn" type="submit">Save</button>
           <button class="btn secondary" type="submit" formaction="/admin/settings/test-email">Save &amp; send test email</button>
         </div>
       </form>`,
      { active: '/admin/settings' }
    )
  );
}));

const SETTINGS_KEYS = [
  'walk_duration_minutes', 'ntfy_topic', 'webhook_url', 'base_url', 'admin_pin',
  'android_package', 'android_sha256', 'notify_email', 'mailchimp_api_key',
  'mailchimp_from_email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'brevo_api_key', 'brevo_from_email',
];

// Saves every submitted setting except an email list with a bad address,
// which is kept as it was; returns why, or '' when everything was saved.
async function saveSettings(req) {
  let error = '';
  for (const key of SETTINGS_KEYS) {
    if (req.body[key] === undefined) continue;
    let value = String(req.body[key]).trim();
    if (key === 'notify_email') {
      const { valid, invalid } = parseRecipients(value);
      if (invalid.length) {
        error = `Email list not saved — not a valid email address: ${invalid.join(', ')}`;
        continue;
      }
      value = valid.join(', ');
    }
    await setSetting(key, value);
  }
  return error;
}

// Saves the submitted form first, then sends the test — so what you see in
// the fields is exactly what gets tested.
router.post('/admin/settings/test-email', wrap(requireAdmin), wrap(async (req, res) => {
  const saveError = await saveSettings(req);
  if (saveError) return res.redirect((await flashUrl('/admin/settings', 'email_test', saveError)) + '#email-settings');
  console.log('[email] test email requested from admin settings');
  const email = testEmail();
  const result = await sendEmail(email.subject, email.text, email.html);
  console.log('[email] test result:', result);
  const flash = await flashUrl('/admin/settings', 'email_test', result.ok ? `ok:${result.sent.join(', ')}` : result.error || 'failed');
  res.redirect(flash + '#email-settings');
}));

router.post('/admin/settings', wrap(requireAdmin), wrap(async (req, res) => {
  const saveError = await saveSettings(req);
  res.redirect(saveError ? (await flashUrl('/admin/settings', 'settings_err', saveError)) + '#email-settings' : '/admin/settings');
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
