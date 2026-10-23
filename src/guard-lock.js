'use strict';

// Scan password. When the admin sets one in Settings, starting a round asks
// for it, and the phone that gives it gets a cookie unlocking that round:
// its chip taps, the live round page and Finish then work without asking
// again. Another phone joining the round types it once. An admin session
// always passes. Only a scrypt hash of the password is stored.

const crypto = require('node:crypto');
const { getSetting, setSetting, getCookieSecret } = require('./db');

const SETTING = 'guard_password_hash';
const COOKIE = 'st_round';

async function passwordSet() {
  return Boolean(await getSetting(SETTING));
}

async function setPassword(password) {
  if (!password) {
    await setSetting(SETTING, '');
    return;
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  await setSetting(SETTING, `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`);
}

async function checkPassword(password) {
  const stored = await getSetting(SETTING);
  if (!stored) return true;
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

async function sign(walkthroughId) {
  return crypto.createHmac('sha256', await getCookieSecret()).update(`round:${walkthroughId}`).digest('hex').slice(0, 32);
}

async function unlockCookieHeader(walkthroughId) {
  const value = encodeURIComponent(`${walkthroughId}.${await sign(walkthroughId)}`);
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24}`;
}

function readCookie(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try {
    return decodeURIComponent(raw.slice(COOKIE.length + 1));
  } catch (err) {
    return null;
  }
}

// May this request scan in the given round?
async function unlocked(req, walkthroughId) {
  if (!(await passwordSet())) return true;
  if (await require('./routes/admin').hasSession(req)) return true;
  const value = readCookie(req);
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 0 || value.slice(0, dot) !== walkthroughId) return false;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(await sign(walkthroughId));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { passwordSet, setPassword, checkPassword, unlockCookieHeader, unlocked };
