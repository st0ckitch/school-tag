'use strict';

// Notification emails, in Georgian: a designed HTML version (table layout
// and inline styles, so Gmail, Outlook and phone mail apps all render it)
// plus a plain-text version for clients that don't show HTML.

const { esc } = require('./html');

const TZ = process.env.TZ || 'Asia/Tbilisi';
const FONT = "'Noto Sans Georgian','BPG Arial','Segoe UI',Roboto,Arial,sans-serif";
const C = {
  page: '#eef0f7', card: '#ffffff', text: '#0f1324', muted: '#6a7088', line: '#e7e8f0',
  accent: '#6a5af9', ok: '#12813a', okSoft: '#e7f6ec', bad: '#c42b2b', badSoft: '#fdecec',
};

const when = (iso) =>
  iso ? new Date(iso).toLocaleString('ka-GE', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—';
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function duration(startIso, endIso) {
  const min = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
  return min < 60 ? `${min} წთ` : `${Math.floor(min / 60)} სთ ${String(min % 60).padStart(2, '0')} წთ`;
}

const placeText = (name, location) => {
  const loc = String(location || '').trim();
  return loc && loc !== String(name || '').trim() ? `${name} — ${loc}` : String(name || '');
};

// The page around every email: logo header, white card, footer.
function frame({ preheader, title, badge, body, button }) {
  return `<!DOCTYPE html>
<html lang="ka">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};font-family:${FONT};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:0 4px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:40px;height:40px;border-radius:12px;background:${C.accent};background-image:linear-gradient(140deg,#a196ff,#6a5af9);color:#ffffff;font-size:20px;text-align:center;vertical-align:middle;">🛡</td>
          <td style="padding-left:12px;font-family:${FONT};">
            <div style="font-size:16px;font-weight:800;color:${C.text};">School Tag</div>
            <div style="font-size:12px;color:${C.muted};">სკოლის უსაფრთხოების სისტემა</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${C.card};border-radius:20px;padding:28px 24px;border:1px solid ${C.line};">
        ${badge || ''}
        <h1 style="margin:12px 0 6px;font-size:22px;line-height:1.3;color:${C.text};font-family:${FONT};">${esc(title)}</h1>
        ${body}
        ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td style="border-radius:12px;background:${C.accent};">
          <a href="${esc(button.href)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;font-family:${FONT};">${esc(button.label)}</a>
        </td></tr></table>` : ''}
      </td></tr>
      <tr><td style="padding:16px 8px;text-align:center;font-size:12px;color:${C.muted};font-family:${FONT};">
        ეს შეტყობინება ავტომატურად გაიგზავნა School Tag-ის მიერ.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function badgeHtml(ok, text) {
  return `<span style="display:inline-block;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:700;background:${ok ? C.okSoft : C.badSoft};color:${ok ? C.ok : C.bad};">${ok ? '✓' : '⚠'} ${esc(text)}</span>`;
}

function statBox(label, value, ok) {
  return `<td width="50%" valign="top" style="padding:6px;">
    <div style="border-radius:14px;padding:14px 16px;min-height:64px;background:${ok ? C.okSoft : C.badSoft};">
      <div style="font-size:13px;color:${ok ? C.ok : C.bad};font-weight:700;">${esc(label)}</div>
      <div style="font-size:28px;font-weight:800;color:${C.text};line-height:1.2;">${value} <span style="font-size:14px;font-weight:600;color:${C.muted};">წერტილი</span></div>
    </div>
  </td>`;
}

function listHtml(title, rows, ok) {
  const items = rows.length
    ? rows
        .map(
          (r, i) => `<tr>
            <td style="padding:9px 0;border-top:${i ? `1px solid ${C.line}` : '0'};width:26px;color:${ok ? C.ok : C.bad};font-weight:800;font-size:15px;vertical-align:top;">${ok ? '✓' : '✕'}</td>
            <td style="padding:9px 8px 9px 0;border-top:${i ? `1px solid ${C.line}` : '0'};font-size:15px;color:${C.text};">${esc(r.name)}</td>
            <td style="padding:9px 0;border-top:${i ? `1px solid ${C.line}` : '0'};font-size:13px;color:${C.muted};text-align:right;white-space:nowrap;">${r.time ? esc(r.time) : ''}</td>
          </tr>`
        )
        .join('')
    : `<tr><td style="padding:9px 0;font-size:14px;color:${C.muted};">—</td></tr>`;
  return `<h2 style="margin:24px 0 6px;font-size:16px;color:${C.text};font-family:${FONT};">${esc(title)} <span style="color:${C.muted};font-weight:600;">(${rows.length})</span></h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${FONT};">${items}</table>`;
}

function infoRows(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;font-family:${FONT};">
    ${rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) => `<tr>
          <td style="padding:5px 12px 5px 0;font-size:14px;color:${C.muted};width:1%;white-space:nowrap;vertical-align:top;">${esc(k)}</td>
          <td style="padding:5px 0;font-size:14px;color:${C.text};font-weight:600;">${esc(v)}</td>
        </tr>`
      )
      .join('')}
  </table>`;
}

// The email sent when a round ends: completed, finished early, or timed out.
// `scans` come from getScans (with checkpoint_name), `missing` from
// getMissingCheckpoints.
function roundEmail({ walkthrough, scans, missing, endedAt, reason, detailsUrl }) {
  const complete = missing.length === 0;
  const total = scans.length + missing.length;
  const intro = reason === 'time expired' ? 'შემოვლის დრო ამოიწურა.' : 'უსაფრთხოების თანამშრომელმა დაასრულა შემოვლა.';
  const title = complete ? 'შემოვლა დასრულდა' : 'შემოვლა არასრულად დასრულდა';
  const subject = complete
    ? `✅ შემოვლა დასრულდა — დასკანირებულია ${scans.length}/${total}`
    : `⚠️ შემოვლა: არ დასკანირებულა ${missing.length} წერტილი (${scans.length}/${total})`;
  const scannedRows = scans.map((s) => ({ name: placeText(s.checkpoint_name || s.checkpoint_id, s.checkpoint_location), time: clock(s.scanned_at) }));
  const missingRows = missing.map((c) => ({ name: placeText(c.name, c.location) }));
  const info = [
    ['დაცვის თანამშრომელი', walkthrough.guard_name || ''],
    ['დაწყება', when(walkthrough.started_at)],
    ['დასრულება', when(endedAt)],
    ['ხანგრძლივობა', duration(walkthrough.started_at, endedAt)],
  ];

  const html = frame({
    preheader: `დასკანირებულია: ${scans.length} · არ დასკანირებულა: ${missing.length}`,
    title,
    badge: badgeHtml(complete, complete ? 'ყველა წერტილი დასკანირებულია' : `გამოტოვებულია ${missing.length} წერტილი`),
    body: `<p style="margin:0;font-size:15px;line-height:1.6;color:${C.text};">${esc(intro)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px -6px 0;"><tr>
        ${statBox('დასკანირებულია', scans.length, true)}
        ${statBox('არ დასკანირებულა', missing.length, false)}
      </tr></table>
      ${infoRows(info)}
      ${missing.length ? listHtml('არ დასკანირებულა', missingRows, false) : ''}
      ${listHtml('დასკანირებულია', scannedRows, true)}`,
    button: detailsUrl ? { href: detailsUrl, label: 'შემოვლის დეტალები' } : null,
  });

  const text = [
    intro,
    `დასკანირებულია: ${scans.length} წერტილი`,
    `არ დასკანირებულა: ${missing.length} წერტილი`,
    '',
    ...info.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...(missing.length ? ['', 'არ დასკანირებულა:', ...missingRows.map((r) => `✕ ${r.name}`)] : []),
    '',
    'დასკანირებულია:',
    ...(scannedRows.length ? scannedRows.map((r) => `✓ ${r.name} — ${r.time}`) : ['—']),
    ...(detailsUrl ? ['', `დეტალები: ${detailsUrl}`] : []),
  ].join('\n');

  return { subject, text, html };
}

// The "Save & send test email" message from Settings.
function testEmail() {
  const subject = 'School Tag: სატესტო შეტყობინება';
  const text = 'ეს არის სატესტო შეტყობინება School Tag-ის პარამეტრებიდან. თუ ამას კითხულობთ, ელფოსტის შეტყობინებები მუშაობს.';
  const html = frame({
    preheader: 'ელფოსტის შეტყობინებები მუშაობს.',
    title: 'სატესტო შეტყობინება',
    badge: badgeHtml(true, 'ელფოსტა მუშაობს'),
    body: `<p style="margin:0;font-size:15px;line-height:1.6;color:${C.text};">${esc(text)}</p>
      <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:${C.muted};">შემოვლის დასრულებისას აქ მოვა შეჯამება: დასკანირებული და არ დასკანირებული წერტილების სია.</p>`,
  });
  return { subject, text, html };
}

module.exports = { roundEmail, testEmail };
