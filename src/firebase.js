// Firebase initialization. Public client config - safe to commit.
import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: 'skyway-ops-app.firebaseapp.com',
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
export const db = initializeFirestore(
  app,
  {
    experimentalForceLongPolling: true,
    // Disable the auto-detect probe that fires before forceLongPolling kicks
    // in. Without this, the SDK still sends 1-2 WebChannel handshake
    // attempts on connection startup, which throw "access control checks"
    // errors in Safari before falling back to long-polling.
    experimentalAutoDetectLongPolling: false,
    useFetchStreams: false,
  },
  'appusers',
);

export const auth = getAuth(app);
