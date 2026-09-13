// Home-dashboard fleet map + docked data panel.
//
// TrackingMap still owns basemaps and overlays. This panel adds selection,
// a live fleet list, and flight detail next to the map so controllers can
// pick a tail without leaving the operations home screen.

import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Clock, Gauge, Navigation, Plane, Radio,
} from 'lucide-react';
import {
  buildFleetMapScene,
  buildSelectedFlightOverlay,
  formatLastUpdate,
  withSelectedFlightScene,
} from './fleet-tracking.js';
import { formatCountdown, toMillis } from './ops-dashboard-data.js';
import { formatAltitude, formatSpeed } from './tracking-map.js';
import { useFullFlightTrack } from './use-flight-track.js';
import { EmptyState, RouteLine, Spinner, StatusChip, cx } from './ui.jsx';

const TrackingMapLazy = lazy(() => import('./TrackingMap.jsx'));

const SOURCE_LABEL = {
  live: 'Live ADS-B',
  'last-landing': 'Last landing',
  'last-known': 'Last known',
  'active-origin': 'Schedule origin',
  'schedule-arrival': 'Last arrival',
  'next-origin': 'Next origin',
  'home-base': 'Home base',
};

function fmtClock(value) {
  const ms = toMillis(value);
  if (ms == null) return null;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function sourceLabel(source) {
  return SOURCE_LABEL[source] || 'Inferred';
}

export default function FleetTrackingPanel({
  fleetTails = [],
  fleetRows = [],
  positions = {},
  trips = [],
  aircraftByTail = {},
  unlocated = [],
  now = Date.now(),
  positionsReady = false,
  onSelectTrip,
}) {
  const [selectedTail, setSelectedTail] = useState(null);
  const [mobileTab, setMobileTab] = useState('map');

  const managedRows = useMemo(
    () => fleetRows.filter((row) => !row.offFleet),
    [fleetRows],
  );

  useEffect(() => {
    if (selectedTail && managedRows.some((row) => row.tail === selectedTail)) return;
    const airborne = managedRows.find((row) => row.location?.kind === 'airborne');
    const located = managedRows.find((row) => !unlocated.includes(row.tail));
    const next = airborne || located || managedRows[0] || null;
    setSelectedTail(next?.tail || null);
  }, [managedRows, selectedTail, unlocated]);

  const selectedRow = managedRows.find((row) => row.tail === selectedTail) || null;
  const selectedTelemetry = selectedTail ? positions[selectedTail] || null : null;
  const selectedAirborne = selectedTelemetry?.airborne === true
    || selectedRow?.location?.kind === 'airborne';

  const { points: trackPoints, loading: trackLoading } = useFullFlightTrack(
    selectedTail,
    selectedAirborne,
  );

  const baseScene = useMemo(() => buildFleetMapScene({
    fleetTails,
    positions,
    trips,
    aircraftByTail,
    now,
  }), [fleetTails, positions, trips, aircraftByTail, now]);

  const scene = useMemo(() => {
    const overlay = buildSelectedFlightOverlay({
      telemetry: selectedTelemetry,
      trackPoints,
    });
    return withSelectedFlightScene(baseScene, overlay, { selectedTail });
  }, [baseScene, selectedTelemetry, trackPoints, selectedTail]);

  const fitKey = `${selectedTail || 'fleet'}:${selectedAirborne ? 'air' : 'gnd'}:${trackPoints.length >= 2 ? 'trail' : 'pts'}`;
  const focusIds = selectedTail ? [selectedTail] : null;
  const airborneCount = managedRows.filter((row) => row.location?.kind === 'airborne').length;
  const locatedCount = scene.aircraft.length;

  const handleSelect = (tail) => {
    setSelectedTail(tail);
    setMobileTab('map');
  };

  const map = (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner label="Loading fleet map" /></div>}>
      <TrackingMapLazy
        scene={scene}
        selectedId={selectedTail}
        onSelectAircraft={handleSelect}
        fitKey={fitKey}
        focusIds={focusIds}
        basemapDefault="dark"
        showTrailToggle
        compact
        className="h-full w-full"
        overlay={selectedRow ? (
          <SelectedOverlay
            row={selectedRow}
            telemetry={selectedTelemetry}
            trackLoading={trackLoading}
            trackPoints={trackPoints}
            now={now}
          />
        ) : null}
      />
    </Suspense>
  );

  const panel = (
    <FleetDataPanel
      rows={managedRows}
      scene={scene}
      unlocated={unlocated}
      selectedTail={selectedTail}
      selectedRow={selectedRow}
      selectedTelemetry={selectedTelemetry}
      trackPoints={trackPoints}
      trackLoading={trackLoading}
      positionsReady={positionsReady}
      airborneCount={airborneCount}
      locatedCount={locatedCount}
      fleetCount={fleetTails.length}
      now={now}
      onSelect={handleSelect}
      onSelectTrip={onSelectTrip}
    />
  );

  return (
    <div className="flex min-h-0 flex-col xl:flex-row">
      <div className="flex shrink-0 border-b border-edge xl:hidden">
        {[
          { id: 'map', label: 'Map' },
          { id: 'fleet', label: `Fleet ${airborneCount}/${fleetTails.length}` },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMobileTab(tab.id)}
            className={cx(
              'flex-1 border-b-2 py-2 text-2xs font-semibold transition-colors',
              mobileTab === tab.id ? 'border-accent text-accent' : 'border-transparent text-content-muted',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className={cx(
          'relative min-h-[22rem] w-full xl:min-h-[36rem] xl:flex-1',
          mobileTab === 'fleet' ? 'hidden xl:block' : 'block',
        )}
      >
        {map}
      </div>
      <div
        className={cx(
          'w-full border-t border-edge xl:w-[23.5rem] xl:shrink-0 xl:border-l xl:border-t-0',
          mobileTab === 'map' ? 'hidden xl:flex xl:flex-col' : 'flex flex-col',
        )}
      >
        {panel}
      </div>
    </div>
  );
}

function FleetDataPanel({
  rows,
  scene,
  unlocated,
  selectedTail,
  selectedRow,
  selectedTelemetry,
  trackPoints,
  trackLoading,
  positionsReady,
  airborneCount,
  locatedCount,
  fleetCount,
  now,
  onSelect,
  onSelectTrip,
}) {
  return (
    <div className="flex max-h-[32rem] min-h-[22rem] flex-col xl:max-h-[36rem]">
      <div className="shrink-0 border-b border-edge px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-content">Fleet</h3>
          <span className="font-mono text-2xs text-content-subtle">
            {airborneCount} airborne · {locatedCount}/{fleetCount} located
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-area">
        {!positionsReady ? (
          <Spinner label="Loading live positions" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Plane}
            title="No aircraft configured"
            description="Add tails to the managed fleet in Settings to populate live tracking."
          />
        ) : (
          rows.map((row) => (
            <FleetPanelRow
              key={row.tail}
              row={row}
              marker={scene.aircraft.find((item) => item.id === row.tail)}
              missing={!scene.aircraft.some((item) => item.id === row.tail) || unlocated.includes(row.tail)}
              selected={row.tail === selectedTail}
              now={now}
              onSelect={() => onSelect(row.tail)}
            />
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-edge bg-surface-sunken">
        <FlightDetail
          row={selectedRow}
          telemetry={selectedTelemetry}
          marker={scene.aircraft.find((item) => item.id === selectedTail)}
          missing={selectedTail ? unlocated.includes(selectedTail) : false}
          trackPoints={trackPoints}
          trackLoading={trackLoading}
          now={now}
          onSelectTrip={onSelectTrip}
        />
      </div>
    </div>
  );
}

function FleetPanelRow({ row, marker, missing, selected, now, onSelect }) {
  const airborne = row.location?.kind === 'airborne';
  const grounded = row.state?.id === 'AOG';
  const last = formatLastUpdate(marker?.positionAt || row.position?.polledAt, now);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'flex w-full gap-3 border-b border-edge px-3 py-2.5 text-left transition-colors last:border-b-0',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-raised',
        selected && 'border-l-2 border-l-accent',
      )}
    >
      <span
        className={cx(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          grounded ? 'bg-danger' : airborne ? 'bg-accent' : missing ? 'bg-content-subtle' : 'bg-content-muted',
          airborne && 'animate-pulse',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-content">{row.tail}</span>
          <StatusChip tone={row.state.tone} size="sm">{row.state.label}</StatusChip>
        </span>
        <span className="mt-1 block truncate font-mono text-2xs text-content-muted">
          {missing
            ? 'No known position'
            : airborne
              ? row.location.label
              : `On ground ${row.location.label}`}
        </span>
        <span className="mt-0.5 block truncate text-2xs text-content-subtle">
          {airborne
            ? [
              row.location.altitude != null ? formatAltitude(row.location.altitude) : null,
              row.location.groundspeed != null ? formatSpeed(row.location.groundspeed) : null,
              last,
            ].filter(Boolean).join(' · ')
            : [row.type || 'Type not set', last].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  );
}

function FlightDetail({
  row,
  telemetry,
  marker,
  missing,
  trackPoints,
  trackLoading,
  now,
  onSelectTrip,
}) {
  if (!row) {
    return (
      <div className="px-3 py-4 text-2xs text-content-subtle">
        Select an aircraft to see live flight detail.
      </div>
    );
  }

  const airborne = row.location?.kind === 'airborne';
  const origin = telemetry?.origin || row.activeLeg?.info?.from || row.location?.label;
  const dest = airborne
    ? (telemetry?.destination || row.activeLeg?.info?.to)
    : (telemetry?.groundedAt || row.location?.label);
  const eta = airborne ? (telemetry?.estimatedOn || row.location?.eta) : null;
  const progress = Number.isFinite(telemetry?.progressPercent)
    ? telemetry.progressPercent
    : row.location?.progress;
  const last = formatLastUpdate(marker?.positionAt || telemetry?.polledAt, now);
  const heading = Number.isFinite(telemetry?.heading) ? `${Math.round(telemetry.heading)}°` : null;
  const trip = row.activeLeg || row.nextLeg;

  return (
    <div className="px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-content">{row.tail}</p>
          <p className="mt-0.5 truncate text-2xs text-content-subtle">
            {row.type || 'Type not set'}
          </p>
        </div>
        <StatusChip tone={row.state.tone} size="sm">{row.state.label}</StatusChip>
      </div>

      {missing ? (
        <p className="mt-3 text-2xs text-content-muted">
          No known coordinates. Add a home base in Settings or wait for the next FlightAware position.
        </p>
      ) : (
        <>
          {(origin || dest) && (
            <div className="mt-3">
              <RouteLine from={origin} to={dest} size="sm" />
            </div>
          )}

          {Number.isFinite(progress) && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-content-subtle">
                <span>Progress</span>
                <span className="text-content">{Math.round(progress)}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-surface-raised">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <DetailStat icon={Gauge} label="Altitude" value={airborne ? (formatAltitude(telemetry?.altitude ?? row.location?.altitude) || '—') : 'On ground'} />
            <DetailStat icon={Navigation} label="Speed" value={airborne ? (formatSpeed(telemetry?.groundspeed ?? row.location?.groundspeed) || '—') : '—'} />
            <DetailStat icon={Radio} label="Heading" value={heading || '—'} />
            <DetailStat
              icon={Clock}
              label={eta ? 'ETA' : 'Updated'}
              value={eta ? `${fmtClock(eta) || '—'}${toMillis(eta) ? ` · ${formatCountdown(toMillis(eta) - now)}` : ''}` : (last || '—')}
            />
          </div>

          <div className="mt-3 space-y-1 font-mono text-[10px] text-content-subtle">
            <p>
              Source <span className="text-content">{sourceLabel(marker?.positionSource)}</span>
              {last && eta ? <span> · {last}</span> : null}
            </p>
            <p>
              Trail{' '}
              <span className="text-content">
                {trackLoading && trackPoints.length === 0
                  ? 'loading…'
                  : trackPoints.length >= 2
                    ? `${trackPoints.length} samples`
                    : 'not yet reported'}
              </span>
            </p>
          </div>
        </>
      )}

      {trip ? (
        <button
          type="button"
          onClick={() => onSelectTrip?.(trip.uid)}
          className="mt-3 flex w-full items-center justify-between rounded-lg border border-edge bg-surface px-2.5 py-2 text-left hover:border-edge-strong"
        >
          <span className="min-w-0">
            <span className="block font-mono text-2xs text-content">
              {trip.info?.from || '???'} → {trip.info?.to || '???'}
            </span>
            <span className="mt-0.5 block text-[10px] text-content-subtle">
              {row.activeLeg ? 'Active leg' : 'Next leg'} · {fmtClock(trip.start) || '—'}
            </span>
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-accent" />
        </button>
      ) : (
        <p className="mt-3 text-2xs text-content-subtle">Nothing scheduled.</p>
      )}
    </div>
  );
}

function DetailStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-edge bg-surface px-2 py-1.5">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-content-subtle">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-xs font-semibold text-content">{value}</p>
    </div>
  );
}

function SelectedOverlay({ row, telemetry, trackLoading, trackPoints, now }) {
  const airborne = row.location?.kind === 'airborne';
  const origin = telemetry?.origin || row.activeLeg?.info?.from;
  const dest = airborne ? (telemetry?.destination || row.activeLeg?.info?.to) : row.location?.label;
  const eta = airborne ? fmtClock(telemetry?.estimatedOn || row.location?.eta) : null;

  return (
    <div className="pointer-events-auto rounded-lg border border-edge bg-surface/92 px-2.5 py-2 shadow-overlay backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-content">{row.tail}</span>
        <StatusChip tone={airborne ? 'accent' : 'neutral'} size="sm">
          {airborne ? 'Airborne' : 'On ground'}
        </StatusChip>
      </div>
      {(origin || dest) && (
        <p className="mt-1 font-mono text-[10px] text-content-muted">
          {origin || '—'} → {dest || '—'}
        </p>
      )}
      {airborne && (
        <p className="mt-1 font-mono text-[10px] text-content-subtle">
          {[
            formatAltitude(telemetry?.altitude ?? row.location?.altitude),
            formatSpeed(telemetry?.groundspeed ?? row.location?.groundspeed),
            eta ? `ETA ${eta}` : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      <p className="mt-1 font-mono text-[10px] text-content-subtle">
        {trackLoading && trackPoints.length === 0
          ? 'Trail loading…'
          : trackPoints.length >= 2
            ? `Trail ${trackPoints.length} pts`
            : formatLastUpdate(telemetry?.polledAt, now) || 'Awaiting track'}
      </p>
    </div>
  );
}
