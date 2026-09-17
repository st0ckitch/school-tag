'use strict';

const express = require('express');
const guardRoutes = require('./src/routes/guard');
const adminRoutes = require('./src/routes/admin');
const { startScheduler } = require('./src/scheduler');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.redirect('/walk'));
app.use(guardRoutes);
app.use(adminRoutes);

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`school-tag listening on http://0.0.0.0:${PORT}`);
    console.log(`Guard page:  /walk    Admin: /admin (default PIN 1234 — change it in Settings!)`);
  });
  startScheduler();
}

module.exports = app;
