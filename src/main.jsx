import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { ExternalTechPage } from './App.jsx';
import './index.css';

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
      (m.includes('dynamically imported module') && m.includes('failed'))
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

const rootEl = ReactDOM.createRoot(document.getElementById('root'));

if (isExternalTechRoute) {
  const params = new URLSearchParams(window.location.search);
  rootEl.render(
    <React.StrictMode>
      <ExternalTechPage token={params.get('token') || ''} />
    </React.StrictMode>
  );
} else {
  rootEl.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
