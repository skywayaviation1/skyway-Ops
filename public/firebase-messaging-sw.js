// public/firebase-messaging-sw.js
//
// Firebase Cloud Messaging service worker. Runs in a service worker context
// (no DOM, no React). Lives at /firebase-messaging-sw.js — FCM's web SDK
// looks for this exact filename at the root scope.
//
// What it does:
//   1. Receives push payloads from FCM (when our api/send-push.js dispatches).
//   2. Renders the OS notification with title, body, icon, and a data.url
//      payload that points to the conversation in the app.
//   3. On notification click, focuses an existing app tab if one exists,
//      otherwise opens a new one at the conversation URL.
//
// Privacy posture: per the operator's decision, notification body INCLUDES
// the message text ("Jake: are we still meeting at 3?"). This means a glance
// at a phone on a table can reveal a snippet of any DM. Documented behavior;
// users who want to hide content can use OS-level notification privacy.
//
// VERSION: bump this on any non-trivial change so the SW updates correctly.
const SW_VERSION = '2026-08-03-3';
const OFFLINE_CACHE = `skyway-offline-${SW_VERSION}`;
const OFFLINE_ASSETS = ['/offline.html', '/apple-touch-icon.png', '/manifest.json'];

// Firebase compat builds — required for the FCM service worker. Version
// must roughly match the firebase npm package we import on the client side
// (currently 10.13.2 per package.json). The 'compat' bundle exposes the
// legacy global firebase.* API the messaging SW needs.
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// Public Firebase config — same values as src/firebase.js. Safe to commit;
// these are not secrets (they identify the project for client SDK calls).
firebase.initializeApp({
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: 'skyway-ops-app.firebaseapp.com',
  projectId: 'skyway-ops-app',
  storageBucket: 'skyway-ops-app.firebasestorage.app',
  messagingSenderId: '12464871520',
  appId: '1:12464871520:web:d637a1d986c09df5d2cb05',
});

const messaging = firebase.messaging();

// onBackgroundMessage fires when:
//   - the app is NOT in the foreground (tab closed, app backgrounded, PWA
//     not active), AND
//   - the push payload is a DATA payload (no `notification` field) — see
//     api/send-push.js which sends data-only on purpose so we get to
//     render the notification ourselves with our own click handler.
//
// (If FCM sees a `notification` field it auto-renders WITHOUT calling us,
// and the click-to-open behavior we want doesn't run. That's why send-push
// only emits the `data` field.)
messaging.onBackgroundMessage((payload) => {
  try {
    const data = payload.data || {};
    const title = data.title || 'Skyway';
    const body = data.body || '';
    const tag = data.channelId || data.conversationId || data.tripId || 'skyway-msg';
    const url = data.url || '/';

    // tag: collapses multiple notifications from the same conversation
    //      into a single banner (so 5 rapid messages don't pile up).
    // renotify: still buzz/flash for each new message in that conversation
    //      rather than silently updating in place.
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: {
        url,
        channelId: data.channelId || null,
        conversationId: data.conversationId || null,
        tripId: data.tripId || null,
        kind: data.kind || null,
      },
    });
  } catch (e) {
    // Never throw out of onBackgroundMessage — it would kill the SW.
    console.error('[sw] onBackgroundMessage failed:', e);
  }
});

// On notification click: focus an existing app tab if any are open;
// otherwise open a fresh tab at the conversation URL. The URL is set
// by api/send-push.js so it deep-links into the right conversation.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer a same-origin tab already on our app.
      const origin = (self.registration && self.registration.scope) || '';
      const existing = all.find((c) => c.url && c.url.startsWith(origin));
      if (existing) {
        try { await existing.focus(); } catch (_) {}
        try { existing.postMessage({ type: 'navigate', url: target }); } catch (_) {}
        return;
      }
      try { await self.clients.openWindow(target); } catch (e) { console.error('[sw] openWindow:', e); }
    })()
  );
});

// A navigation fetch handler makes this a complete installable service worker
// (not just a push worker) without caching hashed JS chunks. Navigations stay
// network-first, so a deploy can never strand an iPhone on stale application
// code; only a small static offline page is cached.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (
        (await caches.match('/offline.html'))
        || new Response('Skyway is offline. Reconnect and try again.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      )),
    );
    return;
  }
  // The offline document references its icon. Serve only this tiny allowlist
  // cache-first; every application asset remains network-owned.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});

// Lifecycle: cache only the offline fallback, remove old fallback versions,
// and take over immediately so the first post-install push is not dropped.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(OFFLINE_CACHE);
        // One missing optional asset must never prevent the FCM worker itself
        // from installing. Promise.allSettled makes precache best-effort.
        await Promise.allSettled(OFFLINE_ASSETS.map((asset) => cache.add(asset)));
      } catch (err) {
        console.warn('[sw] offline precache skipped:', err);
      }
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('skyway-offline-') && key !== OFFLINE_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});
