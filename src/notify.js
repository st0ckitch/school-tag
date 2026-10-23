'use strict';

const { domainToASCII } = require('node:url');
const util = require('node:util');
const webpush = require('web-push');
const { getSetting, setSetting, listPushSubscriptions, deletePushSubscription } = require('./db');

// VAPID keys identify this server to browser push services; generated once
// and stored in the database.
let vapidReady = null;
async function getVapidKeys() {
  vapidReady ??= (async () => {
    let publicKey = await getSetting('vapid_public');
    let privateKey = await getSetting('vapid_private');
    if (!publicKey || !privateKey) {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      await setSetting('vapid_public', publicKey);
      await setSetting('vapid_private', privateKey);
    }
    return { publicKey, privateKey };
  })();
  try {
    return await vapidReady;
  } catch (err) {
    vapidReady = null;
    throw err;
  }
}

// One-off notification email, configured on the admin Settings page.
// Two interchangeable channels:
//  - Mailchimp Transactional (Mandrill): needs an 'md-...' API key. A regular
//    Mailchimp Marketing key (hex + '-usN') cannot send single emails, so it
//    is rejected with an explanation instead of failing mysteriously.
//  - SMTP (e.g. Gmail with an App Password): free, works with any mailbox.
// Each recipient gets their own copy, sent in parallel, so one bad address
// can't stop the others and nobody sees who else was notified.
// The outcome is kept so the Settings page can show what happened last.
// `html` is optional; when given, mail apps show it and `text` is the fallback.
async function sendEmail(subject, text, html) {
  const result = await attemptEmail(subject, text, html);
  try {
    const at = new Date().toISOString();
    const last = { at, subject, ok: result.ok, sent: result.sent || [], error: result.error || '' };
    await setSetting('email_last_result', JSON.stringify(last));
    const entry = { ...last, channel: result.channel || '', recipients: result.details || [] };
    await setSetting('email_log', JSON.stringify([entry, ...(await emailLog())].slice(0, EMAIL_LOG_SIZE)));
  } catch (err) {
    console.error('[email] could not record the result:', err.message);
  }
  return result;
}

// The most recent attempts, newest first, each with every recipient's
// outcome (and, for SMTP, the steps of the conversation with the server).
const EMAIL_LOG_SIZE = 15;
async function emailLog() {
  try {
    const log = JSON.parse((await getSetting('email_log')) || '[]');
    return Array.isArray(log) ? log : [];
  } catch (err) {
    return [];
  }
}

async function lastEmailResult() {
  try {
    return JSON.parse((await getSetting('email_last_result')) || 'null');
  } catch (err) {
    return null;
  }
}

async function attemptEmail(subject, text, html) {
  const { valid: recipients, invalid } = parseRecipients(await getSetting('notify_email'));
  const apiKey = ((await getSetting('mailchimp_api_key')) || '').trim();
  const brevoKey = ((await getSetting('brevo_api_key')) || '').trim();
  const smtpUser = ((await getSetting('smtp_user')) || '').trim();
  const smtpPass = ((await getSetting('smtp_pass')) || '').trim();

  // Diagnostic snapshot (no secrets) — shows up in the host's deploy logs.
  console.log('[email] send requested:', {
    subject,
    to: recipients.length ? recipients.join(', ') : '(empty)',
    ...(invalid.length ? { invalid } : {}),
    mailchimp_key: apiKey ? (apiKey.startsWith('md-') ? 'transactional' : 'marketing-type (unusable)') : '(empty)',
    brevo_key: brevoKey ? `set (${brevoKey.length} chars)` : '(empty)',
    smtp_user: smtpUser || '(empty)',
    smtp_pass: smtpPass ? `set (${smtpPass.length} chars)` : '(empty)',
  });

  if (!recipients.length) {
    if (invalid.length) {
      console.error('[email] aborted: no valid recipient address');
      return { ok: false, error: `not a valid email address: ${invalid.join(', ')}` };
    }
    console.error('[email] aborted: recipient email not set');
    return { ok: false, error: 'recipient email not set' };
  }
  const toAll = (channel, send) => sendToEach(recipients, invalid, send, channel);

  if (apiKey.startsWith('md-')) {
    console.log('[email] channel: Mailchimp Transactional');
    return toAll('Mailchimp Transactional', (to) => sendViaMandrill(to, apiKey, subject, text, html));
  }
  if (brevoKey) {
    if (brevoKey.startsWith('xsmtpsib-')) {
      console.error('[email] aborted: Brevo SMTP key supplied instead of API key');
      return {
        ok: false,
        error:
          "this is a Brevo SMTP key (xsmtpsib-…), which only works over blocked SMTP ports. " +
          "Use an API key instead: Brevo → SMTP & API → 'API Keys' tab → Generate — it starts with 'xkeysib-'.",
      };
    }
    console.log('[email] channel: Brevo (HTTPS)');
    return toAll('Brevo', (to) => sendViaBrevo(to, brevoKey, subject, text, html));
  }
  if (smtpUser && smtpPass) {
    console.log('[email] channel: SMTP');
    return toAll('SMTP', (to) => sendViaSmtp(to, smtpUser, smtpPass, subject, text, html));
  }
  console.error('[email] aborted: no usable channel configured');
  if (apiKey) {
    return {
      ok: false,
      error:
        "the saved Mailchimp key is a Marketing key (…-usN) which cannot send single emails. " +
        "Use a Mailchimp Transactional key (starts with 'md-') or fill in the SMTP fields instead.",
    };
  }
  return { ok: false, error: 'email not configured' };
}

// The notification addresses: one or more, separated by commas, semicolons,
// spaces or new lines. "Name <address>" and "mailto:" as pasted from mail
// apps are understood; repeats (in any letter case) count once.
const LOCAL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeAddress(token) {
  const address = token.replace(/^mailto:/i, '');
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const local = address.slice(0, at);
  const domain = domainToASCII(address.slice(at + 1));
  return LOCAL_RE.test(local) && DOMAIN_RE.test(domain) ? `${local}@${domain}` : null;
}

function parseRecipients(value) {
  const text = String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '') // invisible characters from copy-paste
    .replace(/[^,;<>\n]*<([^<>]*)>/g, ' $1 '); // "Name <address>" → address
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const address = normalizeAddress(token);
    const key = (address || token).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (address) valid.push(address);
    else invalid.push(token);
  }
  return { valid, invalid };
}

// One send per recipient. Succeeds only when every address got its copy;
// otherwise the error says who got it and why the others didn't.
async function sendToEach(recipients, invalid, send, channel) {
  const results = await Promise.all(recipients.map(async (to) => ({ to, ...(await send(to)) })));
  const sent = results.filter((r) => r.ok).map((r) => r.to);
  const failed = results.filter((r) => !r.ok);
  const details = [
    ...results.map((r) => ({ to: r.to, ok: r.ok, error: r.error || '', steps: r.steps || [] })),
    ...invalid.map((a) => ({ to: a, ok: false, error: 'not a valid email address', steps: [] })),
  ];
  const base = { sent, channel, details };
  if (!failed.length && !invalid.length) return { ok: true, ...base };
  // The same failure for everyone is a setup problem, not an address one.
  if (!sent.length && !invalid.length && failed.every((r) => r.error === failed[0].error)) {
    return { ok: false, ...base, error: failed[0].error };
  }
  const problems = [
    ...failed.map((r) => `${r.to} — ${r.error}`),
    ...invalid.map((a) => `${a} — not a valid email address`),
  ];
  return {
    ok: false,
    ...base,
    error: (sent.length ? `sent to ${sent.join(', ')}, but ` : '') + `not sent to ${problems.join('; ')}`,
  };
}

async function sendViaMandrill(to, apiKey, subject, text, html) {
  const from = ((await getSetting('mailchimp_from_email')) || '').trim();
  if (!from) return { ok: false, error: 'from address not set' };

  try {
    const res = await fetch('https://mandrillapp.com/api/1.0/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: apiKey,
        message: {
          from_email: from,
          from_name: 'School Tag',
          to: [{ email: to, type: 'to' }],
          subject,
          text,
          ...(html ? { html } : {}),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || (body && body.status === 'error')) {
      const reason = (body && (body.message || body.name)) || `HTTP ${res.status}`;
      console.error('[notify] mailchimp email failed:', reason);
      return { ok: false, error: reason };
    }
    const first = Array.isArray(body) ? body[0] : null;
    if (first && !['sent', 'queued', 'scheduled'].includes(first.status)) {
      console.error('[notify] mailchimp email not accepted:', first.status, first.reject_reason);
      return { ok: false, error: first.reject_reason ? `${first.status}: ${first.reject_reason}` : String(first.status) };
    }
    console.log('[email] Mailchimp sent OK:', first && first.status);
    return { ok: true };
  } catch (err) {
    console.error('[notify] mailchimp email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Brevo (brevo.com) HTTPS email API — works where hosts block SMTP ports.
async function sendViaBrevo(to, apiKey, subject, text, html) {
  const from = ((await getSetting('brevo_from_email')) || '').trim();
  if (!from) return { ok: false, error: 'Brevo from address not set' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'School Tag', email: from },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = (body && body.message) || `HTTP ${res.status}`;
      console.error('[email] Brevo send FAILED:', { status: res.status, body });
      return { ok: false, error: `Brevo: ${reason}` };
    }
    console.log('[email] Brevo sent OK:', body && body.messageId);
    return { ok: true };
  } catch (err) {
    console.error('[email] Brevo send FAILED:', err.message);
    return { ok: false, error: `Brevo: ${err.message}` };
  }
}

const SMTP_DEADLINE_MS = 10000;
async function sendViaSmtp(to, user, pass, subject, text, html) {
  const host = ((await getSetting('smtp_host')) || '').trim() || 'smtp.gmail.com';
  const port = parseInt(await getSetting('smtp_port'), 10) || 465;
  const from = ((await getSetting('smtp_from')) || '').trim() || user;
  // Each step of the conversation with the server (connect, TLS, login,
  // send), from nodemailer's info-level events — never the password or the
  // raw protocol transcript.
  const started = Date.now();
  const steps = [];
  const step = (message) => {
    const line = `+${((Date.now() - started) / 1000).toFixed(1)}s ${message}`;
    steps.push(line);
    console.log(`[smtp] ${to}: ${line}`);
  };
  const logger = { trace() {}, debug() {} };
  for (const level of ['info', 'warn', 'error', 'fatal']) {
    logger[level] = (entry, message, ...args) => step(util.format(message, ...args));
  }
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
      logger,
    });
    step(`Connecting to ${host}:${port} (${port === 465 ? 'TLS' : 'STARTTLS if offered'}) as ${user}, from ${from}`);
    // nodemailer tries each of the host's addresses in turn, each with its
    // own timeout (Gmail has eight), so cap the whole attempt: the guard's
    // Finish waits for it.
    const deadlineMs = Number(process.env.SMTP_DEADLINE_MS) || SMTP_DEADLINE_MS;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`no answer from the server within ${deadlineMs / 1000} s`);
        err.code = 'ETIMEDOUT';
        err.command = 'CONN';
        reject(err);
      }, deadlineMs);
      timer.unref();
    });
    try {
      await Promise.race([transport.sendMail({ from: `"School Tag" <${from}>`, to, subject, text, ...(html ? { html } : {}) }), deadline]);
    } finally {
      clearTimeout(timer);
    }
    step('Accepted by the server');
    return { ok: true, steps };
  } catch (err) {
    step(`Failed${err.command ? ` at ${err.command}` : ''}: ${[err.code, err.message].filter(Boolean).join(' ')}`);
    console.error('[email] SMTP send FAILED:', {
      message: err.message,
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      response: err.response,
    });
    const detail = err.response ? `${err.message} — server said: ${err.response}` : err.message;
    return { ok: false, error: detail + smtpHint(err, host, port), steps };
  }
}

// What an SMTP failure usually means, in words an admin can act on.
function smtpHint(err, host, port) {
  const onRailway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
  const text = `${err.code || ''} ${err.message || ''}`;
  if (/wrong version number|SSL routines|tls/i.test(text) && !/timeout/i.test(text)) {
    return ' — TLS mismatch: use port 465 (TLS) or 587 (STARTTLS).';
  }
  if (/ETIMEDOUT|ECONNECTION|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ESOCKET|EDNS|timeout/i.test(text)) {
    return onRailway
      ? ` — Railway blocks outgoing SMTP (ports 25, 465, 587, 2525) on its Free, Trial and Hobby plans, so ${host}:${port} can't be reached from here. Use Brevo (it sends over HTTPS), or move the Railway workspace to the Pro plan and redeploy.`
      : ` — ${host}:${port} could not be reached; check the host and port, and that this server may make outgoing SMTP connections.`;
  }
  if (err.code === 'EAUTH') {
    return ' — the server refused the login. For Gmail, use an App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.';
  }
  return '';
}

// Native push to every subscribed phone (installed app / APK). Dead
// subscriptions (uninstalled app, revoked permission) are pruned.
const PUSH_TIMEOUT_MS = 5000;
async function sendWebPush(title, message) {
  const subs = await listPushSubscriptions();
  if (subs.length === 0) return { channel: 'webpush', ok: true, sent: 0 };
  const { publicKey, privateKey } = await getVapidKeys();
  const subject = (await getSetting('base_url')) || 'https://github.com/st0ckitch/school-tag';
  const payload = JSON.stringify({ title, body: message, url: '/admin' });
  let sent = 0;
  // All phones at once, each bounded, so one unresponsive push service
  // can't hold up the others (or the guard's Finish, which waits for this).
  await Promise.all(
    subs.map(async (sub) => {
      try {
        // web-push's own timeout is per socket wait and can add up, so cap
        // the whole delivery as well.
        await Promise.race([
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { vapidDetails: { subject, publicKey, privateKey }, TTL: 3600, timeout: PUSH_TIMEOUT_MS }
          ),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), PUSH_TIMEOUT_MS).unref()),
        ]);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await deletePushSubscription(sub.endpoint);
        } else {
          console.error('[notify] webpush delivery failed:', err.statusCode || err.message);
        }
      }
    })
  );
  return { channel: 'webpush', ok: true, sent };
}

// Sends an alert to the configured device(s).
//
// Two channels, both optional and configured from the admin settings page:
//  - ntfy: guards/administration install the free ntfy app (ntfy.sh) and
//    subscribe to the topic; the server pushes a notification to their phones.
//  - webhook: a generic POST with a JSON body, for hooking into anything else
//    (Slack, Telegram bot relay, an in-house system, ...).
async function sendNotification(title, message, priority = 'high') {
  const results = [];

  try {
    results.push(await sendWebPush(title, message));
  } catch (err) {
    results.push({ channel: 'webpush', ok: false, error: err.message });
  }

  const ntfyTopic = ((await getSetting('ntfy_topic')) || '').trim();
  if (ntfyTopic) {
    try {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`, {
        method: 'POST',
        headers: {
          Title: title,
          Priority: priority,
          Tags: 'rotating_light',
        },
        body: message,
        signal: AbortSignal.timeout(5000),
      });
      results.push({ channel: 'ntfy', ok: res.ok });
    } catch (err) {
      results.push({ channel: 'ntfy', ok: false, error: err.message });
    }
  }

  const webhookUrl = ((await getSetting('webhook_url')) || '').trim();
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message, text: `${title}\n${message}` }),
        signal: AbortSignal.timeout(5000),
      });
      results.push({ channel: 'webhook', ok: res.ok });
    } catch (err) {
      results.push({ channel: 'webhook', ok: false, error: err.message });
    }
  }

  for (const r of results) {
    if (!r.ok) console.error(`[notify] ${r.channel} delivery failed${r.error ? `: ${r.error}` : ''}`);
  }
  return results;
}

module.exports = { sendNotification, sendEmail, lastEmailResult, emailLog, getVapidKeys, parseRecipients };
