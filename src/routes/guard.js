'use strict';

// Guard-facing pages. These are what opens on the guard's phone when they tap
// an NFC tag (or scan the fallback QR code). Text is Georgian first, English
// below, since the guards are the main users.

const express = require('express');
const {
  getCheckpoint,
  getActiveWalkthrough,
  startWalkthrough,
  recordScan,
  getScans,
  getMissingCheckpoints,
  getSetting,
  countDevices,
  consumeEnrollmentCode,
  addDevice,
  isTagCode,
  markLinked,
  linkTag,
  listLinkCandidates,
} = require('../db');
const { tick, closeIncomplete, completeWalkthrough } = require('../scheduler');
const { requireDevice, deviceCookieHeader } = require('../device');
const { hasSession } = require('./admin');
const { previousNameForCode } = require('../school-checkpoints');
const { passwordSet, checkPassword, unlockCookieHeader, unlocked } = require('../guard-lock');
const { esc, page, icon, ring, place } = require('../html');

const router = express.Router();

// Express 4 does not catch async handler rejections — route them to next().
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function minutesLeft(walkthrough) {
  return Math.max(0, Math.round((new Date(walkthrough.deadline).getTime() - Date.now()) / 60000));
}

const TZ = process.env.TZ || 'Asia/Tbilisi';
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

// A big button labelled in Georgian with the English underneath.
const biButton = (ka, en, cls = '') => `<button class="btn full two ${cls}" type="submit"><span>${ka}</span><span class="en" lang="en">${en}</span></button>`;

// A Georgian heading with its English line.
const biTitle = (ka, en, tag = 'h1') => `<${tag}>${ka}</${tag}><div class="sub" lang="en">${en}</div>`;

const WRONG_PASSWORD = 'არასწორი პაროლი · Wrong password';

// The scan password field, shown only when Settings has a guard password.
function passwordField(error) {
  return `<label for="guard_password">პაროლი · Password</label>
    <input id="guard_password" name="password" type="password" autocomplete="current-password" required>
    ${error ? `<p><span class="pill bad">${icon('alert')}${esc(error)}</span></p>` : ''}`;
}

// The form that starts a round, from /walk or from a tapped chip.
function startForm(checkpointId, needPassword, error) {
  return `<form method="post" action="/walkthrough/start">
    ${checkpointId ? `<input type="hidden" name="checkpoint_id" value="${esc(checkpointId)}">` : ''}
    <label for="guard_name">თქვენი სახელი · Your name</label>
    <input id="guard_name" name="guard_name" placeholder="მაგ. გიორგი / e.g. Giorgi" autocomplete="name">
    ${needPassword ? passwordField(error) : ''}
    ${biButton('შემოვლის დაწყება', 'Start walkthrough', 'big')}
  </form>`;
}

function noRoundPage(needPassword, error) {
  return page(
    'No walkthrough',
    `<div class="card scan-hero">
       <span class="tile violet">${icon('route')}</span>
       ${biTitle('შემოვლა არ მიმდინარეობს', 'No walkthrough running')}
       <p class="muted" style="margin:0">დაიწყეთ პირველი ტეგის დასკანერებით ან ღილაკით. · Start by scanning the first tag, or with the button below.</p>
     </div>
     <div class="card">${startForm(null, needPassword, error)}</div>`,
    { lang: 'ka' }
  );
}

function startFromTagPage(checkpoint, needPassword, error, relink = '') {
  return page(
    'Start walkthrough',
    `<div class="card scan-hero">
       <span class="tile violet">${icon('pin')}</span>
       <h1>${place(checkpoint.name, checkpoint.location)}</h1>
       <div class="sub">შემოვლა არ არის დაწყებული. დაიწყეთ ახლა? · No walkthrough is running. Start one now?</div>
     </div>
     <div class="card">${startForm(checkpoint.id, needPassword, error)}</div>${relink}`,
    { lang: 'ka' }
  );
}

// A phone joining a round that is already running types the password once.
function unlockPage(action, checkpoint, error) {
  return page(
    'Password',
    `<div class="card scan-hero">
       <span class="tile violet">${icon('shield')}</span>
       ${biTitle('შეიყვანეთ პაროლი', 'Scanning is password-protected — enter it once for this round.')}
       ${checkpoint ? `<p style="margin:0"><b>${place(checkpoint.name, checkpoint.location)}</b></p>` : ''}
     </div>
     <div class="card">
       <form method="post" action="${esc(action)}">
         ${passwordField(error)}
         ${biButton('გაგრძელება', 'Continue', 'big')}
       </form>
     </div>`,
    { lang: 'ka' }
  );
}

async function progressView(walkthrough, justScanned) {
  const scans = await getScans(walkthrough.id);
  const missing = await getMissingCheckpoints(walkthrough.id);
  const total = scans.length + missing.length;
  const timeInfo = walkthrough.deadline
    ? `<span class="pill warn wrap">${icon('timer')}${minutesLeft(walkthrough)} წთ · min left</span>`
    : `<span class="pill wrap">${icon('timer')}დროის ლიმიტის გარეშე · No time limit</span>`;

  const scannedBanner = justScanned
    ? `<div class="card scan-hero">
         <span class="tile green">${icon('check')}</span>
         <div class="stat-label">დაფიქსირდა · Checkpoint recorded</div>
         <h1 style="margin-top:4px">${place(justScanned.name, justScanned.location)}</h1>
       </div>`
    : '';

  const remaining = missing.length
    ? `<div class="card">
         <h2>დარჩენილია · Remaining <span class="pill info">${missing.length}</span></h2>
         <ul class="plain cp-list">
           ${missing.map((c) => `<li><span class="cp-name">${place(c.name, c.location)}</span><span class="cp-state">${icon('pin')}</span></li>`).join('')}
         </ul>
       </div>`
    : `<div class="card scan-hero">
         <span class="tile green">${icon('checkCircle')}</span>
         ${biTitle('ყველა წერტილი შემოწმებულია!', 'All checkpoints scanned — finish the round.')}
         <form method="post" action="/walkthrough/finish" style="margin-top:8px">
           ${biButton('შემოვლის დასრულება', 'Finish walkthrough', 'big')}
         </form>
       </div>`;

  const done = scans.length
    ? `<details class="card">
         <summary style="cursor:pointer;font-weight:700">შემოწმებული · Scanned (${scans.length})</summary>
         <ul class="plain cp-list" style="margin-top:8px">
           ${scans
             .slice()
             .reverse()
             .map((s) => `<li><span class="cp-name">${place(s.checkpoint_name || s.checkpoint_id, s.checkpoint_location)}</span><span class="cp-state done">${icon('check')}${clock(s.scanned_at)}</span></li>`)
             .join('')}
         </ul>
       </details>`
    : '';

  const finishEarly = missing.length
    ? `<form method="post" action="/walkthrough/finish" class="no-print" style="margin-bottom:12px"
             onsubmit="return confirm('დარჩენილია ${missing.length} წერტილი. ნამდვილად დაასრულებთ? / ${missing.length} checkpoints remain. Really finish?')">
         ${biButton('ადრე დასრულება', 'Finish early', 'secondary')}
       </form>`
    : '';

  return `
    ${scannedBanner}
    <div class="card ring-card">
      ${ring(scans.length, total, 'შემოწმდა')}
      <div style="min-width:0">
        ${biTitle('შემოვლა მიმდინარეობს', 'Walkthrough in progress', 'h2')}
        ${walkthrough.guard_name ? `<p style="margin:0 0 8px;display:flex;gap:6px;align-items:center">${icon('guard')}<b>${esc(walkthrough.guard_name)}</b></p>` : ''}
        ${timeInfo}
      </div>
    </div>
    ${remaining}
    ${done}
    ${finishEarly}
    <button class="btn ghost full small no-print" data-label="Guard phone" data-done="ჩართულია / Enabled" data-denied="დაბლოკილია / Blocked" onclick="stEnablePush(this)">${icon('bell')}შეტყობინებების ჩართვა · Enable notifications</button>
  `;
}

// --- linking chips to checkpoints (admin only) -------------------------------

async function linkPage(code, holder, error) {
  const previous = await previousNameForCode(code);
  const all = await listLinkCandidates();
  const linkedCount = all.filter((c) => c.is_linked).length;
  const candidates = all.filter((c) => c.id !== code);
  const unlinked = candidates.filter((c) => !c.is_linked);
  const linked = candidates.filter((c) => c.is_linked);
  const option = (c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`;
  const select = candidates.length
    ? `<label for="checkpoint_id">რომელი წერტილია ეს ტეგი? · Which checkpoint is this chip?</label>
       <select id="checkpoint_id" name="checkpoint_id" required>
         <option value="">— აირჩიეთ / Choose —</option>
         ${unlinked.length ? `<optgroup label="ჯერ არ არის დაკავშირებული / Not linked yet (${unlinked.length})">${unlinked.map(option).join('')}</optgroup>` : ''}
         ${linked.length ? `<optgroup label="უკვე დაკავშირებული — ხელახლა / Already linked — re-link">${linked.map(option).join('')}</optgroup>` : ''}
       </select>
       ${biButton('დაკავშირება', 'Link')}`
    : '<p class="bad">წერტილები არ არის. დაამატეთ ადმინ პანელში. / No checkpoints exist yet — add them in the admin panel first.</p>';
  const pct = all.length ? Math.round((100 * linkedCount) / all.length) : 0;
  return page(
    'Link tag',
    `<div class="card">
       <div class="stat" style="margin-bottom:6px"><div>${biTitle('ტეგის დაკავშირება', 'Link this tag')}</div><span class="tile blue">${icon('nfc')}</span></div>
       <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="pill">კოდი · Code <code>${esc(code)}</code></span>${holder ? `<span class="pill warn">ახლა · now: ${esc(holder.name)}</span>` : ''}</p>
       ${previous ? `<p class="muted">ადრე ეს ტეგი იყო / Before the reset this chip was: <b>${esc(previous)}</b></p>` : ''}
       ${error ? `<p><span class="pill bad">${icon('alert')}${esc(error)}</span></p>` : ''}
       <form method="post" action="/t/${esc(code)}/link">${select}</form>
     </div>
     <div class="card">
       <div class="stat-label">დაკავშირებულია · Linked so far</div>
       <div class="stat-value">${linkedCount}<small> / ${all.length}</small></div>
       <div class="progressbar" style="margin-bottom:0"><div style="width:${pct}%"></div></div>
     </div>`,
    { lang: 'ka' }
  );
}

function messageCard(tile, ic, ka, en, body = '') {
  return `<div class="card scan-hero">
    <span class="tile ${tile}">${icon(ic)}</span>
    ${biTitle(ka, en)}
    ${body}
  </div>`;
}

function unknownTagPage(code) {
  return page(
    'Unknown tag',
    messageCard(
      'amber',
      'alert',
      'უცნობი ტეგი',
      'Unknown tag — this tag is not registered in the system.',
      `<p class="muted" style="font-size:.86rem">კოდი / Code: <code>${esc(code)}</code></p>
       <p class="muted" style="font-size:.86rem">ადმინისტრატორი: შედით <a href="/admin">/admin</a>-ში ამ ტელეფონიდან და ხელახლა შეეხეთ ტეგს, რომ დააკავშიროთ. /
         Administrator: log in at <a href="/admin">/admin</a> on this phone, then tap the tag again to link it.</p>`
    ),
    { lang: 'ka' }
  );
}

// The URL written on each NFC tag: /t/<checkpoint id>
router.get('/t/:id', wrap(requireDevice), wrap(async (req, res) => {
  await tick();

  const code = String(req.params.id).toLowerCase();
  const checkpoint = await getCheckpoint(code);
  const isAdmin = await hasSession(req);

  // An admin tapping a chip the system doesn't know (or only knows under a
  // placeholder name) gets to say which checkpoint it is.
  if (isAdmin && isTagCode(code) && (!checkpoint || checkpoint.placeholder)) {
    res.send(await linkPage(code, checkpoint));
    return;
  }

  if (checkpoint && !checkpoint.active && isAdmin) {
    res.status(404).send(
      page(
        'Disabled checkpoint',
        messageCard(
          'amber',
          'pin',
          esc(checkpoint.name),
          'ეს ტეგი დაკავშირებულია გამორთულ წერტილთან. / This chip is linked to a disabled checkpoint — enable it in Admin → Checkpoints.',
          `<a class="btn secondary full" href="/t/${esc(code)}/link">ტეგის ხელახლა დაკავშირება · Re-link this chip</a>`
        ),
        { lang: 'ka' }
      )
    );
    return;
  }

  if (!checkpoint || !checkpoint.active) {
    res.status(404).send(unknownTagPage(code));
    return;
  }

  // Opening a checkpoint's own URL proves a chip (or printed QR) carries it.
  if (!checkpoint.linked) await markLinked(checkpoint.id);

  const relink = isAdmin
    ? `<p class="no-print" style="text-align:center;margin-top:14px"><a href="/t/${esc(code)}/link">ადმინი: ტეგის ხელახლა დაკავშირება / Admin: re-link this tag</a></p>`
    : '';

  const active = await getActiveWalkthrough();
  if (active) {
    if (!(await unlocked(req, active.id))) {
      res.status(401).send(unlockPage(`/t/${encodeURIComponent(code)}/unlock`, checkpoint));
      return;
    }
    await recordScan(active.id, checkpoint.id);
    res.send(page(`✓ ${checkpoint.name}`, (await progressView(active, checkpoint)) + relink, { lang: 'ka' }));
    return;
  }

  // No walkthrough running — offer to start one from this tag.
  res.send(startFromTagPage(checkpoint, await passwordSet(), '', relink));
}));

router.post('/t/:id/unlock', wrap(requireDevice), wrap(async (req, res) => {
  const code = String(req.params.id).toLowerCase();
  const active = await getActiveWalkthrough();
  if (active) {
    if (!(await checkPassword(req.body.password))) {
      res.status(401).send(unlockPage(`/t/${encodeURIComponent(code)}/unlock`, await getCheckpoint(code), WRONG_PASSWORD));
      return;
    }
    res.setHeader('Set-Cookie', await unlockCookieHeader(active.id));
  }
  res.redirect(`/t/${encodeURIComponent(code)}`);
}));

router.post('/walk/unlock', wrap(requireDevice), wrap(async (req, res) => {
  const active = await getActiveWalkthrough();
  if (active) {
    if (!(await checkPassword(req.body.password))) {
      res.status(401).send(unlockPage('/walk/unlock', null, WRONG_PASSWORD));
      return;
    }
    res.setHeader('Set-Cookie', await unlockCookieHeader(active.id));
  }
  res.redirect('/walk');
}));

router.get('/t/:id/link', wrap(async (req, res) => {
  const code = String(req.params.id).toLowerCase();
  if (!(await hasSession(req))) {
    res.status(403).send(unknownTagPage(code));
    return;
  }
  if (!isTagCode(code)) {
    res.status(400).send(unknownTagPage(code));
    return;
  }
  res.send(await linkPage(code, await getCheckpoint(code)));
}));

router.post('/t/:id/link', wrap(async (req, res) => {
  const code = String(req.params.id).toLowerCase();
  if (!(await hasSession(req))) {
    res.status(403).send(unknownTagPage(code));
    return;
  }
  if (!isTagCode(code)) {
    res.status(400).send(unknownTagPage(code));
    return;
  }
  const target = await getCheckpoint(String(req.body.checkpoint_id || ''));
  if (!target || target.placeholder) {
    res
      .status(400)
      .send(await linkPage(code, await getCheckpoint(code), 'აირჩიეთ წერტილი სიიდან. / Choose a checkpoint from the list.'));
    return;
  }

  const linked = await linkTag(code, target.id);
  const linkedNote = `<p style="text-align:center"><span class="pill ok">${icon('check')}ტეგი დაკავშირდა · Tag linked</span></p>`;

  // Linking during a live round also counts as this checkpoint's scan.
  const active = await getActiveWalkthrough();
  if (active && linked.active) {
    await recordScan(active.id, linked.id);
    res.send(page(`✓ ${linked.name}`, linkedNote + (await progressView(active, linked)), { lang: 'ka' }));
    return;
  }

  const all = await listLinkCandidates();
  const remaining = all.filter((c) => !c.is_linked);
  res.send(
    page(
      'Tag linked',
      `${messageCard(
         'green',
         'check',
         esc(linked.name),
         `ტეგი დაკავშირდა. შეეხეთ შემდეგ ტეგს. · Tag linked. Tap the next chip. (${all.length - remaining.length} / ${all.length})`
       )}
       ${
         remaining.length
           ? `<div class="card"><h2>დარჩენილია დასაკავშირებლად · Still to link <span class="pill info">${remaining.length}</span></h2>
                <ul class="plain cp-list">${remaining.map((c) => `<li><span class="cp-name">${esc(c.name)}</span><span class="cp-state">${icon('nfc')}</span></li>`).join('')}</ul></div>`
           : `<p style="text-align:center"><span class="pill ok">${icon('check')}ყველა ტეგი დაკავშირებულია! · All chips linked!</span></p>`
       }`,
      { lang: 'ka' }
    )
  );
}));

router.post('/walkthrough/start', wrap(requireDevice), wrap(async (req, res) => {
  const checkpointId = req.body.checkpoint_id;
  if ((await passwordSet()) && !(await hasSession(req)) && !(await checkPassword(req.body.password))) {
    const checkpoint = checkpointId ? await getCheckpoint(checkpointId) : null;
    res.status(401).send(checkpoint ? startFromTagPage(checkpoint, true, WRONG_PASSWORD) : noRoundPage(true, WRONG_PASSWORD));
    return;
  }
  const walkthrough = await startWalkthrough((req.body.guard_name || '').trim().slice(0, 80));
  if (await passwordSet()) res.setHeader('Set-Cookie', await unlockCookieHeader(walkthrough.id));
  if (checkpointId && (await getCheckpoint(checkpointId))) {
    await recordScan(walkthrough.id, checkpointId);
    res.redirect(`/t/${encodeURIComponent(checkpointId)}`);
    return;
  }
  res.redirect('/walk');
}));

// Live progress page (also linked from the dashboard).
router.get('/walk', wrap(requireDevice), wrap(async (req, res) => {
  await tick();

  const active = await getActiveWalkthrough();
  if (!active) {
    res.send(noRoundPage(await passwordSet()));
    return;
  }
  if (!(await unlocked(req, active.id))) {
    res.status(401).send(unlockPage('/walk/unlock'));
    return;
  }
  res.send(page('Walkthrough', await progressView(active), { lang: 'ka', refreshSeconds: 15 }));
}));

router.post('/walkthrough/finish', wrap(requireDevice), wrap(async (req, res) => {
  await tick();

  const active = await getActiveWalkthrough();
  if (active && !(await unlocked(req, active.id))) {
    res.status(401).send(unlockPage('/walk/unlock'));
    return;
  }
  if (active) {
    const missing = await getMissingCheckpoints(active.id);
    if (missing.length === 0) {
      await completeWalkthrough(active);
    } else {
      await closeIncomplete(active, 'finished early by guard');
    }
  }
  res.redirect('/walk/done');
}));

// --- device enrollment (opened on the phone via the admin's one-time link) --

function enrollError(title, text) {
  return page(
    title,
    `<div class="card scan-hero">
       <span class="tile pink">${icon('x')}</span>
       <h1>${title}</h1>
       <p class="muted">${text}</p>
     </div>`,
    { lang: 'ka' }
  );
}

router.get('/enroll/:code', wrap(async (req, res) => {
  res.send(
    page(
      'Enroll device',
      `<div class="card scan-hero">
         <span class="tile blue">${icon('phone')}</span>
         ${biTitle('ტელეფონის რეგისტრაცია', 'Enroll this phone')}
         <p class="muted" style="margin:0">ეს ტელეფონი დაემატება ნებადართული მოწყობილობების სიაში. · This phone will be added to the list of allowed devices.</p>
       </div>
       <div class="card">
         <form method="post" action="/enroll">
           <input type="hidden" name="code" value="${esc(req.params.code)}">
           <label for="device_name">მოწყობილობის სახელი · Device name</label>
           <input id="device_name" name="device_name" placeholder="მაგ. დაცვის ტელეფონი 1 / e.g. Guard phone 1">
           ${biButton('რეგისტრაცია', 'Enroll', 'big')}
         </form>
       </div>`,
      { lang: 'ka' }
    )
  );
}));

router.post('/enroll', wrap(async (req, res) => {
  const max = parseInt(await getSetting('max_devices'), 10) || 2;
  if ((await countDevices()) >= max) {
    res.status(403).send(
      enrollError(
        'ლიმიტი ამოწურულია / Device limit reached',
        `დაშვებულია მაქსიმუმ ${max} მოწყობილობა. ჯერ წაშალეთ ერთ-ერთი ადმინ პანელიდან. /
         At most ${max} devices are allowed. Remove one in the admin panel first.`
      )
    );
    return;
  }
  const ok = await consumeEnrollmentCode(String(req.body.code || ''));
  if (!ok) {
    res.status(400).send(
      enrollError(
        'ბმული აღარ მოქმედებს / Link no longer valid',
        `რეგისტრაციის ბმული უკვე გამოყენებულია ან ვადაგასულია. სთხოვეთ ადმინისტრატორს ახალი. /
         The enrollment link was already used or has expired. Ask the administrator for a new one.`
      )
    );
    return;
  }
  const name = (req.body.device_name || '').trim().slice(0, 80);
  const { id, token } = await addDevice(name);
  res.setHeader('Set-Cookie', deviceCookieHeader(id, token));
  res.send(
    page(
      'Enrolled',
      messageCard(
        'green',
        'check',
        'ტელეფონი დარეგისტრირდა',
        `Phone enrolled${name ? ` — ${esc(name)}` : ''}. ახლა ამ ტელეფონით შეგიძლიათ ტეგების სკანირება. · This phone can now scan the tags.`,
        '<a class="btn full big" href="/walk">დაწყება · Open the app</a>'
      ),
      { lang: 'ka' }
    )
  );
}));

router.get('/walk/done', (req, res) => {
  res.send(
    page(
      'Done',
      messageCard(
        'green',
        'checkCircle',
        'შემოვლა დასრულდა',
        'Walkthrough finished. შედეგი ჩაწერილია სისტემაში. · The result has been recorded.',
        '<a class="btn secondary full" href="/walk">უკან · Back</a>'
      ),
      { lang: 'ka' }
    )
  );
});

module.exports = router;
