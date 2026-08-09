import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { ExternalTechPage } from './App.jsx';
import { ServiceTechPage } from './ServiceRequests.jsx';
import TripTrackPage from './TripTrack.jsx';
import './index.css';

// Chromium's install event is one-shot and can fire while Firebase is still
// resolving auth, before the lazy install button exists. Capture it at module
// startup and notify whichever UI is mounted later.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    window.__SKYWAY_INSTALL_PROMPT__ = event;
    window.dispatchEvent(new CustomEvent('skyway:install-prompt'));
  });
  window.addEventListener('appinstalled', () => {
    window.__SKYWAY_INSTALL_PROMPT__ = null;
    window.dispatchEvent(new CustomEvent('skyway:app-installed'));
  });
}

/* ============================================================
   STALE CHUNK RECOVERY
   ------------------------------------------------------------
   After a new deploy, Vercel serves a fresh index.html but the
   previously-built lazy chunks (firebase-aog-*.js, etc.) are
   gone. Any device still running the old index.html - or with a
   cached one - requests a chunk hash that 404s, producing:

     "Importing a module script failed"
     "Failed to fetch dynamically imported module"

   The fix: detect that specific failure globally and do a ONE
   TIME hard reload so the browser pulls the new index.html and
   its matching chunk names. We guard with sessionStorage so we
   never loop (if the reload itself fails, we surface the error
   instead of reloading forever).
   ============================================================ */
(function installChunkErrorRecovery() {
  const RELOAD_FLAG = 'skyway_chunk_reload_ts';
  const RELOAD_WINDOW_MS = 20000; // don't reload more than once per 20s

  function looksLikeStaleChunk(msg) {
    if (!msg) return false;
    const m = String(msg);
    return (
      m.includes('Importing a module script failed') ||
      m.includes('Failed to fetch dynamically imported module') ||
      m.includes('error loading dynamically imported module') ||
      (m.includes('dynamically imported module') && m.includes('failed')) ||
      // Safari / iOS WebKit phrasing when a dynamic import receives the
      // HTML 404 fallback instead of the JS chunk:
      m.includes('is not a valid JavaScript MIME type') ||
      m.includes("Expected a JavaScript module script but the server responded with a MIME type") ||
      (m.includes('MIME type') && m.includes('module'))
    );
  }

  function recover(reason) {
    let last = 0;
    try { last = parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10); } catch (_) {}
    const now = Date.now();
    if (now - last < RELOAD_WINDOW_MS) {
      console.error('[chunk-recovery] stale chunk persisted after reload:', reason);
      return;
    }
    try { sessionStorage.setItem(RELOAD_FLAG, String(now)); } catch (_) {}
    console.warn('[chunk-recovery] stale chunk detected, hard-reloading:', reason);
    const u = new URL(window.location.href);
    u.searchParams.set('_r', String(now));
    window.location.replace(u.toString());
  }

  window.addEventListener('error', (e) => {
    if (looksLikeStaleChunk(e && e.message) || looksLikeStaleChunk(e && e.error && e.error.message)) {
      recover((e && e.message) || (e && e.error && e.error.message));
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e && e.reason && e.reason.message) || (e && e.reason);
    if (looksLikeStaleChunk(msg)) {
      recover(msg);
    }
  });
})();

// PUBLIC EXTERNAL-TECH ROUTE — decided here, before the main app component
// is ever instantiated, so it cannot interfere with the app's React hooks
// and an outside vendor never touches the auth/Firebase flow.
const isExternalTechRoute =
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/aog-tech';

const isServiceTechRoute =
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/service-tech';

// PUBLIC TRIP TRACKING ROUTE — broker-facing live tracking page. Like the
// tech routes above, decided before App ever mounts so an external broker
// never touches the authed app's Firebase flow.
const isTripTrackRoute =
  typeof window !== 'undefined' &&
  (window.location.pathname.replace(/\/+$/, '') === '/trip-track'
   || window.location.pathname.replace(/\/+$/, '') === '/trip-track.html');

/* ============================================================
   PWA SERVICE WORKER REGISTRATION
   ------------------------------------------------------------
   Register the FCM service worker eagerly on page load (not on
   demand when push is enabled) so the app meets PWA install
   criteria. Without an active SW, Chrome/Android won't show the
   "Install app" affordance.

   The SW handles push notifications and navigation fetches. It caches
   only a static offline explanation — never index.html or hashed app
   chunks — so installed iPhones remain update-safe after deploys.

   Failures are swallowed: SW registration shouldn't block app
   startup. The app works fine without it; users just don't get
   the "Install" prompt.
   ============================================================ */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator
    && !isExternalTechRoute && !isServiceTechRoute && !isTripTrackRoute) {
  // Register after the page has finished loading so we don't compete
  // with initial render for the network.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' })
      .catch((err) => {
        // Don't surface to user. SW is non-critical for app function.
        console.warn('[pwa] service worker registration skipped:', err && err.message);
      });
  });

  // When a lock-screen notification focuses an already-open PWA, the service
  // worker cannot navigate React directly. It posts the deep link here. A
  // full same-origin navigation is deliberate: auth state is persisted, and
  // a clean boot lets App.jsx resolve the trip/channel before rendering.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event?.data?.type !== 'navigate' || !event.data.url) return;
    try {
      const target = new URL(event.data.url, window.location.origin);
      if (target.origin === window.location.origin) window.location.assign(target.href);
    } catch (err) {
      console.warn('[pwa] ignored malformed notification URL:', err?.message || err);
    }
  });
}

const rootEl = ReactDOM.createRoot(document.getElementById('root'));

if (isExternalTechRoute) {
  const params = new URLSearchParams(window.location.search);
  rootEl.render(
    <React.StrictMode>
      <ExternalTechPage token={params.get('token') || ''} />
    </React.StrictMode>
  );
} else if (isServiceTechRoute) {
  const params = new URLSearchParams(window.location.search);
  rootEl.render(
    <React.StrictMode>
      <ServiceTechPage token={params.get('token') || ''} />
    </React.StrictMode>
  );
} else if (isTripTrackRoute) {
  const params = new URLSearchParams(window.location.search);
  rootEl.render(
    <React.StrictMode>
      <TripTrackPage token={params.get('token') || ''} />
    </React.StrictMode>
  );
} else {
  rootEl.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
