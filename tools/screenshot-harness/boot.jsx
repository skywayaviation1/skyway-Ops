/* Harness entry point.
 *
 * Pins the clock, seeds the in-memory dataset, then mounts the real
 * application. Screens, styling and business logic all come from src/.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

import { installFixedClock } from './clock.js';

installFixedClock();

const params = new URLSearchParams(window.location.search);

/* ?as=crew renders the pilot's own view of the app instead of ops/admin. */
const IDENTITIES = {
  ops: { uid: 'demo-ops-dana', email: 'd.whitfield@flyskyway.com', displayName: 'Dana Whitfield' },
  crew: { uid: 'demo-crew-alvarez', email: 'k.alvarez@flyskyway.com', displayName: 'Ken Alvarez' },
};
window.__harnessIdentity = IDENTITIES[params.get('as') || 'ops'] || IDENTITIES.ops;

async function start() {
  const { seedAll } = await import('./seed.js');
  await seedAll(Date.now());

  const [{ default: App }, { default: TripTrackPage }] = await Promise.all([
    import('../../src/App.jsx'),
    import('../../src/TripTrack.jsx'),
  ]);
  await import('../../src/index.css');

  const root = ReactDOM.createRoot(document.getElementById('root'));
  const view = params.get('view');

  window.__harnessReady = true;

  if (view === 'broker') {
    root.render(<TripTrackPage token="harness-demo-token" />);
    return;
  }
  root.render(<App />);
}

start().catch((err) => {
  console.error('[harness] failed to start', err);
  document.body.innerHTML = `<pre style="color:#f87171;font:13px monospace;padding:24px;white-space:pre-wrap">${
    String(err && err.stack ? err.stack : err)
  }</pre>`;
});
