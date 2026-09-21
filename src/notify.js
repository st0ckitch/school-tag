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

module.exports = { sendNotification, getVapidKeys };
