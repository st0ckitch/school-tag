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
  finishWalkthrough,
  getSetting,
  countDevices,
  consumeEnrollmentCode,
  addDevice,
} = require('../db');
const { tick, closeIncomplete } = require('../scheduler');
const { requireDevice, deviceCookieHeader } = require('../device');
const { esc, page } = require('../html');

const router = express.Router();

// Express 4 does not catch async handler rejections — route them to next().
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function minutesLeft(walkthrough) {
  return Math.max(0, Math.round((new Date(walkthrough.deadline).getTime() - Date.now()) / 60000));
}

async function progressView(walkthrough, justScanned) {
  const scans = await getScans(walkthrough.id);
  const missing = await getMissingCheckpoints(walkthrough.id);
  const total = scans.length + missing.length;
  const pct = total === 0 ? 100 : Math.round((scans.length / total) * 100);
  const left = minutesLeft(walkthrough);

  const scannedBanner = justScanned
    ? `<div class="card" style="border-color:#16a34a">
         <div class="big ok">✓ ${esc(justScanned.name)}</div>
         <div class="muted">${esc(justScanned.location || '')}</div>
         <div>დაფიქსირდა / Checkpoint recorded</div>
       </div>`
    : '';

  const missingList = missing.length
    ? `<div class="card">
         <h2>დარჩენილია / Remaining (${missing.length})</h2>
         <ul class="plain">
           ${missing
             .map(
               (c) =>
                 `<li><span>${esc(c.name)}${c.location ? ` <span class="muted">— ${esc(c.location)}</span>` : ''}</span><span class="muted">…</span></li>`
             )
             .join('')}
         </ul>
       </div>`
    : `<div class="card">
         <div class="big ok">ყველა წერტილი შემოწმებულია!</div>
         <div>All checkpoints scanned — walkthrough complete.</div>
         <form method="post" action="/walkthrough/finish" style="margin-top:12px">
           <button class="btn full" type="submit">დასრულება / Finish walkthrough</button>
         </form>
       </div>`;

  const finishEarly = missing.length
    ? `<form method="post" action="/walkthrough/finish" class="no-print"
             onsubmit="return confirm('დარჩენილია ${missing.length} წერტილი. ნამდვილად დაასრულებთ? / ${missing.length} checkpoints remain. Really finish?')">
         <button class="btn secondary full" type="submit">ადრე დასრულება / Finish early</button>
       </form>`
    : '';

  return `
    ${scannedBanner}
    <div class="card">
      <h1>შემოვლა მიმდინარეობს / Walkthrough in progress</h1>
      <div class="sub">${walkthrough.guard_name ? `დამცველი / Guard: ${esc(walkthrough.guard_name)} · ` : ''}დარჩენილი დრო / Time left: ${left} წთ/min</div>
      <div class="big">${scans.length} / ${total}</div>
      <div class="progressbar"><div style="width:${pct}%"></div></div>
    </div>
    ${missingList}
    ${finishEarly}
  `;
}

// The URL written on each NFC tag: /t/<checkpoint id>
router.get('/t/:id', wrap(requireDevice), wrap(async (req, res) => {
  await tick();

  const checkpoint = await getCheckpoint(req.params.id);
  if (!checkpoint || !checkpoint.active) {
    res.status(404).send(
      page(
        'Unknown tag',
        `<div class="card"><h1>უცნობი ტეგი / Unknown tag</h1>
         <p>ეს ტეგი სისტემაში არ არის რეგისტრირებული. / This tag is not registered in the system.</p></div>`,
        { lang: 'ka' }
      )
    );
    return;
  }

  const active = await getActiveWalkthrough();
  if (active) {
    await recordScan(active.id, checkpoint.id);
    res.send(page(`✓ ${checkpoint.name}`, await progressView(active, checkpoint), { lang: 'ka' }));
    return;
  }

  // No walkthrough running — offer to start one from this tag.
  res.send(
    page(
      'Start walkthrough',
      `<div class="card">
         <h1>${esc(checkpoint.name)}</h1>
         <div class="sub">${esc(checkpoint.location || '')}</div>
         <p>შემოვლა არ არის დაწყებული. დაიწყეთ ახლა? / No walkthrough is running. Start one now?</p>
         <form method="post" action="/walkthrough/start">
           <input type="hidden" name="checkpoint_id" value="${esc(checkpoint.id)}">
           <label for="guard_name">თქვენი სახელი / Your name</label>
           <input id="guard_name" name="guard_name" placeholder="მაგ. გიორგი / e.g. Giorgi" autocomplete="name">
           <button class="btn full" type="submit">შემოვლის დაწყება / Start walkthrough</button>
         </form>
       </div>`,
      { lang: 'ka' }
    )
  );
}));

router.post('/walkthrough/start', wrap(requireDevice), wrap(async (req, res) => {
  const walkthrough = await startWalkthrough((req.body.guard_name || '').trim().slice(0, 80));
  const checkpointId = req.body.checkpoint_id;
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
    res.send(
      page(
        'No walkthrough',
        `<div class="card">
           <h1>შემოვლა არ მიმდინარეობს / No walkthrough running</h1>
           <p>დაიწყეთ პირველი ტეგის დასკანერებით ან ღილაკით. / Start by scanning the first tag, or with the button below.</p>
           <form method="post" action="/walkthrough/start">
             <label for="guard_name">თქვენი სახელი / Your name</label>
             <input id="guard_name" name="guard_name" placeholder="მაგ. გიორგი / e.g. Giorgi" autocomplete="name">
             <button class="btn full" type="submit">შემოვლის დაწყება / Start walkthrough</button>
           </form>
         </div>`,
        { lang: 'ka' }
      )
    );
    return;
  }
  res.send(page('Walkthrough', await progressView(active), { lang: 'ka', refreshSeconds: 15 }));
}));

router.post('/walkthrough/finish', wrap(requireDevice), wrap(async (req, res) => {
  await tick();

  const active = await getActiveWalkthrough();
  if (active) {
    const missing = await getMissingCheckpoints(active.id);
    if (missing.length === 0) {
      await finishWalkthrough(active.id, 'completed');
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
    `<div class="card" style="text-align:center">
       <div class="big bad">✕</div>
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
      `<div class="card">
         <h1>ტელეფონის რეგისტრაცია / Enroll this phone</h1>
         <p class="muted">ეს ტელეფონი დაემატება ნებადართული მოწყობილობების სიაში.
            This phone will be added to the list of allowed devices.</p>
         <form method="post" action="/enroll">
           <input type="hidden" name="code" value="${esc(req.params.code)}">
           <label for="device_name">მოწყობილობის სახელი / Device name</label>
           <input id="device_name" name="device_name" placeholder="მაგ. დაცვის ტელეფონი 1 / e.g. Guard phone 1">
           <button class="btn full" type="submit">რეგისტრაცია / Enroll</button>
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
      `<div class="card" style="text-align:center">
         <div class="big ok">✓</div>
         <h1>ტელეფონი დარეგისტრირდა / Phone enrolled</h1>
         <p class="muted">${esc(name || '')}</p>
         <p>ახლა ამ ტელეფონით შეგიძლიათ ტეგების სკანირება. /
            This phone can now scan the tags.</p>
         <a class="btn full" href="/walk">დაწყება / Open the app</a>
       </div>`,
      { lang: 'ka' }
    )
  );
}));

router.get('/walk/done', (req, res) => {
  res.send(
    page(
      'Done',
      `<div class="card">
         <div class="big ok">✓</div>
         <h1>შემოვლა დასრულდა / Walkthrough finished</h1>
         <p class="muted">შედეგი ჩაწერილია სისტემაში. / The result has been recorded.</p>
         <a class="btn secondary full" href="/walk">უკან / Back</a>
       </div>`,
      { lang: 'ka' }
    )
  );
});

module.exports = router;
