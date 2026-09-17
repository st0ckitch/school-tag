'use strict';

const express = require('express');
const guardRoutes = require('./src/routes/guard');
const adminRoutes = require('./src/routes/admin');
const { startScheduler, tick } = require('./src/scheduler');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/', (req, res) => res.redirect('/walk'));
app.use(guardRoutes);
app.use(adminRoutes);

app.get('/api/cron/tick', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET not configured' });
  }
  const authorized =
    req.headers.authorization === 'Bearer ' + secret ||
    req.query.secret === secret;
  if (!authorized) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await tick();
  res.json({ ok: true });
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
