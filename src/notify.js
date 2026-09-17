'use strict';

const { getSetting } = require('./db');

// Sends an alert to the configured device(s).
//
// Two channels, both optional and configured from the admin settings page:
//  - ntfy: guards/administration install the free ntfy app (ntfy.sh) and
//    subscribe to the topic; the server pushes a notification to their phones.
//  - webhook: a generic POST with a JSON body, for hooking into anything else
//    (Slack, Telegram bot relay, an in-house system, ...).
async function sendNotification(title, message, priority = 'high') {
  const results = [];

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

module.exports = { sendNotification };
