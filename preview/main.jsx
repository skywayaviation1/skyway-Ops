// Marketing / QA preview harness.
//
// Mounts the REAL application screens against sample data so captured imagery
// is the genuine interface. Selected with ?surface=<id>. Not part of the app
// bundle: this entry is only used by vite.preview.config.js.

import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import '../src/theme-classy.css';
import { installFetchStub, sampleIcal } from './fetch-stub.js';
import { CONFIG, CURRENT_USER, EXPENSES, PILOT_USER, TRIPS, USERS } from './sample-data.js';

/**
 * The app caches the raw schedule feed in localStorage and replays it on boot.
 * A browser that once loaded the real JetInsight feed would therefore keep
 * showing live customer trips here. Wipe Skyway's keys and seed the fictitious
 * feed so the preview is deterministic regardless of browser state.
 */
function seedFictitiousSchedule() {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('skyway.') || key.startsWith('skyway:') || key.startsWith('skyway-')) {
        window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem(
      'skyway.user.cached:ical',
      JSON.stringify({ text: sampleIcal(), fetchedAt: Date.now() }),
    );
    // Keep the install prompt out of captured imagery.
    window.localStorage.setItem(
      'skyway_pwa_banner_dismissed_until',
      String(Date.now() + 365 * 86_400_000),
    );
  } catch {
    // Private-mode browsers block storage; the fetch stub still serves the feed.
  }
}

seedFictitiousSchedule();
installFetchStub();

const OpsDashboard = lazy(() => import('../src/OpsDashboard.jsx'));
const CharterInbox = lazy(() => import('../src/CharterInbox.jsx'));
const TeamsHub = lazy(() => import('../src/TeamsHub.jsx'));
const QuickBooksWorkspace = lazy(() => import('../src/QuickBooksWorkspace.jsx'));
const App = lazy(() => import('../src/App.jsx'));
const DutyV2 = lazy(() => import('../src/DutyV2.jsx'));
const ExpenseAccounting = lazy(() => import('../src/ExpenseAccounting.jsx'));
const OpsConsole = lazy(() => import('../src/OpsConsole.jsx'));
const FlightBoard = lazy(() => import('../src/FlightBoard.jsx'));
const AdminDutyReport = lazy(() => import('../src/AdminDutyReport.jsx'));
const TripTrackPage = lazy(() => import('../src/TripTrack.jsx'));

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

  // The full application, signed in. ?role= picks whose experience is shown,
  // which is how the pilot phone screens are captured.
  app: {
    label: 'Full application',
    render: () => <App />,
  },

  duty: {
    label: 'Crew duty and rest',
    render: () => (
      <div style={{ overflowY: 'auto', height: '100%' }}>
        <DutyV2 currentUser={PILOT_USER} myTrips={TRIPS} users={USERS} />
      </div>
    ),
  },

  expenses: {
    label: 'Expenses',
    render: () => (
      <div style={{ overflowY: 'auto', height: '100%' }}>
        <ExpenseAccounting expenses={EXPENSES} users={USERS} currentUser={CURRENT_USER} />
      </div>
    ),
  },

  dispatch: {
    label: 'Dispatch flight control',
    render: () => (
      <OpsConsole
        currentUser={CURRENT_USER}
        allTrips={TRIPS}
        users={USERS}
        onOpenTrip={() => {}}
      />
    ),
  },

  board: {
    label: 'Flight board display',
    render: () => <FlightBoard allTrips={TRIPS} />,
  },

  broker: {
    label: 'Broker live tracking link',
    render: () => <TripTrackPage token="preview-token" />,
  },

  dutyreport: {
    label: 'Duty compliance report',
    render: () => (
      <div style={{ overflowY: 'auto', height: '100%' }}>
        <AdminDutyReport currentUser={CURRENT_USER} users={USERS} trips={TRIPS} />
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
