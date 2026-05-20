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
const SW_VERSION = '2026-05-19-1';

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
    const tag = data.conversationId || 'skyway-msg';
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
      data: { url, conversationId: data.conversationId || null, kind: data.kind || null },
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

// Lifecycle: take over immediately on first install so the very first push
// after deploy doesn't get dropped while waiting for an old SW to die.
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
