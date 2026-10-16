// Marketing / QA preview harness.
//
// Mounts the REAL application screens against sample data so captured imagery
// is the genuine interface. Selected with ?surface=<id>. Not part of the app
// bundle: this entry is only used by vite.preview.config.js.

import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import '../src/theme-classy.css';
import { applyBrandAccent } from '../src/brand.js';
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

// Standalone surfaces do not mount App, which is what normally applies the
// tenant's accent, so it is applied here for every surface.
applyBrandAccent(document.documentElement.getAttribute('data-theme') || 'dark');

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
const AirportFboData = lazy(() => import('../src/AirportFboData.jsx'));
const FboDesk = lazy(() => import('../src/FboDesk.jsx'));
const FboLegPanel = lazy(() => import('../src/FboDesk.jsx').then((m) => ({ default: m.FboLegPanel })));
const FboConfirmPage = lazy(() => import('../src/FboConfirmPage.jsx'));

/** Push unfinished legs outside the airborne window so the wall is an all-parked day. */
function parkedBoardTrips(trips) {
  const now = Date.now();
  let bump = 0;
  return trips.map((trip) => {
    const end = new Date(trip.end).getTime();
    if (Number.isFinite(end) && end < now - 50 * 60_000) return trip;
    const start = new Date(trip.start).getTime();
    const dur = Math.max(45 * 60_000, (Number.isFinite(end) ? end : start) - start);
    const startMs = now + (80 + bump * 40) * 60_000;
    bump += 1;
    return { ...trip, start: new Date(startMs), end: new Date(startMs + dur) };
  });
}

/** Extra today's legs so a busy wall shows 15+ flights on one screen. Preview only. */
function busyBoardTrips(trips) {
  const extra = [
    ['N286N', 'BNA', 'CHS', 'K4LMNQ', 'Cade Kaftel', 'Jenelle Szelest', 2],
    ['N551FP', 'OPF', 'FXE', 'Q8WERT', 'Jenelle Szelest', 'Grant Ellis', 1],
    ['N168ZZ', 'MDW', 'TEB', 'H7PLMX', 'Grant Ellis', 'Andre Cole', 3],
    ['N525CR', 'CHS', 'PBI', 'T2NVQA', 'Andre Cole', 'Maxwell Hagberg', 4],
    ['N9021Q', 'IAD', 'BNA', 'C5DKJR', 'Melissa Rippy', 'Dana Whitfield', 2],
    ['N444AM', 'TEB', 'PBI', 'L9QWRT', 'Maxwell Hagberg', 'Timothy Woods', 4],
    ['N651TW', 'DFW', 'APF', 'P2MXKA', 'Melissa Rippy', 'Andre Cole', 3],
    ['N20UF', 'PBI', 'TEB', 'V6HNQD', 'Dana Whitfield', 'Grant Ellis', 6],
    ['N551FP', 'FXE', 'CHS', 'R3TYPL', 'Jenelle Szelest', 'Cade Kaftel', 2],
    ['N168ZZ', 'TEB', 'BNA', 'M4CKWQ', 'Grant Ellis', 'Maxwell Hagberg', 5],
  ];
  return [
    ...trips,
    ...extra.map((item, index) => ({
      uid: `overflow-${index}`,
      start: new Date(Date.now() + (70 + index * 28) * 60_000),
      end: new Date(Date.now() + (150 + index * 28) * 60_000),
      info: {
        tail: item[0],
        from: item[1],
        to: item[2],
        tripCode: item[3],
        pic: item[4],
        sic: item[5],
        pax: item[6],
        legType: 'REVENUE',
        isFlight: true,
        isOps: true,
      },
    })),
  ];
}

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
    render: () => (
      <FlightBoard
        allTrips={
          params.get('boardCase') === 'busy' ? busyBoardTrips(TRIPS)
            : params.get('boardCase') === 'parked' ? parkedBoardTrips(TRIPS)
              : TRIPS
        }
        fleetTails={CONFIG.fleetTails}
        aircraftByTail={CONFIG.aircraftByTail}
        timeZone="America/New_York"
      />
    ),
  },

  broker: {
    label: 'Broker live tracking link',
    render: () => <TripTrackPage token="preview-token" />,
  },

  airport: {
    label: 'Airport, FBO and fuel',
    render: () => <AirportFboData />,
  },

  fbo: {
    label: 'FBO desk',
    render: () => (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <FboDesk currentUser={CURRENT_USER} />
      </div>
    ),
  },

  'fbo-leg': {
    label: 'Trip FBO section',
    render: () => (
      <div style={{ overflowY: 'auto', height: '100%' }}>
        <FboLegPanel
          trip={{
            uid: 'leg-apf-teb',
            start: new Date(Date.now() + 3 * 3600_000),
            end: new Date(Date.now() + 6 * 3600_000),
            info: {
              isFlight: true,
              isOps: true,
              tail: 'N444AM',
              from: 'KAPF',
              to: 'KTEB',
              tripId: 'WEQVQD',
              tripCode: 'WEQVQD',
              pax: 4,
              legType: 'REVENUE',
              fromFbo: 'Signature Aviation',
              toFbo: 'Signature Flight Support',
            },
          }}
          fromFbo="Signature Aviation"
          toFbo="Signature Flight Support"
          currentUser={CURRENT_USER}
        />
      </div>
    ),
  },

  'fbo-confirm': {
    label: 'FBO arrival confirmation',
    render: () => <FboConfirmPage token="preview" />,
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
      height: '100dvh', display: 'flex', flexDirection: 'column',
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
