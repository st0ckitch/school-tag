'use strict';

// At startup, tries a TCP connection to the configured SMTP host (and to
// Gmail's, the usual target) so the deploy log and the Settings page say
// whether outgoing SMTP is open from this server. Railway allows it only
// on the Pro plan, and only after a redeploy following the upgrade.

const net = require('node:net');
const { getSetting, setSetting } = require('./db');

function probe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ host, port, ok, ms: Date.now() - started, error: error || '' });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timed out'));
    socket.once('connect', () => done(true));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

async function checkSmtpEgress() {
  const host = ((await getSetting('smtp_host')) || '').trim() || 'smtp.gmail.com';
  const port = parseInt(await getSetting('smtp_port'), 10) || 465;
  const targets = [[host, port]];
  if (host.toLowerCase() !== 'smtp.gmail.com') targets.push(['smtp.gmail.com', 465]);
  const results = [];
  for (const [h, p] of targets) {
    const r = await probe(h, p);
    results.push(r);
    console.log(`[smtp] outgoing check: ${h}:${p} ${r.ok ? `reachable (${r.ms} ms)` : `unreachable — ${r.error}`}`);
  }
  await setSetting('smtp_egress', JSON.stringify({ at: new Date().toISOString(), results }));
  return results;
}

async function lastSmtpEgress() {
  try {
    return JSON.parse((await getSetting('smtp_egress')) || 'null');
  } catch (err) {
    return null;
  }
}

module.exports = { checkSmtpEgress, lastSmtpEgress, probe };
