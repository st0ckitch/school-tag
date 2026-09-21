'use strict';

// Device enrollment: guard pages can be limited to a fixed number of enrolled
// phones (Settings → require_enrolled_device / max_devices). Each enrolled
// phone holds a long-lived cookie `device=<id>.<token>`; only the token's
// hash is stored server-side. Admin generates one-time enrollment links.

const { getSetting, validateDevice, touchDevice } = require('./db');
const { page } = require('./html');

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function readDeviceCookie(req) {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('device='));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice('device='.length));
  const idx = value.indexOf('.');
  if (idx < 0) return null;
  return { id: value.slice(0, idx), token: value.slice(idx + 1) };
}

function deviceCookieHeader(id, token) {
  return `device=${encodeURIComponent(`${id}.${token}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

async function currentDevice(req) {
  const cookie = readDeviceCookie(req);
  if (!cookie) return null;
  return validateDevice(cookie.id, cookie.token);
}

function unauthorizedPage() {
  return page(
    'Device not authorized',
    `<div class="card" style="text-align:center">
       <div class="big bad">✕</div>
       <h1>მოწყობილობა არ არის ავტორიზებული / Device not authorized</h1>
       <p class="muted">ამ სისტემით სარგებლობა შეუძლია მხოლოდ რეგისტრირებულ ტელეფონებს.
          სთხოვეთ ადმინისტრატორს ამ ტელეფონის დამატება.<br>
          Only enrolled phones can use this system. Ask the administrator to enroll this phone.</p>
     </div>`,
    { lang: 'ka' }
  );
}

// Middleware for guard routes. A no-op until the admin turns enforcement on.
async function requireDevice(req, res, next) {
  if ((await getSetting('require_enrolled_device')) !== '1') return next();
  const device = await currentDevice(req);
  if (!device) {
    res.status(403).send(unauthorizedPage());
    return;
  }
  await touchDevice(device.id);
  next();
}

module.exports = { requireDevice, currentDevice, deviceCookieHeader };
