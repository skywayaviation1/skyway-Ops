// Firebase initialization. Public client config - safe to commit.
import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore';
import { connectAuthEmulator, getAuth, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { DEMO_DATABASE_ID } from './reviewer-account.js';
import { installReviewerNetworkGate, readReviewerDatabaseFlag } from './reviewer-sandbox.js';

// signInWithRedirect sends the browser to `authDomain` to run the sign-in
// helper, then back here. When authDomain is a different origin from the app,
// Safari and other browsers that partition third-party storage block that
// helper's storage access and the redirect returns with no session.
//
// Setting VITE_FIREBASE_AUTH_DOMAIN to the app's own hostname makes the two
// same-origin and fixes it — the /__/auth/ rewrite in vercel.json proxies the
// helper transparently. Left unset, behaviour is unchanged.
// See https://firebase.google.com/docs/auth/web/redirect-best-practices
export const AUTH_DOMAIN = String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '').trim()
  || 'skyway-ops-app.firebaseapp.com';

const firebaseConfig = {
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: AUTH_DOMAIN,
  projectId: 'skyway-ops-app',
  storageBucket: 'skyway-ops-app.firebasestorage.app',
  messagingSenderId: '12464871520',
  appId: '1:12464871520:web:d637a1d986c09df5d2cb05',
};

const app = initializeApp(firebaseConfig);

// Force long-polling instead of WebChannel streaming.
//
// Why: iOS Safari's Intelligent Tracking Prevention treats firestore.googleapis.com
// as a third-party origin and breaks the streaming WebChannel that Firestore
// uses by default. The SDK auto-detects this and falls back to long-polling
// anyway, but the detection itself throws "access control checks" errors to
// the console and adds 5-10 seconds of failed-handshake delay on every
// reconnect (which on a PWA happens every time the user switches apps and
// comes back).
//
// Setting experimentalForceLongPolling: true skips the auto-detect and uses
// long-polling from the start. Trade-off: very slightly higher latency on
// browsers where the streaming channel would have worked (Chrome desktop,
// Android Chrome). Saves real-world latency + eliminates noisy errors on
// every iPhone our pilots use.
//
// We use the named 'appusers' database, not the default — passed in settings.
// The App Review sandbox uses a second named database so company documents
// are never in the same query scope. `db` is a live binding: the sandbox
// flag is read before React mounts, and a reviewer sign-in reloads once so
// every module observes the demo database.
const FIRESTORE_SETTINGS = {
  experimentalForceLongPolling: true,
  // Disable the auto-detect probe that fires before forceLongPolling kicks
  // in. Without this, the SDK still sends 1-2 WebChannel handshake
  // attempts on connection startup, which throw "access control checks"
  // errors in Safari before falling back to long-polling.
  experimentalAutoDetectLongPolling: false,
  useFetchStreams: false,
};

export const productionDb = initializeFirestore(app, { ...FIRESTORE_SETTINGS }, 'appusers');
export const reviewerDb = initializeFirestore(app, { ...FIRESTORE_SETTINGS }, DEMO_DATABASE_ID);

export let db = readReviewerDatabaseFlag() ? reviewerDb : productionDb;

export function isReviewerDatabaseActive() {
  return db === reviewerDb;
}

export function activateReviewerDatabase(on) {
  db = on ? reviewerDb : productionDb;
  if (on) installReviewerNetworkGate();
}

if (readReviewerDatabaseFlag()) installReviewerNetworkGate();

// A bundled Capacitor app runs on a local WebView origin. Explicit IndexedDB
// persistence keeps the web Firebase session that backs Firestore alive across
// native process restarts. Browser builds retain Firebase's normal defaults.
export const auth = Capacitor.isNativePlatform()
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app);

// Local emulator wiring is development-only. Production builds tree-shake
// this block because import.meta.env.DEV is false.
if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_EMULATOR === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(productionDb, '127.0.0.1', 8080);
  connectFirestoreEmulator(reviewerDb, '127.0.0.1', 8080);
}
