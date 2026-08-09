import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { harnessApiPlugin } from './api-mock.js';
import { harnessAnchor } from './clock.js';
import { buildDemoICal, buildPositions, trackLogPayload } from './data/schedule.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/* The harness renders the real application from src/ with the Firebase SDK
 * swapped for an in-memory stand-in. Nothing in src/ is modified. */
export default defineConfig({
  root: here,
  publicDir: path.join(repoRoot, 'public'),
  plugins: [
    react(),
    harnessApiPlugin({
      buildIcal: () => buildDemoICal(harnessAnchor()),
      buildPositions: () => buildPositions(harnessAnchor()),
      buildTrackLog: () => trackLogPayload(harnessAnchor()),
    }),
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
    alias: [
      { find: /^firebase\/app$/, replacement: path.join(here, 'mock/app.js') },
      { find: /^firebase\/firestore$/, replacement: path.join(here, 'mock/firestore.js') },
      { find: /^firebase\/auth$/, replacement: path.join(here, 'mock/auth.js') },
      { find: /^firebase\/storage$/, replacement: path.join(here, 'mock/storage.js') },
      { find: /^firebase\/messaging$/, replacement: path.join(here, 'mock/messaging.js') },
    ],
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
