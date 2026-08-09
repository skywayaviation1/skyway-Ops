// firebase-push.js — client-side push notification setup.
//
// Lifecycle:
//   1. User taps "Enable push" in their profile (or first DM)
//   2. We call enablePush(user) which:
//      - asks the browser for Notification permission
//      - registers /firebase-messaging-sw.js as the service worker
//      - calls FCM getToken() with the VAPID public key
//      - saves the token (and device metadata) to
//        users/{uid}/push-tokens/{token} so api/send-push.js can find it
//   3. When the user is in the app and a message arrives, onMessage fires
//      and we show a soft in-app toast (NOT a browser notification —
//      foreground browsers don't surface those well, and we don't want to
//      double-notify the user who's actively in chat).
//
// Token rotation: FCM tokens can refresh. We re-save on every enable so
// the user-tokens collection always reflects current valid tokens. Stale
// tokens are pruned server-side in send-push.js when they fail dispatch.
//
// VAPID key: set in Vercel as VITE_FIREBASE_VAPID_KEY (PUBLIC; safe to ship
// to the browser — the matching PRIVATE key lives in the FCM server
// dispatch path). We don't fall back to a hardcoded default — push simply
// doesn't activate until the key is configured, with a clear console
// message explaining what's missing.

import { db } from './firebase.js';
import {
  doc, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';

// Cached so we don't repeatedly import the heavy messaging SDK.
let cachedMessaging = null;
let cachedToken = null;
let foregroundUnsub = null;
let foregroundUid = null;
let foregroundHandler = null;

function getVapidKey() {
  // Vite injects VITE_-prefixed env at build time. Empty string when unset
  // so we can give a clean error message rather than a cryptic FCM one.
  return (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_FIREBASE_VAPID_KEY) || '';
}

export function pushSupported() {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('Notification' in window)) return false;
  if (!('PushManager' in window)) return false;
  return true;
}

// iOS Safari only supports web push if the app has been installed to home
// screen (added to home screen → opened from home screen, not from Safari).
// Returns null when undetermined.
export function iosNeedsHomeScreenInstall() {
  if (typeof window === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (!isIos) return false;
  // standalone === true means PWA launched from home screen.
  // Older iOS exposes navigator.standalone; modern uses display-mode: standalone.
  const standalone =
    (typeof navigator.standalone === 'boolean' && navigator.standalone) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return !standalone;
}

export function notificationPermissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

async function getMessagingLazy() {
  if (cachedMessaging) return cachedMessaging;
  const { getMessaging, isSupported } = await import('firebase/messaging');
  const supported = await isSupported().catch(() => false);
  if (!supported) return null;
  const { getApp } = await import('firebase/app');
  cachedMessaging = getMessaging(getApp());
  return cachedMessaging;
}

// Register our FCM SW. Idempotent — if it's already registered with the
// same script, the browser returns the existing registration.
async function registerSw() {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported');
  // Scope: '/' so it gets push for the whole origin.
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  // Wait until activated — getToken needs an active SW.
  if (reg.installing) {
    await new Promise((resolve) => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'activated') resolve();
      });
      // Fallback so we don't hang forever
      setTimeout(resolve, 5000);
    });
  }
  return reg;
}

export async function enablePush(user, opts = {}) {
  if (!user) throw new Error('enablePush: user required');
  const uid = user.uid || user.id;
  if (!uid) throw new Error('enablePush: missing uid');

  if (!pushSupported()) {
    throw new Error('Push notifications are not supported in this browser.');
  }
  if (iosNeedsHomeScreenInstall()) {
    const e = new Error('On iPhone, push requires the app to be added to your Home Screen first. Open in Safari → share → "Add to Home Screen" → open from the home-screen icon.');
    e.code = 'ios-not-installed';
    throw e;
  }

  const vapid = getVapidKey();
  if (!vapid) {
    throw new Error('Push not configured on this deployment (missing VAPID key). Ask an admin to set VITE_FIREBASE_VAPID_KEY.');
  }

  // Permission. Some browsers (Safari) require this to be called in a
  // user-gesture handler; the calling component must invoke enablePush
  // from a click.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    const e = new Error('Notification permission was not granted.');
    e.code = 'permission-denied';
    throw e;
  }

  const reg = await registerSw();
  const messaging = await getMessagingLazy();
  if (!messaging) throw new Error('FCM messaging unsupported on this browser.');

  const { getToken } = await import('firebase/messaging');
  let token;
  try {
    token = await getToken(messaging, {
      vapidKey: vapid,
      serviceWorkerRegistration: reg,
    });
  } catch (err) {
    // FCM throws a generic "auth credential" error when the VAPID key in
    // VITE_FIREBASE_VAPID_KEY doesn't match what's configured in the
    // Firebase Console for this project. Translate to something actionable.
    const msg = String(err && err.message || '');
    const code = err && err.code;
    if (code === 'messaging/token-subscribe-failed' ||
        /authentication credential|OAuth 2 access token|token-subscribe-failed/i.test(msg)) {
      const e = new Error(
        'Push notifications can\'t be enabled because the Firebase project\'s ' +
        'Web Push VAPID key is missing or doesn\'t match. An admin needs to: ' +
        '(1) generate a Web Push key pair in Firebase Console → Project Settings → ' +
        'Cloud Messaging → Web Push certificates, (2) copy the key, (3) set it as ' +
        'VITE_FIREBASE_VAPID_KEY in Vercel env vars, (4) redeploy.'
      );
      e.code = 'vapid-mismatch';
      e.original = err;
      throw e;
    }
    // Some other failure — rethrow with context
    throw err;
  }
  if (!token) throw new Error('FCM did not return a token. (Permission may be blocked at the OS level.)');

  // Save the token. We key by token (not by deviceId) because the same
  // device on the same browser produces a stable token across sessions;
  // re-saving is harmless. We also store a tiny device-info blob so the
  // user can see "iPhone — Safari" in their settings later.
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const platform = guessPlatform(ua);
  await setDoc(
    doc(db, 'users', uid, 'push-tokens', token),
    {
      token,
      uid,
      platform,
      userAgent: ua.slice(0, 200),
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    },
    { merge: true },
  );

  cachedToken = token;
  startForegroundListener(uid, opts.onForegroundMessage);
  return token;
}

export async function disablePush(user, token = null) {
  if (!user) return;
  const uid = user.uid || user.id;
  if (!uid) return;
  const t = token || cachedToken;
  if (foregroundUnsub) { try { foregroundUnsub(); } catch (_) {} foregroundUnsub = null; }
  foregroundUid = null;
  foregroundHandler = null;
  if (t) {
    try { await deleteDoc(doc(db, 'users', uid, 'push-tokens', t)); } catch (_) {}
  }
  cachedToken = null;
}

// When a message arrives while the user has the app open and focused,
// FCM does NOT fire the service worker — it fires this foreground
// callback instead. We DO NOT render a browser notification here (that
// would pull the user out of the chat they're already in). Instead, we
// invoke an optional callback so the host app can render an in-app toast
// or play a tick sound.
function startForegroundListener(uid, onForeground) {
  foregroundUid = uid;
  if (onForeground) foregroundHandler = onForeground;
  if (foregroundUnsub) return;
  (async () => {
    try {
      const messaging = await getMessagingLazy();
      if (!messaging) return;
      const { onMessage } = await import('firebase/messaging');
      foregroundUnsub = onMessage(messaging, (payload) => {
        try {
          const data = payload.data || {};
          if (data.senderUid && data.senderUid === foregroundUid) return; // never notify self
          foregroundHandler && foregroundHandler({
            title: data.title || 'Skyway',
            body: data.body || '',
            url: data.url || '/',
            conversationId: data.conversationId || null,
            kind: data.kind || null,
          });
        } catch (e) {
          console.error('[push] foreground handler:', e);
        }
      });
    } catch (e) {
      console.error('[push] foreground listener setup:', e);
    }
  })();
}

// Restore foreground message handling on every signed-in app boot. The FCM
// token itself remains registered in Firestore; this only reconnects the
// in-app toast path for sessions where PushSettings is never opened.
export function listenForForegroundPush(user, onForeground) {
  const uid = user?.uid || user?.id;
  if (!uid || notificationPermissionState() !== 'granted') return;
  startForegroundListener(uid, onForeground);
}

function guessPlatform(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  return 'web';
}
