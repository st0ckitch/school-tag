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
  markLinked,
  linkTag,
  alertsForWalkthrough,
} = require('../db');
const { tick } = require('../scheduler');
const { sendEmail, parseRecipients } = require('../notify');
const { resetInfo } = require('../school-checkpoints');
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
  cancelled: '<span class="pill warn">Cancelled</span>',
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
    const timeInfo = active.deadline
      ? `${Math.max(0, Math.round((new Date(active.deadline).getTime() - Date.now()) / 60000))} min left`
      : 'no time limit';
    liveCard = `
      <div class="card">
        <h2>Live walkthrough ${STATUS_PILL.in_progress}</h2>
        <div class="sub">Guard: ${esc(active.guard_name || '—')} · Started ${fmtTime(active.started_at)} · ${timeInfo}</div>
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
  const flashMsg = await readFlash(req, 'msg');
  const flashErr = await readFlash(req, 'err');
  const activeReal = checkpoints.filter((c) => c.active && !c.placeholder);
  const unlinkedCount = activeReal.filter((c) => !c.is_linked).length;
  res.send(
    adminPage(
      'Checkpoints — School Tag',
      `${nav('/admin/checkpoints')}
       <h1>Checkpoints</h1>
       <div class="sub">${activeReal.length - unlinkedCount} of ${activeReal.length} linked to a chip${
         unlinkedCount
           ? ` · <b>${unlinkedCount} not linked yet</b>: log in here on your phone, then tap each chip — the phone asks which checkpoint it is.`
           : ''
       }</div>
       <div class="card">
         <h2>Add checkpoint</h2>
         ${flashMsg ? `<p class="ok">✓ ${esc(flashMsg)}</p>` : ''}
         ${flashErr ? `<p class="bad">✕ ${esc(flashErr)}</p>` : ''}
         <form method="post" action="/admin/checkpoints">
           <div class="row">
             <div><label for="name">Name</label><input id="name" name="name" required placeholder="e.g. Main entrance"></div>
             <div><label for="location">Location (optional)</label><input id="location" name="location" placeholder="e.g. Ground floor, west wing"></div>
           </div>
           <label for="tag_code">Tag code (optional — ONLY when restoring an already-written chip; the 8-character code from its URL, e.g. <code>63f91d85</code>)</label>
           <input id="tag_code" name="tag_code" pattern="[0-9a-fA-F]{6,16}" placeholder="leave empty for a new tag">
           <button class="btn" type="submit">Add</button>
         </form>
       </div>
       <div class="card">
         <h2>Bulk restore</h2>
         <p class="muted">One item per line (numbered lists like <code>1. Name, 2. Name</code> work too):</p>
         <ul class="muted" style="font-size:.9rem;margin-top:0">
           <li><code>Name</code> — creates a checkpoint; tap its chip later with an admin-logged-in phone to link it.</li>
           <li><code>tagcode, Name, Location</code> — binds that chip to the checkpoint with that name (or creates it).</li>
           <li>Anything containing tag links (Railway logs, browser history, URL lists) — every <code>/t/code</code> found is added as "Tag code". In such a paste only lines with codes are used; other text is ignored.</li>
         </ul>
         <form method="post" action="/admin/checkpoints/bulk">
           <textarea name="bulk" rows="10" style="width:100%;padding:12px 14px;border:1px solid var(--input-border);border-radius:12px;background:var(--input-bg);color:var(--text);font-family:inherit;font-size:0.95rem" placeholder="63f91d85, Main entrance, Ground floor&#10;ece2c3ac, Gym&#10;dfbedd8d, Library, 1st floor"></textarea>
           <button class="btn" type="submit" style="margin-top:10px">Restore all</button>
         </form>
       </div>
       <div class="card">
         <table>
           <tr><th>Name</th><th>Location</th><th>Tag URL</th><th>Status</th><th></th></tr>
           ${checkpoints
             .map(
               (c) => `<tr>
                 <td colspan="2">
                   <form method="post" action="/admin/checkpoints/${esc(c.id)}/update" class="row" style="align-items:center">
                     <input name="name" value="${esc(c.name)}" style="margin-bottom:0">
                     <input name="location" value="${esc(c.location)}" placeholder="Location" style="margin-bottom:0">
                     <button class="btn small secondary" type="submit" style="flex:none">Save</button>
                   </form>
                 </td>
                 <td><code>/t/${esc(c.id)}</code></td>
                 <td>${c.active ? '<span class="pill ok">active</span>' : '<span class="pill warn">disabled</span>'}
                   ${c.is_linked ? '<span class="pill ok" title="A chip is bound to this checkpoint">🔗 linked</span>' : '<span class="pill warn" title="No chip bound yet — tap the chip with an admin-logged-in phone">not linked</span>'}</td>
                 <td style="white-space:nowrap">
                   <form method="post" action="/admin/checkpoints/${esc(c.id)}/toggle" style="display:inline"><button class="btn small secondary" type="submit">${c.active ? 'Disable' : 'Enable'}</button></form>
                   <form method="post" action="/admin/checkpoints/${esc(c.id)}/delete" style="display:inline" data-confirm="${esc(`Delete checkpoint ${c.name}? Its scan history stays, but the tag stops working.`)}" onsubmit="return confirm(this.dataset.confirm)"><button class="btn small danger" type="submit">Delete</button></form>
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
    checkpoints.map(async (c) => {
      const url = `${base}/t/${c.id}`;
      const qr = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      return `<div class="card" style="text-align:center">
        <h2 style="margin-bottom:2px">${esc(c.name)}</h2>
        <div class="muted">${esc(c.location || '')}</div>
        ${c.is_linked ? '' : '<p class="warn no-print" style="font-size:.85rem">Not linked yet. If you link an already-written chip to this checkpoint (tap it as admin), this code changes. Write or print it only for a brand-new chip.</p>'}
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
               <td><form method="post" action="/admin/devices/${esc(d.id)}/delete" data-confirm="${esc(`Remove device ${d.name || d.id}? It will lose access immediately.`)}" onsubmit="return confirm(this.dataset.confirm)"><button class="btn small danger" type="submit">Remove</button></form></td>
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
  // Rounds from before the checkpoint list was replaced are shown with the
  // names of that time, and their missed list comes from the alert actually
  // sent — today's checkpoints did not exist then.
  const reset = await resetInfo();
  const preReset = Boolean(reset.at) && w.started_at < reset.at;
  const scanName = (s) => (preReset && reset.names.get(s.checkpoint_id)) || s.checkpoint_name || s.checkpoint_id;
  const preResetAlerts = preReset ? await alertsForWalkthrough(w.id) : [];
  res.send(
    adminPage(
      'Walkthrough — School Tag',
      `${nav('/admin/history')}
       <h1>Walkthrough ${fmtTime(w.started_at)}</h1>
       <div class="sub">Guard: ${esc(w.guard_name || '—')} · ${STATUS_PILL[w.status] || esc(w.status)} · Finished: ${fmtTime(w.completed_at)}</div>
       <div class="card">
         <h2>Scanned (${scans.length})</h2>
         <ul class="plain">
           ${scans.map((s) => `<li><span>${esc(scanName(s))}</span><span class="muted">${fmtTime(s.scanned_at)}</span></li>`).join('')}
         </ul>
         ${scans.length === 0 ? '<p class="muted">Nothing scanned.</p>' : ''}
       </div>
       ${
         w.status === 'cancelled'
           ? '<div class="card"><p class="muted">This round was cancelled (for example when the checkpoint list was replaced), so no missed checkpoints are listed.</p></div>'
           : preReset
           ? w.status === 'completed'
             ? ''
             : `<div class="card">
                  <h2 class="bad">Missed</h2>
                  <p class="muted">This round ran before the checkpoint list was replaced; this is the alert that was sent at the time.</p>
                  ${preResetAlerts.length
                    ? preResetAlerts.map((a) => `<div style="white-space:pre-line">${esc(a.message)}</div>`).join('')
                    : '<p class="muted">No alert was recorded for this round.</p>'}
                </div>`
           : w.status !== 'completed' && (missed.length || missing.length)
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
  res.send(
    adminPage(
      'Settings — School Tag',
      `${nav('/admin/settings')}
       <h1>Settings</h1>
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
         <div class="card">
           <h2>Email notifications (Mailchimp)</h2>
           <p class="muted">A summary email is sent when a walkthrough is <b>completed</b>, and an alert email when checkpoints are <b>missed</b>. Requires a <b>Mailchimp Transactional</b> (Mandrill) API key — regular Mailchimp campaign keys cannot send single emails.</p>
           ${emailTest ? (emailTest.startsWith('ok:') ? `<p class="ok">✓ Test email sent to ${esc(emailTest.slice(3))} — check the inbox (and the spam folder).</p>` : `<p class="bad">✕ Test failed: ${esc(emailTest)}</p>`) : ''}
           ${settingsErr ? `<p class="bad">✕ ${esc(settingsErr)}</p>` : ''}
           <label for="notify_email">Send notifications to these emails — separate several with commas</label>
           <input id="notify_email" name="notify_email" type="email" multiple value="${esc(notifyEmail)}" placeholder="director@myschool.ge, deputy@myschool.ge">
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
       </form>`
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
  if (saveError) return res.redirect(await flashUrl('/admin/settings', 'email_test', saveError));
  console.log('[email] test email requested from admin settings');
  const result = await sendEmail(
    'School Tag: test email',
    'This is a test email from your School Tag admin settings. If you can read this, email notifications are working.'
  );
  console.log('[email] test result:', result);
  res.redirect(
    await flashUrl('/admin/settings', 'email_test', result.ok ? `ok:${result.sent.join(', ')}` : result.error || 'failed')
  );
}));

router.post('/admin/settings', wrap(requireAdmin), wrap(async (req, res) => {
  const saveError = await saveSettings(req);
  res.redirect(saveError ? await flashUrl('/admin/settings', 'settings_err', saveError) : '/admin/settings');
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
