// Preview-only Vite config for the marketing/QA harness in preview/.
//
// The application is Microsoft-SSO gated and Firebase-backed, so its screens
// cannot be rendered locally without credentials. Rather than rebuild the UI as
// a mockup, this config swaps ONLY the Firebase data modules for sample-data
// stubs and mounts the real components. `npm run build` never uses this file,
// so nothing here can reach production.

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(import.meta.dirname);
const stub = (file) => path.join(root, 'preview/stubs', file);

// Modules that talk to Firebase, mapped to their preview stand-in. Matching is
// restricted to importers inside src/ so the harness's own imports are never
// rewritten.
const FIREBASE_STUBS = new Map([
  ['./firebase.js', stub('firebase.js')],
  ['./firebase-auth.js', stub('firebase-auth.js')],
  ['./firebase-data.js', stub('firebase-data.js')],
  ['./firebase-maint.js', stub('firebase-ops.js')],
  ['./firebase-aog.js', stub('firebase-ops.js')],
  ['./firebase-duty-v2.js', stub('firebase-ops.js')],
  ['./firebase-user-mail.js', stub('firebase-ops.js')],
  ['./firebase-pilotdocs.js', stub('firebase-misc.js')],
  ['./firebase-expenses.js', stub('firebase-misc.js')],
  ['./firebase-comms.js', stub('firebase-misc.js')],
  ['./firebase-manifests.js', stub('firebase-misc.js')],
  ['./firebase-mel.js', stub('firebase-misc.js')],
  ['./firebase-mx.js', stub('firebase-misc.js')],
  ['./firebase-quickbooks.js', stub('firebase-misc.js')],
  ['./firebase-reports.js', stub('firebase-misc.js')],
  ['./firebase-service.js', stub('firebase-misc.js')],
  ['./firebase-storage.js', stub('firebase-misc.js')],
  ['./firebase-travel.js', stub('firebase-misc.js')],
  ['./firebase-wallet.js', stub('firebase-misc.js')],
  ['./firebase-push.js', stub('firebase-misc.js')],
]);

// Screens that call the Firestore SDK directly with the `db` handle need the SDK
// itself replaced, otherwise collection(db, ...) throws and the screen never
// finishes rendering.
const SDK_STUBS = new Map([
  ['firebase/firestore', stub('firestore.js')],
]);

// <img src="/api/broker-logo"> is a real request, not window.fetch, so the
// fetch stub never sees it. This preview-only middleware returns the sample
// PNG with an image content type. Production uses api/broker-logo.js.
function previewBrokerLogo() {
  const wordmark = path.join(root, 'preview/fixtures/meridian-wordmark.png');
  const mark = path.join(root, 'preview/fixtures/meridian-mark.png');
  return {
    name: 'preview-broker-logo',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://preview.local');
        if (url.pathname !== '/api/broker-logo') return next();
        const file = url.searchParams.get('shape') === 'square' ? mark : wordmark;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

function previewStubs() {
  return {
    name: 'skyway-preview-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const normalized = importer.split(path.sep).join('/');
      if (!normalized.includes('/src/')) return null;
      if (FIREBASE_STUBS.has(source)) return FIREBASE_STUBS.get(source);
      if (SDK_STUBS.has(source)) return SDK_STUBS.get(source);
      return null;
    },
  };
}

export default defineConfig({
  root: path.join(root, 'preview'),
  plugins: [previewBrokerLogo(), previewStubs(), react()],
  resolve: { extensions: ['.js', '.jsx', '.json'] },
  publicDir: path.join(root, 'public'),
  server: { port: 4178, host: '127.0.0.1' },
});
