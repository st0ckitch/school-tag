'use strict';

// Service worker: installability, offline page, font/icon caching, and Web
// Push notifications. Guard/admin pages are NEVER cached — recording a scan
// requires the network.

const CACHE = 'school-tag-v2';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/fonts/FiraGO-Regular.woff2',
  '/fonts/FiraGO-SemiBold.woff2',
  '/fonts/FiraGO-Bold.woff2',
  '/fonts/FiraGO-ExtraBold.woff2',
  '/icons/icon-192.png',
  '/icons/admin-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  // Static assets: cache-first (fast + available offline).
  if (url.origin === location.origin && (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/'))) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
            return res;
          })
      )
    );
  }
});

// --- push notifications -----------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'School Tag', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'school-tag-alert',
      data: { url: data.url || '/admin' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(url) && 'focus' in w) return w.focus();
      }
      return clients.openWindow(url);
    })
  );
});
