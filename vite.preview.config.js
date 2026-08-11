// Preview-only Vite config for the marketing/QA harness in preview/.
//
// The application is Microsoft-SSO gated and Firebase-backed, so its screens
// cannot be rendered locally without credentials. Rather than rebuild the UI as
// a mockup, this config swaps ONLY the Firebase data modules for sample-data
// stubs and mounts the real components. `npm run build` never uses this file,
// so nothing here can reach production.

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
  ['./firebase-data.js', stub('firebase-data.js')],
  ['./firebase-maint.js', stub('firebase-ops.js')],
  ['./firebase-aog.js', stub('firebase-ops.js')],
  ['./firebase-duty-v2.js', stub('firebase-ops.js')],
  ['./firebase-pilotdocs.js', stub('firebase-ops.js')],
  ['./firebase-expenses.js', stub('firebase-ops.js')],
  ['./firebase-user-mail.js', stub('firebase-ops.js')],
]);

function previewStubs() {
  return {
    name: 'skyway-preview-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !FIREBASE_STUBS.has(source)) return null;
      const normalized = importer.split(path.sep).join('/');
      if (!normalized.includes('/src/')) return null;
      return FIREBASE_STUBS.get(source);
    },
  };
}

export default defineConfig({
  root: path.join(root, 'preview'),
  plugins: [previewStubs(), react()],
  resolve: { extensions: ['.js', '.jsx', '.json'] },
  publicDir: path.join(root, 'public'),
  server: { port: 4178, host: '127.0.0.1' },
});
