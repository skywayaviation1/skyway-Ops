// Marketing / QA preview harness.
//
// Mounts the REAL application screens against sample data so captured imagery
// is the genuine interface. Selected with ?surface=<id>. Not part of the app
// bundle: this entry is only used by vite.preview.config.js.

import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import '../src/theme-classy.css';
import { installFetchStub } from './fetch-stub.js';
import { CONFIG, CURRENT_USER, TRIPS, USERS } from './sample-data.js';

installFetchStub();

const OpsDashboard = lazy(() => import('../src/OpsDashboard.jsx'));
const CharterInbox = lazy(() => import('../src/CharterInbox.jsx'));
const TeamsHub = lazy(() => import('../src/TeamsHub.jsx'));
const QuickBooksWorkspace = lazy(() => import('../src/QuickBooksWorkspace.jsx'));

const SURFACES = {
  dashboard: {
    label: 'Operations control dashboard',
    render: () => (
      <OpsDashboard
        currentUser={CURRENT_USER}
        trips={TRIPS}
        users={USERS}
        config={CONFIG}
        onSelectTrip={() => {}}
        onSwitchSection={() => {}}
        onOpenDispatch={() => {}}
      />
    ),
  },
  email: {
    label: 'Shared charter inbox',
    render: () => (
      <CharterInbox currentUser={CURRENT_USER} trips={TRIPS} mailboxMode="shared" />
    ),
  },
  teams: {
    label: 'Microsoft Teams',
    render: () => <TeamsHub currentUser={CURRENT_USER} />,
  },
  accounting: {
    label: 'Invoices & A/R',
    render: () => (
      <div style={{ padding: '20px', overflowY: 'auto', height: '100%' }}>
        <QuickBooksWorkspace view="invoices" />
      </div>
    ),
  },
};

const params = new URLSearchParams(window.location.search);
const surfaceId = params.get('surface') || 'dashboard';
const surface = SURFACES[surfaceId];

function Frame({ children }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--sw-bg)', color: 'var(--sw-text)', overflow: 'hidden',
    }}>
      {children}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));

if (!surface) {
  root.render(
    <Frame>
      <div style={{ padding: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Preview surfaces</h1>
        <ul style={{ marginTop: 12, lineHeight: 1.9 }}>
          {Object.entries(SURFACES).map(([id, s]) => (
            <li key={id}>
              <a href={`?surface=${id}`} style={{ color: 'var(--sw-accent)' }}>{id}</a>
              {' — '}{s.label}
            </li>
          ))}
        </ul>
      </div>
    </Frame>,
  );
} else {
  document.title = `Skyway Ops — ${surface.label}`;
  root.render(
    <Frame>
      <Suspense fallback={<div style={{ padding: 32, opacity: 0.6 }}>Loading {surface.label}…</div>}>
        {surface.render()}
      </Suspense>
    </Frame>,
  );
}
