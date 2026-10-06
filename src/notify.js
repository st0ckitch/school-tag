'use strict';

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
async function sendEmail(subject, text) {
  const to = ((await getSetting('notify_email')) || '').trim();
  if (!to) return { ok: false, error: 'recipient email not set' };

  const apiKey = ((await getSetting('mailchimp_api_key')) || '').trim();
  const smtpUser = ((await getSetting('smtp_user')) || '').trim();
  const smtpPass = ((await getSetting('smtp_pass')) || '').trim();

  if (apiKey.startsWith('md-')) return sendViaMandrill(to, apiKey, subject, text);
  if (smtpUser && smtpPass) return sendViaSmtp(to, smtpUser, smtpPass, subject, text);
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

async function sendViaMandrill(to, apiKey, subject, text) {
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
    if (first && first.status === 'rejected') {
      console.error('[notify] mailchimp email rejected:', first.reject_reason);
      return { ok: false, error: `rejected: ${first.reject_reason}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[notify] mailchimp email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendViaSmtp(to, user, pass, subject, text) {
  const host = ((await getSetting('smtp_host')) || '').trim() || 'smtp.gmail.com';
  const port = parseInt(await getSetting('smtp_port'), 10) || 465;
  const from = ((await getSetting('smtp_from')) || '').trim() || user;
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
    });
    await transport.sendMail({ from: `"School Tag" <${from}>`, to, subject, text });
    return { ok: true };
  } catch (err) {
    console.error('[notify] smtp email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Native push to every subscribed phone (installed app / APK). Dead
// subscriptions (uninstalled app, revoked permission) are pruned.
async function sendWebPush(title, message) {
  const subs = await listPushSubscriptions();
  if (subs.length === 0) return { channel: 'webpush', ok: true, sent: 0 };
  const { publicKey, privateKey } = await getVapidKeys();
  const subject = (await getSetting('base_url')) || 'https://github.com/st0ckitch/school-tag';
  const payload = JSON.stringify({ title, body: message, url: '/admin' });
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { vapidDetails: { subject, publicKey, privateKey }, TTL: 3600 }
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await deletePushSubscription(sub.endpoint);
      } else {
        console.error('[notify] webpush delivery failed:', err.statusCode || err.message);
      }
    }
  }
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

module.exports = { sendNotification, sendEmail, getVapidKeys };
