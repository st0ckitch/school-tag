'use strict';

const express = require('express');
const path = require('node:path');
const guardRoutes = require('./src/routes/guard');
const adminRoutes = require('./src/routes/admin');
const { startScheduler, tick } = require('./src/scheduler');
const { getVapidKeys } = require('./src/notify');
const { currentDevice } = require('./src/device');
const { getSetting, addPushSubscription } = require('./src/db');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/', (req, res) => res.redirect('/walk'));
app.use(guardRoutes);
app.use(adminRoutes);

app.get('/api/cron/tick', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET not configured' });
  }
  const timingSafe = (candidate) => {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate.padEnd(256).slice(0, 256));
    const b = Buffer.from(secret.padEnd(256).slice(0, 256));
    return candidate.length === secret.length && require('node:crypto').timingSafeEqual(a, b);
  };
  const auth = req.headers.authorization || '';
  const authorized =
    (auth.startsWith('Bearer ') && timingSafe(auth.slice('Bearer '.length))) ||
    timingSafe(req.query.secret);
  if (!authorized) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await tick();
  res.json({ ok: true });
}));

// --- web push ---------------------------------------------------------------

app.get('/push/key', wrap(async (req, res) => {
  const { publicKey } = await getVapidKeys();
  res.json({ key: publicKey });
}));

app.post('/push/subscribe', wrap(async (req, res) => {
  // Same trust rule as scanning: with device enforcement on, only enrolled
  // phones or a logged-in admin browser may receive alert pushes.
  const enforcing = (await getSetting('require_enrolled_device')) === '1';
  if (enforcing && !(await currentDevice(req)) && !(await adminRoutes.hasSession(req))) {
    return res.status(403).json({ error: 'not authorized' });
  }
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const label = String(req.body.label || '').slice(0, 80);
  await addPushSubscription(sub.endpoint, String(sub.keys.p256dh), String(sub.keys.auth), label);
  res.json({ ok: true });
}));

// Digital Asset Links for the Android APK (Trusted Web Activity): filled from
// Settings once the APK's signing fingerprint is known; hides the URL bar.
app.get('/.well-known/assetlinks.json', wrap(async (req, res) => {
  const pkg = ((await getSetting('android_package')) || '').trim();
  const sha256 = ((await getSetting('android_sha256')) || '').trim();
  if (!pkg || !sha256) return res.status(404).json({ error: 'not configured' });
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [sha256] },
    },
  ]);
}));

// Final error handler — Express 4 needs all four args to treat this as one.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type('text/plain').send('Internal server error');
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`school-tag listening on http://0.0.0.0:${PORT}`);
    console.log(`Guard page:  /walk    Admin: /admin (default PIN 1234 — change it in Settings!)`);
  });
  startScheduler();
}

module.exports = app;
